# Design: the download proxy

A thin Cloudflare Worker that proxies the substrate-kernels R2 bucket at
the public download hostnames and emits one `kernel_download` analytics
event per full download
([ADR 0011](../adr/0011-download-proxy-with-analytics.md)). Self-contained
under [`../../download-proxy/`](../../download-proxy/); the source for
every claim below.

## Background

`release.yml` publishes `linux-<version>-<variant>-<arch>.kernel` bundles
and a per-version `SHA256SUMS` to the `substrate-kernels` R2 bucket, which
the README documents as served at `kernels.substrate.loopholelabs.io` and
`kernels.agx.so` ([../../README.md](../../README.md) §Releases). The proxy
sits between those hostnames and the bucket: reads R2 via binding, writes
one event per full download into the analytics events queue
([ADR 0011](../adr/0011-download-proxy-with-analytics.md)). The analytics
queue contract is
[`analytics/docs/spec/queue-protocol.md`](https://github.com/loopholelabs/analytics/blob/main/docs/spec/queue-protocol.md);
the producer is hand-rolled per that spec in
[`../../download-proxy/src/analytics.ts`](../../download-proxy/src/analytics.ts)
— ~50 lines, no cross-repo install dependency
([ADR 0011 §Decision/4](../adr/0011-download-proxy-with-analytics.md)).

## Subtle details & gotchas

| Detail | Convention | Our handling | Gate |
|---|---|---|---|
| **R2 binding vs S3** — direct S3 reads need SigV4 in the Worker and pay egress | fetches via S3 URL with SigV4 | bind R2 as `KERNELS` and use `env.KERNELS.get(key)`; never speak S3 | integration test exercises the binding path |
| **Range requests on a 23–29 MB file** — resumable downloads are common; honoring `Range:` matters | returns 200 with the full body | parse single `Range: bytes=N-M`, return 206 + `Content-Range` (multi-range falls back to 200 — RFC 9110 §14.2 lets us ignore Ranges we can't honor) | `test/integration.test.ts` "GET with Range → 206" |
| **Emitting on every response over-counts** — a resumable download is N requests | one emit per response | **emit only on full 200 GET**; never on HEAD (metadata), 206 (one chunk), 404, or 405 | `test/integration.test.ts` covers each case |
| **Analytics outage must not break downloads** — a missed event is acceptable; a failed download is not | propagates queue errors | `recordDownload` (`src/analytics.ts`) swallows `EVENTS_QUEUE.send` failures + logs to `console.error`; the Worker calls it via `ctx.waitUntil` so the response is already on the wire | `test/integration.test.ts` (response is the same regardless of queue health, by construction) |
| **Cross-account queue bindings don't exist** | assumes any CF account works | the Worker MUST deploy in the same CF account as the analytics queue ([ADR 0011](../adr/0011-download-proxy-with-analytics.md) §7) | documented in `download-proxy/README.md` + the ADR |
| **`Content-Type` must distinguish binary from text** for caching + browser handling | one type for everything | `application/octet-stream` for `.kernel`, `text/plain; charset=utf-8` for `SHA256SUMS` | router unit test asserts the per-path content type |
| **`.kernel` content is stable per pinned version** ([reproducibility.md](reproducibility.md)) so it caches forever; `SHA256SUMS` can change within a version on re-release | one cache policy for all | `Cache-Control: public, max-age=31536000, immutable` for `.kernel`; `public, max-age=300` for `SHA256SUMS` | integration test asserts `Cache-Control` contains `immutable` for kernel bundles |
| **Path-shape validation must reject everything that isn't a known artifact** — defense in depth against R2-key probing | tolerant glob over the bucket | pure `parsePath` with two anchored regexes; unknown shapes return 404 BEFORE any R2 read | `test/router.test.ts` covers traversal, query-string bait, wrong extension, casing |
| **Shape drift between `src/analytics.ts` and `analytics/docs/spec/queue-protocol.md`** — no compile-time link between the two repos | trust the doc and hope | `test/integration.test.ts` asserts every spec-required field on the emitted `QueueEvent` (source, event_name, the dual-ID nulls, the ip_* enrichment surface, the properties shape) — a spec change that breaks the consumer fails this test before deploy | the integration test |

## Our design

### Routing — pure function

`download-proxy/src/router.ts` maps `URL.pathname` to an R2 key + analytics
labels. Two accepted patterns; everything else returns `null` and the
Worker responds 404 with no analytics emit.

| pathname pattern | r2_key | package | version | content-type |
|---|---|---|---|---|
| `/linux-<v>-<variant>-<arch>.kernel` | `linux-<v>-<variant>-<arch>.kernel` | `linux-<variant>-<arch>` | `<v>` | `application/octet-stream` |
| `/linux-<v>-SHA256SUMS`              | `linux-<v>-SHA256SUMS`              | `linux-SHA256SUMS`       | `<v>` | `text/plain; charset=utf-8` |

`<v>` is `[0-9]+\.[0-9]+\.[0-9]+` (matches `KERNEL_VERSION` shape in
`scripts/kernel-pin.env`); `<variant>` is `[a-z]+` (`base`, `windows`,
`sev`, `tdx`); `<arch>` is `[a-z0-9_]+` (`x86_64`, `aarch64`, `riscv64`).
Path length is bounded; anything over the cap returns null without regex
work.

### Serving — R2 binding + range

`download-proxy/src/r2.ts`:

- `HEAD` → `env.KERNELS.head(key)`; 200 with `Content-Length`, `ETag`,
  cache headers; 404 if absent. No body, no emit.
- `GET` (no `Range`) → `env.KERNELS.get(key)`; 200 with body + headers.
- `GET` (single `Range: bytes=N-M`) → `env.KERNELS.get(key, { range })`;
  206 + `Content-Range: bytes N-M/<size>`; `Content-Length` is the range
  length. No emit.
- `GET` (multi-range `bytes=N-M,A-B`) → falls back to 200 (full body).
- Any other method → 405 with `Allow: GET, HEAD`.

`Cache-Control`: `public, max-age=31536000, immutable` for kernel
bundles; `public, max-age=300` for SHA256SUMS.

### Analytics emit — hand-rolled per spec

`download-proxy/src/index.ts`:

```ts
if (request.method === 'GET' && response.status === 200) {
  ctx.waitUntil(recordDownload(request, env, {
    package: parsed.package,
    version: parsed.version,
    bytes: Number(response.headers.get('Content-Length')) || 0,
  }));
}
```

`recordDownload` (`src/analytics.ts`) stamps `source: 'kernel_download_proxy'`,
`event_name: 'kernel_download'`, a fresh `anonymous_id`, `user_id: null`,
`group_id: null`, the `request.cf`-derived `ip_*` enrichment, and
`properties = { package, version, bytes }` — the exact shape the
[analytics queue protocol spec](https://github.com/loopholelabs/analytics/blob/main/docs/spec/queue-protocol.md)
requires. The queue write is `ctx.waitUntil`-ed so the response returns
immediately; failures are logged to `console.error` and swallowed.

### Bindings — `download-proxy/wrangler.toml`

- `[[r2_buckets]]` `KERNELS` → bucket `substrate-kernels`.
- `[[queues.producers]]` `EVENTS_QUEUE` → queue `analytics-events`
  (created by the analytics repo).
- `routes` — `kernels.substrate.loopholelabs.io/*` and `kernels.agx.so/*`,
  both `custom_domain = true`.
- `[observability]` enabled.

### Lifecycle — manual deploy

`bunx wrangler deploy` from `download-proxy/`. Worker code rarely
changes; kernel releases happen on tag pushes and don't touch the Worker.
[ADR 0011 §6](../adr/0011-download-proxy-with-analytics.md) records why
no CI deploy workflow ships.

## Verification

Two test files under `download-proxy/test/`, both run via
`@cloudflare/vitest-pool-workers`:

- **`test/router.test.ts`** — pure-function tests for `parsePath`. Every
  shipping (variant × arch) combo (`base × {x86_64, aarch64, riscv64}`,
  `windows × x86_64`, `sev × x86_64`, `tdx × x86_64`) plus SHA256SUMS;
  rejection cases (root, unrelated path, missing version, wrong
  extension, uppercase, traversal sequences, query-string bait, oversized
  path).
- **`test/integration.test.ts`** — real workerd isolate + real miniflare
  R2 binding (seeded per-test from a tiny deterministic fixture);
  `env.EVENTS_QUEUE` stubbed per-test so we can assert the
  `recordDownload` call shape without standing up a consumer. Asserts
  one emit on full GET, zero emits on HEAD/Range/404/405/unknown-path,
  correct `package`/`version`/`bytes` on the event, correct status +
  headers + body on the response.

End-to-end verification after deploy (`download-proxy/README.md`
captures the exact commands): `curl` the public hostnames for a known
kernel bundle, then query ClickHouse for `source = 'kernel_download_proxy'` events in
the last 10 minutes. CLAUDE.md §8 — tests panic on missing resources:
the integration test seeds R2 from a known fixture; absence fails loud,
no silent skip.
