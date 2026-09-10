# Alchemy-first eRPC on Railway

Ethereum mainnet (`1`), Arbitrum (`42161`), and Base (`8453`), all served by
one Alchemy API key. Pinned to eRPC `0.2.0`.

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
   expose the metrics port **4001** publicly. Start with one eRPC replica and
   scale only after checking Alchemy and Redis capacity.

Clients in the same Railway environment can use
`http://erpc.railway.internal:4000/main/evm/42161` (HTTP, not HTTPS).
External clients use `https://YOUR-DOMAIN/main/evm/42161`.
Aliases `/main/mainnet`, `/main/arbitrum`, and `/main/base` also work.

```sh
curl "https://YOUR-DOMAIN/main/evm/42161" \
  -H "X-ERPC-Secret-Token: $ERPC_AUTH_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

Authentication is required even on the private network. Keep this secret in
backend services, not browser bundles. Browser access needs a separate auth/CORS
strategy. `/healthcheck` remains unauthenticated for manual diagnostics.
Railway does not run an eRPC deployment health check.

## Caching

The config uses a Redis-backed, finality-aware cache so indexer restarts reuse
recent answers rather than immediately calling Alchemy:

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

### Ponder indexer monitoring

Prometheus also scrapes `http://indexer.railway.internal:42069/metrics` every
15 seconds. Before deploying, confirm the indexer's private DNS name and port
in `monitoring/prometheus.yml`. On the indexer service, set `PORT=42069` and
start with:

```bash
pnpm start --schema=$RAILWAY_DEPLOYMENT_ID --views-schema=public --hostname :: --port 42069
```

Keep `DATABASE_SCHEMA=public` for off-chain tables; the CLI flags preserve
Ponder's deployment-specific schema and stable public views. Keep metrics
private. This IaC partial does not manage or create the indexer service.

Redeploy **Prometheus** to load the updated config and bundled
`ponder-alerts.yml`. Verify `up{job="ponder"}` is `1`, then inspect these queries
in Grafana Explore using the existing Prometheus datasource:

```promql
# Seconds behind wall clock, per chain (base, arbitrum, main)
time() - ponder_sync_block_timestamp{job="ponder"}
time() - ponder_indexing_timestamp{job="ponder"}

# Handler backlog relative to fetched blocks
ponder_sync_block_timestamp{job="ponder"} - ponder_indexing_timestamp{job="ponder"}

# RPC errors per second
rate(ponder_rpc_request_error_total{job="ponder"}[5m])
```

Metric names are checked against **Ponder 0.17.10**, not older dashboard names.
`monitoring/ponder-alerts.yml` provides:

- `PonderUnavailable`: failed scrapes for 2 minutes;
- `PonderSyncLag`: synced timestamp over 120 seconds old for 5 minutes;
- `PonderIndexingLag`: indexing over 120 seconds behind sync for 5 minutes.

Lag rules are gated on successful scrapes and realtime sync mode. They do not
fire while RPC sync is historical; handler backlog can still alert during
catch-up after RPC sync reaches realtime. Adjust thresholds to observed load.
These are progress alerts, not notifications based on how often contracts emit
events, and do not automatically restart services.

**Notification delivery is not configured.** Prometheus will expose pending
and firing alerts on its private `/alerts` page and through the `ALERTS` metric.
To receive Telegram/email/etc., configure Alertmanager and its Prometheus
receiver, or create Grafana-managed alert rules using the same expressions and
pending periods, then assign a Grafana contact point. Prometheus rules are not
automatically routed through Grafana contact points. Railway's deployment
healthcheck is not continuous progress monitoring.

Validate config and alert behavior from this repository (replace `docker` with
`podman` if needed; on SELinux, add `--security-opt label=disable` for the
read-only bind mount):

```bash
docker run --rm --network none \
  -v "$PWD/monitoring:/etc/prometheus:ro" -w /etc/prometheus \
  --entrypoint /bin/promtool prom/prometheus:v3.9.1 \
  check config /etc/prometheus/prometheus.yml

docker run --rm --network none \
  -v "$PWD/monitoring:/etc/prometheus:ro" -w /etc/prometheus \
  --entrypoint /bin/promtool prom/prometheus:v3.9.1 \
  test rules ponder-alerts.test.yml
```

## Routing and cost behavior

- Alchemy is the only upstream provider for all three chains. eRPC uses its
  health scoring and circuit breaker, but cannot fail over to another provider.
- Upstream calls time out after 3s; the total request budget is 30s. Tune these
  for your workload; heavy archive/log queries may need longer upstream timeouts.
- Speculative hedging is disabled. Valid empty results and application errors
  such as contract reverts do not necessarily trigger another provider call.
- Alchemy receives every cache miss. If it has an outage or its rate limit is
  reached, uncached requests fail until it recovers.
- eRPC does not impose a local Alchemy rate limit. This avoids rejecting Ponder's
  short `eth_getLogs` bursts with a rigid one-second bucket. Alchemy enforces the
  actual account-level PAYG throughput across all apps and chains.
- Configure spending controls and alerts in Alchemy. If Alchemy returns a real
  capacity limit, uncached requests still fail/retry; then reduce Ponder
  concurrency or `ethGetLogsBlockRange`, or increase the Alchemy account limit.

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

Additional providers can be configured as future Alchemy fallbacks or balanced
primary capacity. Equal multipliers mean performance-based ranking, **not an
equal traffic split**. Lower `overall` to reduce preference for an expensive
provider; higher values increase preference within its tier. Use provider caps
and billing alerts to manage your bill.

## Validate changes

With real variables set (a local `.env` is ignored by Git):

```sh
docker build -f Dockerfile.erpc -t erpc-local .
docker run --rm --env-file .env erpc-local /erpc-server validate /erpc.yaml
```

Validation can make live upstream calls; investigate connectivity/chain warnings
before deployment. Also test an outage in staging before adding a fallback
provider, so you understand the failure behavior.

References: [Railway](https://docs.erpc.cloud/deployment/railway),
[selection](https://docs.erpc.cloud/config/projects/selection-policies),
[providers](https://docs.erpc.cloud/config/projects/providers),
[monitoring](https://docs.erpc.cloud/operation/monitoring),
[failsafe](https://docs.erpc.cloud/config/failsafe).
