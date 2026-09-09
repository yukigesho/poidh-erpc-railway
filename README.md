# Public-first eRPC on Railway

Arbitrum (`42161`), Base (`8453`), and Degen (`666666666`), with public
repository RPCs first and Alchemy as the paid fallback. Pinned to eRPC `0.2.0`.

## Deploy the RPC service

1. Connect this repository to a Railway service named **erpc**. The root
   `railway.toml` selects `Dockerfile.erpc` and `/healthcheck` automatically.
2. Copy the variables from `.env.example` into Railway Variables. Set a strong
   `ERPC_AUTH_SECRET` and one `ALCHEMY_API_KEY`. eRPC generates the correct
   chain-specific Alchemy URL automatically. Also create the private Redis
   service described in [Caching](#caching) and set `REDIS_URL` as a Railway
   variable reference to its `REDIS_URL`. Confirm Degen support in your Alchemy
   dashboard; if unsupported, remove `evm:666666666` from the Alchemy
   provider's `onlyNetworks` list (Degen then remains public-only).
3. Set `PORT=4000`. For external clients, generate a public domain with target
   port **4000**. Do not expose the metrics port **4001** publicly.
4. Set `GOMEMLIMIT` for your service allocation (the example assumes 512 MiB).
   Start with one replica: rate-limit counters are per instance.

Clients in the same Railway environment can use
`http://erpc.railway.internal:4000/main/evm/42161` (HTTP, not HTTPS).
External clients use `https://YOUR-DOMAIN/main/evm/42161`.
Aliases `/main/arbitrum`, `/main/base`, and `/main/degen` also work.

```sh
curl "https://YOUR-DOMAIN/main/evm/42161" \
  -H "X-ERPC-Secret-Token: $ERPC_AUTH_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

Authentication is required even on the private network. Keep this secret in
backend services, not browser bundles. Browser access needs a separate auth/CORS
strategy. `/healthcheck` is intentionally unauthenticated and simple for Railway;
it reports initialization, not a live guarantee that every chain is working.

## Caching

The config uses a Redis-backed, finality-aware cache so indexer restarts reuse
recent answers rather than immediately calling public RPCs or Alchemy:

- finalized and transaction/hash lookups: 24 hours;
- unfinalized data: 15 seconds;
- tip data (`eth_blockNumber`, gas price, fee history): 2 seconds.

Create a Railway Redis service in the **same project/environment**, attach its
persistent volume, and add this variable to the `erpc` service via Railway's
variable-reference UI (do not expose Redis publicly):

```text
REDIS_URL=${{Redis.REDIS_URL}}
```

Replace `Redis` with the actual Railway Redis service name. The Redis URL is a
secret and belongs in Railway Variables (or local `.env`), never in Git. The
cache intentionally has expiry rather than permanent historical retention; set
a Redis memory/eviction policy appropriate for its Railway plan and monitor its
memory use. eRPC cache hits bypass upstream selection and paid rate limits.

## Monitoring: separate Prometheus and Grafana services

`metrics.enabled` exposes metrics; it does **not** deploy a dashboard by itself.
Create these services in the same Railway project/environment:

### Prometheus

- Connect this repository as a second service named **prometheus**.
- Set its Railway Config File path to `/monitoring/railway.toml` (not the root
  config), keeping the build root at the repository root.
- Set `PORT=9090`; attach a persistent volume at `/prometheus`.
- Keep it private: no public domain. The supplied config scrapes
  `http://erpc.railway.internal:4001/metrics` every 15 seconds and retains 7 days.
- If you rename the RPC service, update `monitoring/prometheus.yml`.
- Check volume write permissions for the image's runtime user if startup fails.

### Grafana

- Create a third service from image `grafana/grafana:12.3.3`.
- Set `PORT=3000`, `GF_SERVER_HTTP_ADDR=::`,
  `GF_SECURITY_ADMIN_USER=admin`, and a strong `GF_SECURITY_ADMIN_PASSWORD`.
  Leave anonymous access disabled. The admin password initializes new storage;
  changing it later requires Grafana's password reset procedure.
- Attach a volume at `/var/lib/grafana`; expose only port **3000** through a
  Railway public domain. Set the Railway healthcheck path to `/api/health`.
- In Grafana, add a Prometheus datasource with URL
  `http://prometheus.railway.internal:9090`.
- Import the [eRPC dashboard JSON](https://raw.githubusercontent.com/erpc/erpc/0.2.0/monitoring/grafana/dashboards/erpc.json)
  and select that datasource.
- Verify `up{job="erpc"}` is `1` in Grafana Explore, then send RPC traffic and
  inspect per-upstream request counts, errors, latency, and rate limiting.

These are three separate Railway services (and three resource bills). Railway
config-as-code configures each service; it does not create the other services.

## Routing and cost behavior

- Selection ranks public endpoints first and paid endpoints second. Within each
  tier, eRPC scores providers using live performance. File order is not priority.
- Both tiers remain eligible, so an upstream sweep can reach Alchemy after public
  transport/RPC failures or unsupported methods. A hard `preferTag` exclusion
  would prevent that immediate fallback while public nodes remained selected.
- Upstream calls time out after 3s; the total request budget is 30s. Circuit
  breakers temporarily skip failing upstreams. Many slow public endpoints can
  consume the total timeout before Alchemy is reached: this prioritizes cost,
  not guaranteed low latency. Tune timeouts/catalog size for your workload;
  heavy archive/log queries may need longer upstream timeouts.
- Speculative hedging is disabled. Valid empty results and application errors
  such as contract reverts do not necessarily trigger another provider call.
- Startup discovery/block polling can contact Alchemy even without user fallback
  traffic. Public catalog cold starts or missing public coverage can also route
  directly to Alchemy. This is not a zero-paid-requests-until-outage guarantee.
- The config has fixed **Alchemy Free tier** credit limits: **300 CU/s** and
  **30,000,000 base CUs/month**. They use Alchemy's per-method CU estimates, so
  they are not a request-per-second cap. These limits are shared across all
  three generated Alchemy chains in this eRPC instance. If you use PAYG or
  Enterprise, replace both figures with your account's allowance.
- The in-memory limit store is per eRPC instance. Keep one replica for a true
  300-CU/s cap, or use a shared Redis rate-limit store before scaling out.
  Usage from other Alchemy apps also counts against account-level throughput
  and is not visible to eRPC, so retain Alchemy billing alerts. If either paid
  cap is hit and public RPCs fail, requests fail rather than bypassing it.

## Add providers later

Add a static HTTPS upstream to `projects[0].upstreams` for each supported chain:

```yaml
- id: another-provider-base
  endpoint: "${OTHER_BASE_URL}"
  tags: ["tier:paid", "provider:other"]
  evm:
    chainId: 8453
  rateLimitBudget: other-base
  routing:
    scoreMultipliers:
      - overall: 1.0
```

Create `other-base` under `rateLimiters.budgets` with its own RPS rule, and set
`OTHER_BASE_URL` in Railway. Alternatively use a documented `providers` vendor
with `onlyNetworks` and tagged `overrides`, like the single-key Alchemy entry.

Paid providers compete only after the public tier. Equal multipliers mean
performance-based ranking, **not an equal traffic split**. Lower `overall` to
reduce preference for an expensive provider; higher values increase preference
within its tier. Use provider caps and billing alerts to manage your bill.
Only genuinely free endpoints should have `tier:public`.

## Validate changes

With real variables set (a local `.env` is ignored by Git):

```sh
docker build -f Dockerfile.erpc -t erpc-local .
docker run --rm --env-file .env erpc-local /erpc-server validate /erpc.yaml
```

Validation can make live upstream calls; investigate connectivity/chain warnings
before deployment. Also test an outage in staging to confirm your actual public
catalog and timeout budget reach the paid fallback as expected.

References: [Railway](https://docs.erpc.cloud/deployment/railway),
[selection](https://docs.erpc.cloud/config/projects/selection-policies),
[providers](https://docs.erpc.cloud/config/projects/providers),
[monitoring](https://docs.erpc.cloud/operation/monitoring),
[failsafe](https://docs.erpc.cloud/config/failsafe).
