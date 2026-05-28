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
| **Public + unauthenticated** — one chatty IP can chew CPU/request quota and bloat the analytics queue (one event per full GET) | no limiter | per-IP rate limit via the Workers Rate Limiting binding (`DOWNLOAD_RATE_LIMITER_IP`, 60 req/min, keyed on `CF-Connecting-IP`). Checked BEFORE routing so scan traffic on garbage paths also counts. `429` + `Retry-After: 60` on deny; no analytics emit on a rate-limited request | `test/integration.test.ts` "returns 429 + Retry-After when the per-IP rate limit denies" |
| **`/` was a dead 404** — bucket is the public face of the kernel artifacts; users hit `kernels.substrate.loopholelabs.io` and saw nothing | redirect to GitHub releases | `GET /` SSRs a browseable listing of the bucket (`src/html.ts` + `src/listing.ts`). 5-min `Cache-Control` + ETag on the response. Visual identity mirrors `agx/substrate/tools/bench/dashboard/index.html` (same CSS variables, fonts, header/footer pattern) and applies the same three substrate-bench "decisions": header nav is just GitHub, footer middle is 3 items (no `changelog`), Featured card is server-curated to the newest mainline version | `test/integration.test.ts` `GET / → 200 HTML listing` |

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

### Listing page at `/` — SSR over R2

`GET /` (and `HEAD /`) renders a browseable HTML page of every artifact
currently in the bucket. The pipeline:

1. `listKernels(env)` in `src/listing.ts` calls `env.KERNELS.list({
   prefix: 'linux-' })` once, parses each key against the shared
   patterns in `src/patterns.ts`, drops anything that doesn't match,
   groups artifacts by `<major>.<minor>` version line, sorts
   newest-first within each line, and rolls in the per-version
   `SHA256SUMS` files.
2. `renderListingHtml(listing)` in `src/html.ts` emits the page —
   header, hero, toolbar, **Featured** card (server-curated to the
   newest mainline version, mirroring the bench dashboard's pinned
   `HEADLINE[]`), kernels table with one row per (version, arch),
   notes, footer.
3. The handler stamps `Cache-Control: public, max-age=300, s-maxage=300`
   and an ETag derived from `<artifactCount>-<lastUploadMs>`. CF's
   edge caches the page for 5 minutes; `If-None-Match` round-trips to
   `304` for free.
4. **No analytics emit** — `/` is not a kernel download. The rate
   limiter still applies (it runs ahead of any routing, so even `/`
   counts against the per-IP bucket).

Per-row UX details worth calling out:

- **The SHA256 cell is a per-row link** to the version's
  `SHA256SUMS` artifact. One click from any row gets you the
  checksums file covering that version — no separate menu, no
  scrolling. `event.stopPropagation()` on the link prevents the
  outer row's download from firing on the same click.
- **`NEW` pill** on the latest patch in each version line (computed
  server-side as `isNewest`).
- **Inline client-side filter / search / sort** (~70 lines of JS)
  toggles a `.hidden` class on the already-rendered rows; no fetch,
  no re-render. Search matches version or short-hash prefix, arch
  segments to `all / x86_64 / aarch64`, sort flips newest ↔ oldest.

The substrate-bench "decisions" applied verbatim (see the section
"Substrate-bench decisions" below).

### Substrate-bench decisions

The bench dashboard implementation diverges from its own Pencil design
in three load-bearing ways. The listing page applies the same
divergences so the two pages share an identity:

| Section | Pencil design | Both pages |
|---|---|---|
| Header nav | 4 items (Docs / Benchmarks / Blog / GitHub or +Kernels) | Only `GitHub` (link to https://github.com/loopholelabs) |
| Footer left | "© 2026" + "Loophole Labs" as two nodes | `© 2026 Loophole Labs` as a single link |
| Footer middle | `status / changelog / privacy / terms` (4 items) | `status / privacy / terms` (3 items; `changelog` dropped) |
| Top summary | Generic 4-card grid | Server-curated: bench pins `HEADLINE[]`, kernels pins `featured` = newest mainline |

### Kernel-page-specific copy

The Pencil design's Notes section says "All kernels are reproducibly
built and signed with cosign." We are NOT cosign-signing yet, so the
copy swaps the signature claim for a link to the source:

> All kernels are reproducibly built. Source open at
> [github.com/loopholelabs/substrate-kernel](https://github.com/loopholelabs/substrate-kernel).

Same substitution in the Featured card's mini-nav — `signature` →
`source`. The link goes in the same slot the cosign reference would
have occupied so the row's information density and the user's eye-path
are preserved.

### Rate limit — per-IP, before routing

`download-proxy/src/ratelimit.ts` calls the Workers Rate Limiting binding
keyed on `CF-Connecting-IP`. Default: **60 requests / minute / IP** (10
kernel files worth of activity per minute is generous for any real use;
abusive volume from a single source is bounded). Applied to every
request — so a probe-and-back-off attack varying paths still counts
against the bucket. On deny: `429` + `Retry-After: 60`, no R2 read, no
analytics emit. Falls open if `CF-Connecting-IP` is missing (production
edge always sets it; `wrangler dev` sometimes doesn't).

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
- `[[unsafe.bindings]]` `DOWNLOAD_RATE_LIMITER_IP` → Rate Limiting
  binding (60 req/min/IP).
- `[[routes]]` `kernels.substrate.loopholelabs.io` and `kernels.agx.so`,
  both `custom_domain = true` (bare hostname, no `/*`).
- `[observability.logs]` + `[observability.traces]` enabled with
  persistence (mirrors `agx/cloud/local-certificates`).

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
