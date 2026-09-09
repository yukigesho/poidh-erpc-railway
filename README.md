# Alchemy-first eRPC on Railway

Arbitrum (`42161`) and Base (`8453`), with Alchemy as the primary RPC provider
and public repository RPCs as fallback. Pinned to eRPC `0.2.0`.

## Deploy the RPC service

1. Install Railway CLI `>=5.42.1`, authenticate, and link this directory to
   the target Railway project/environment. Install the IaC dependency with
   `npm ci`.
2. In Railway **Project → Variables**, create sealed environment-level shared
   variables: `ERPC_AUTH_SECRET`, `ALCHEMY_API_KEY`, and
   `GRAFANA_ADMIN_PASSWORD`. IaC references these values without writing them
   to Git. `ERPC_AUTH_SECRET` must be non-empty or eRPC cannot start.
3. **Migration only:** before planning, clear the existing service's Railway
   **Config File path** setting. The deprecated `railway.toml` files have been
   removed from this repository. Do not let Config as Code and IaC manage the
   same service. For a larger existing project, run `railway config pull` first
   and merge its imported settings before applying.
4. Preview with `railway config plan`, carefully review it, then run
   `railway config apply`. This is a named `erpc-monitoring` IaC partial: it
   creates and manages only eRPC, Redis, Prometheus, Grafana, and their data
   volumes; unrelated project resources are not managed or deleted.
5. Add a public domain in Railway for eRPC with target port **4000**. Do not
   expose the metrics port **4001** publicly. Start with one eRPC replica:
   rate-limit counters are per instance.

Clients in the same Railway environment can use
`http://erpc.railway.internal:4000/main/evm/42161` (HTTP, not HTTPS).
External clients use `https://YOUR-DOMAIN/main/evm/42161`.
Aliases `/main/arbitrum` and `/main/base` also work.

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

The IaC file creates a private Railway Redis service, its persistent storage,
and the `REDIS_URL` reference for eRPC. Do not expose Redis publicly. The cache
intentionally has expiry rather than permanent historical retention; monitor
its memory use. eRPC cache hits bypass upstream selection and paid rate limits.

## Monitoring: separate Prometheus and Grafana services

`metrics.enabled` exposes metrics. IaC creates the private Prometheus service
with a persistent volume; it scrapes `erpc.railway.internal:4001` every 15
seconds and retains seven days. If you rename the eRPC service, update
`monitoring/prometheus.yml` and `.railway/railway.ts`.

IaC also creates Grafana (`grafana/grafana:12.3.3`) with persistent storage.
Add a Railway public domain targeting port **3000** only after setting the
shared `GRAFANA_ADMIN_PASSWORD`; leave anonymous access disabled. The password
initializes new storage, so changing it later requires Grafana's password reset
procedure.

- In Grafana, add a Prometheus datasource with URL
  `http://prometheus.railway.internal:9090`.
- Import the [eRPC dashboard JSON](https://raw.githubusercontent.com/erpc/erpc/0.2.0/monitoring/grafana/dashboards/erpc.json)
  and select that datasource.
- Verify `up{job="erpc"}` is `1` in Grafana Explore, then send RPC traffic and
  inspect per-upstream request counts, errors, latency, and rate limiting.

This creates four Railway services/resources (eRPC, Redis, Prometheus, and
Grafana) and associated storage, each with its own Railway cost.

## Routing and cost behavior

- Selection ranks Alchemy first and public endpoints second. Within each tier,
  eRPC scores providers using live performance. File order is not priority.
- Both tiers remain eligible, so an upstream sweep can reach public RPCs after
  Alchemy transport/RPC failures, circuit-breaker trips, or rate-limit rejection.
  A hard `preferTag` exclusion would prevent that immediate fallback while
  Alchemy remained selected.
- Upstream calls time out after 3s; the total request budget is 30s. Circuit
  breakers temporarily skip failing upstreams. Tune timeouts/catalog size for
  your workload; heavy archive/log queries may need longer upstream timeouts.
- Speculative hedging is disabled. Valid empty results and application errors
  such as contract reverts do not necessarily trigger another provider call.
- Alchemy normally receives all cache misses. Public fallbacks can be unreliable
  or lack archive/method support, so they are an availability fallback rather
  than a guaranteed equivalent service.
- The config has fixed **Alchemy Free tier** credit limits: **300 CU/s** and
  **30,000,000 base CUs/month**. They use Alchemy's per-method CU estimates, so
  they are not a request-per-second cap. These limits are shared across all
  both generated Alchemy chains in this eRPC instance. If you use PAYG or
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
  tags: ["tier:primary", "provider:other"]
  evm:
    chainId: 8453
  rateLimitBudget: other-base
  routing:
    scoreMultipliers:
      - overall: 1.0
```

Create `other-base` under `rateLimiters.budgets` with its own rate-limit rule,
and set `OTHER_BASE_URL` in Railway. Alternatively use a documented `providers`
vendor with `onlyNetworks` and tagged `overrides`, like the single-key Alchemy
entry.

Additional primary providers compete with Alchemy before the public fallback.
Equal multipliers mean performance-based ranking, **not an equal traffic split**.
Lower `overall` to reduce preference for an expensive provider; higher values
increase preference within its tier. Use provider caps and billing alerts to
manage your bill.
Only public fallback endpoints should have `tier:fallback`; Alchemy and any
additional paid primary provider should use `tier:primary`.

## Validate changes

With real variables set (a local `.env` is ignored by Git):

```sh
docker build -f Dockerfile.erpc -t erpc-local .
docker run --rm --env-file .env erpc-local /erpc-server validate /erpc.yaml
```

Validation can make live upstream calls; investigate connectivity/chain warnings
before deployment. Also test an outage in staging to confirm your actual public
catalog and timeout budget reach the public fallback as expected.

References: [Railway](https://docs.erpc.cloud/deployment/railway),
[selection](https://docs.erpc.cloud/config/projects/selection-policies),
[providers](https://docs.erpc.cloud/config/projects/providers),
[monitoring](https://docs.erpc.cloud/operation/monitoring),
[failsafe](https://docs.erpc.cloud/config/failsafe).
