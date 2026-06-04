# download-proxy

A thin Cloudflare Worker that serves the substrate-kernels R2 bucket at the
public download hostnames and emits one `kernel_download` event per full
download into the analytics events queue.

- **Routes:** `kernels.substrate.so/*` and `kernels.agx.so/*`
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

> **One-time migration (agx rebrand):** the Worker was renamed
> `substrate-kernel-download-proxy` → `substrate-kernels-download-proxy` and
> the first public hostname moved `kernels.substrate.loopholelabs.io` →
> `kernels.substrate.so`. The first deploy under the new name creates a NEW
> Worker; confirm the custom-domain takeover for `kernels.agx.so` when
> wrangler prompts, then delete the old Worker
> (`bunx wrangler delete --name substrate-kernel-download-proxy`). The
> `substrate.so` zone must be active in this account before
> `kernels.substrate.so` can attach, and that host's write key needs an
> analytics-side `AGX_ANALYTICS_KEYS` KV record with
> `source = "WEB:KERNELS.SUBSTRATE.SO"`.

### Prerequisites (one-time per Cloudflare account)

The Worker MUST live in the **same Cloudflare account** as the analytics
`analytics-events` queue — cross-account queue producer bindings are not
supported. That same account already hosts:

- The R2 bucket `substrate-kernels` (release.yml uploads `.kernel` bundles
  + `SHA256SUMS` files here).
- The analytics workers (`analytics-ingest`, `analytics-consumer`) and
  their `analytics-events` + `analytics-events-dlq` queues.

DNS for `kernels.substrate.so` and `kernels.agx.so` is
configured once in the Cloudflare dashboard; `custom_domain = true` in
`wrangler.toml` keeps them attached on subsequent deploys.

### Verify end-to-end after deploy

```bash
# Browseable listing page (the front door).
curl -fsSL https://kernels.substrate.so/ -o /dev/null
curl -sI https://kernels.substrate.so/ | grep -E 'HTTP|content-type|cache-control|etag'

# Direct artifact downloads.
curl -fsSL -o /dev/null https://kernels.substrate.so/linux-6.12.91-base-x86_64.kernel
curl -fsSL -o /dev/null https://kernels.agx.so/linux-6.12.91-base-aarch64.kernel
```

Then in ClickHouse (the analytics destination):

```sql
SELECT received_at, source, anonymous_id, properties.package,
       properties.version, properties.bytes, ip_country, ip_org
FROM events
WHERE source IN ('WEB:KERNELS.SUBSTRATE.SO', 'WEB:KERNELS.AGX.SO')
  AND event_name = 'kernel_download'
  AND received_at >= now() - INTERVAL 10 MINUTE
ORDER BY received_at DESC
LIMIT 10;
```

Two rows, one per hostname, with `source = WEB:<HOST>`,
`package = "linux-base-<arch>"`, `version = "6.12.91"`, `bytes` matching the
file size on disk. The `anonymous_id` is the caller-supplied id when the CLI
sends `X-Substrate-Anonymous-Id` or a browser carries the `substrate_aid`
cookie (set by the listing-page RudderStack SDK), else a fresh UUID — see
[ADR 0012](../docs/adr/0012-listing-page-web-analytics-and-correlation.md).

## Tracking the analytics queue spec

The analytics queue contract lives at
[`analytics/docs/spec/queue-protocol.md`](https://github.com/loopholelabs/analytics/blob/main/docs/spec/queue-protocol.md).
`src/analytics.ts` cites it inline. When that spec changes (a new
required field, a renamed property), update `src/analytics.ts` to match
and adjust `test/integration.test.ts` to assert the new shape. The lack
of a compile-time link to the analytics repo is deliberate — bun 1.3.x
can't authenticate private GitHub git installs, and the spec is the
authoritative contract per analytics ADR 0015.
