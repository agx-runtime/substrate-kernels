# download-proxy

A thin Cloudflare Worker that serves the substrate-kernels R2 bucket at the
public download hostnames and emits one `kernel_download` event per full
download into the analytics events queue.

- **Routes:** `kernels.substrate.loopholelabs.io/*` and `kernels.agx.so/*`
  (both `custom_domain = true`).
- **Origin:** R2 binding (`KERNELS` → bucket `substrate-kernels`), not S3.
  No SigV4 in the Worker, no egress fees inside the CF network.
- **Analytics:** emits a `kernel_download` event per full GET via
  [`src/analytics.ts`](src/analytics.ts) — hand-rolled per the
  [analytics queue protocol spec](https://github.com/loopholelabs/analytics/blob/main/docs/spec/queue-protocol.md)
  (analytics ADR 0015's first-class "hand-roll" path). The producer is
  ~50 lines, self-contained, with no cross-repo install dependency.
- **`/` lists everything in the bucket** — a SSR'd browseable page
  ([`src/html.ts`](src/html.ts) + [`src/listing.ts`](src/listing.ts))
  styled to match the substrate-bench dashboard. 5-minute edge cache,
  per-row SHA256SUMS link, no analytics emit. See
  [`../docs/design/download-proxy.md`](../docs/design/download-proxy.md)
  "Listing page" for the design.

Authoritative design: [`../docs/design/download-proxy.md`](../docs/design/download-proxy.md).
Authoritative decision: [`../docs/adr/0011-download-proxy-with-analytics.md`](../docs/adr/0011-download-proxy-with-analytics.md).

---

## Develop

```bash
cd download-proxy
bun install
bun test            # router unit + integration (real R2 binding, stubbed queue)
bun run typecheck   # tsc --noEmit
bun run dev         # wrangler dev (local)
```

The test suite uses `@cloudflare/vitest-pool-workers` — real workerd
isolates plus a real miniflare R2 binding. The integration test stubs
`env.EVENTS_QUEUE` per-test so it can directly assert what `recordDownload`
sent without spinning up a consumer.

## Deploy

Manual, per [ADR 0011](../docs/adr/0011-download-proxy-with-analytics.md).

```bash
cd download-proxy
bun install
bunx wrangler deploy
```

### Prerequisites (one-time per Cloudflare account)

The Worker MUST live in the **same Cloudflare account** as the analytics
`analytics-events` queue — cross-account queue producer bindings are not
supported. That same account already hosts:

- The R2 bucket `substrate-kernels` (release.yml uploads `.kernel` bundles
  + `SHA256SUMS` files here).
- The analytics workers (`analytics-ingest`, `analytics-consumer`) and
  their `analytics-events` + `analytics-events-dlq` queues.

DNS for `kernels.substrate.loopholelabs.io` and `kernels.agx.so` is
configured once in the Cloudflare dashboard; `custom_domain = true` in
`wrangler.toml` keeps them attached on subsequent deploys.

### Verify end-to-end after deploy

```bash
# Browseable listing page (the front door).
curl -fsSL https://kernels.substrate.loopholelabs.io/ -o /dev/null
curl -sI https://kernels.substrate.loopholelabs.io/ | grep -E 'HTTP|content-type|cache-control|etag'

# Direct artifact downloads.
curl -fsSL -o /dev/null https://kernels.substrate.loopholelabs.io/linux-6.12.91-base-x86_64.kernel
curl -fsSL -o /dev/null https://kernels.agx.so/linux-6.12.91-base-aarch64.kernel
```

Then in ClickHouse (the analytics destination):

```sql
SELECT received_at, properties.package, properties.version,
       properties.bytes, ip_country, ip_org
FROM events
WHERE source = 'kernel_download_proxy'
  AND event_name = 'kernel_download'
  AND received_at >= now() - INTERVAL 10 MINUTE
ORDER BY received_at DESC
LIMIT 10;
```

Two rows, one per hostname, with `package = "linux-base-<arch>"`,
`version = "6.12.91"`, `bytes` matching the file size on disk.

## Tracking the analytics queue spec

The analytics queue contract lives at
[`analytics/docs/spec/queue-protocol.md`](https://github.com/loopholelabs/analytics/blob/main/docs/spec/queue-protocol.md).
`src/analytics.ts` cites it inline. When that spec changes (a new
required field, a renamed property), update `src/analytics.ts` to match
and adjust `test/integration.test.ts` to assert the new shape. The lack
of a compile-time link to the analytics repo is deliberate — bun 1.3.x
can't authenticate private GitHub git installs, and the spec is the
authoritative contract per analytics ADR 0015.
