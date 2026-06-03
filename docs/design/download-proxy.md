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
| **`source` should name the site for per-domain slicing** ([ADR 0012](../adr/0012-listing-page-web-analytics-and-correlation.md)) | a fixed producer label | `source = WEB:<HOSTNAME UPPERCASE>` on **both** the proxy event (derived from the request host) and the page SDK events (via the per-host write key → KV mapping); they match per host. `event_name` distinguishes `kernel_download` (server) from `kernel_download_click` (web) | `test/integration.test.ts` asserts `source = WEB:<HOST>` |
| **The proxy event's `anonymous_id` was a throwaway** — nothing could be tied to it | fresh random per download | resolve `X-Substrate-Anonymous-Id` header (CLI) → `substrate_aid` cookie (browser) → fresh UUID; a supplied id must be ≤128 chars + `[A-Za-z0-9._:-]` or it is ignored (never poisons the column) | `test/integration.test.ts` header / cookie / header-beats-cookie / malformed-fallback |
| **Correlating a page download-click with the actual transfer** without an id in the URL | redirect with the id in the query string (cache fragmentation) | the listing page + the proxy are **same origin**, so a first-party `substrate_aid` cookie (set from the SDK's `getAnonymousId()`) rides the same-origin download navigation; the proxy reads it. No URL change, no edge-cache fragmentation | end-to-end (ClickHouse join on `anonymous_id`); cookie-read covered by the integration test |
| **The listing page had no visit analytics** | none | `GET /` injects the RudderStack v3 SDK (cloud-mode) pointed at `ANALYTICS_DATA_PLANE_URL`, with the per-host write key from `ANALYTICS_WRITE_KEYS`; fires `page` / `kernel_search` / `kernel_download_click` / `sha256sums_download`. Injected only when a write key is configured for the host — else the page renders without it (graceful) | `test/integration.test.ts` "GET / with a write key configured" / "does NOT inject … no mapped write key" |
| **EasyPrivacy blocks `\|\|rudderlabs.com^$third-party`** — the stock SDK CDN load is blocked by default-uBlock / Brave Shields | load directly from `cdn.rudderlabs.com` | reverse-proxy on this Worker's origin under `/_data/`: `client.min.js` → `cdn.rudderlabs.com/<pinned>/<build>/rsa.min.js`; `p/<file>` → the lazy plugin chunks (`sdk-proxy.ts`). Loader overrides `sdkBaseUrl`/`sdkName`/`pluginsSDKBaseURL` so every SDK URL stays first-party | `test/integration.test.ts` "/_data/modern/client.min.js → proxies cdn.rudderlabs.com" + HTML has no `cdn.rudderlabs.com`/`api.rudderstack.com`/`rsa.min.js` |
| **Stock `load()` fetches source config from `api.rudderstack.com/sourceConfig` → 400 "Invalid write key"** — RudderStack's hosted control plane doesn't know our KV writeKeys | accept that as a hard failure | synthesize the response in `sdk-proxy.ts::serveSourceConfig`; minimum shape per `rudder-sdk-js`'s own `isValidSourceConfig` (`source.id` + `source.config` object + `source.destinations` array); mirror the SDK team's mock control-plane to silence error-reporting + metrics paths | `test/sdk-proxy.test.ts` source-config shape; `test/integration.test.ts` known/unknown/missing writeKey |
| **SDK's default `XhrQueue` posts per-event to `${dataPlane}/v1/<type>`** (not `/v1/batch`) — our analytics ingest only accepts `/v1/batch` and only sets CORS for that path, so the stock `dataPlaneUrl=https://data.agx.so` configuration: (a) gets CORS-blocked on the preflight to `data.agx.so/v1/page`, and (b) 404s on the upstream path | accept the per-event POST shape | set the SDK's `dataPlaneUrl` to `window.location.origin + "/_data"` (same-origin = no CORS); the worker rewrites every `/_data/v1/<type>` POST to `${ANALYTICS_DATA_PLANE_URL}/v1/batch` (`proxyAnalyticsIngest`), forwarding `Authorization`, `Content-Type`, and `CF-Connecting-IP`, propagating upstream status so `RetryQueue` can retry 5xx | `test/integration.test.ts` `/_data/v1/page` rewrite, header forwarding, status propagation, POST-only |
| **CDN proxy abuse + SDK schema drift** | proxy the path verbatim, follow the moving `v3/` channel | strict path regex (only `modern`/`legacy` + safe-charset plugin filenames); pin SDK to a single `PINNED_SDK_VERSION` constant; bump is a reviewed change re-validated against `isValidSourceConfig` | `test/sdk-proxy.test.ts` rejects `/_data/evil/...`, traversal, query-string bait |

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

`recordDownload` (`src/analytics.ts`) stamps `source = WEB:<HOSTNAME UPPERCASE>`
(derived from the request host — e.g. `WEB:KERNELS.AGX.SO`),
`event_name: 'kernel_download'`, the resolved `anonymous_id` (header →
cookie → fresh UUID; see below), `user_id: null`, `group_id: null`, the
`request.cf`-derived `ip_*` enrichment, and
`properties = { package, version, bytes }` — the exact shape the
[analytics queue protocol spec](https://github.com/loopholelabs/analytics/blob/main/docs/spec/queue-protocol.md)
requires. The queue write is `ctx.waitUntil`-ed so the response returns
immediately; failures are logged to `console.error` and swallowed.

### Listing-page analytics + correlation ([ADR 0012](../adr/0012-listing-page-web-analytics-and-correlation.md))

`GET /` injects the RudderStack v3 SDK (cloud-mode) into `<head>` via a
**same-origin reverse proxy** when a write key is configured for the request
host. `download-proxy/src/index.ts` `resolveAnalytics(env, hostname)` reads
`ANALYTICS_DATA_PLANE_URL` and the `ANALYTICS_WRITE_KEYS` `hostname → write
key` map; `renderAnalytics` (`src/html.ts`) emits the loader (with overridden
`sdkBaseUrl` / `sdkName` / `configUrl` / `pluginsSDKBaseURL`) or nothing
(graceful). The write key sets `source = WEB:<HOST>` on the analytics side,
so page events and the proxy event match per host.

**The reverse proxy.** Four routes served by `download-proxy/src/sdk-proxy.ts`,
all first-party so EasyPrivacy's `||rudderlabs.com^$third-party` rule cannot
match anything the page loads — and the SDK's per-event POSTs avoid CORS
preflight entirely because they're same-origin:

| Method | Path | Behavior |
|---|---|---|
| GET | `/_data/<modern\|legacy>/client.min.js` | proxies `cdn.rudderlabs.com/<pinned>/<build>/rsa.min.js` (the SDK file; renamed in our URL) |
| GET | `/_data/<modern\|legacy>/p/<file>` | proxies `cdn.rudderlabs.com/<pinned>/<build>/plugins/<file>` (lazy plugin chunks) |
| GET | `/_data/sourceConfig/?writeKey=<k>` | synthesized JSON; 401 if `<k>` isn't one of our configured write keys |
| POST | `/_data/v1/<type>` | event ingest forwarder → `${ANALYTICS_DATA_PLANE_URL}/v1/batch` (Authorization + CF-Connecting-IP forwarded; upstream status propagated for RetryQueue) |

The SDK version is a single `PINNED_SDK_VERSION` constant (currently **3.31.2**)
in `sdk-proxy.ts`; a bump is a reviewed change re-validated against
`isValidSourceConfig`. The synthesized source-config body mirrors
`rudder-sdk-js/examples/utils/mock-servers/control-plane.js` with
`statsCollection.{errors,metrics}.enabled = false` so the SDK does not spin
up the `/rsaMetrics` error-reporting path. Minimum-required shape per
`rudder-sdk-js/packages/analytics-js/src/components/configManager/util/validate.ts::isValidSourceConfig`:
`{ source: { id, config: {}, destinations: [] } }`. CDN responses are
cached `public, max-age=86400, immutable` (pin makes them content-stable);
source-config is `max-age=300` (the response is byte-stable per writeKey so
the CF edge can cache it).

The page fires `track` events from the inline client JS: `kernel_search`
(debounced), and `kernel_download_click` / `sha256sums_download` on the
matching download clicks (a capture-phase listener catches the anchors; the
row-click handler tracks the keyboard/row navigations). All `track` calls
are no-ops unless the SDK loaded.

**Correlation.** On SDK ready, the page sets a first-party cookie
`substrate_aid = rudderanalytics.getAnonymousId()` (`Path=/; SameSite=Lax;
Secure`). Because the listing page and the download proxy are the **same
origin**, that cookie rides the same-origin navigation to a `/<artifact>`
URL; `recordDownload` reads it (`resolveAnonymousId`) and stamps it as the
`kernel_download` event's `anonymous_id`. The page's `kernel_download_click`
and the server's `kernel_download` then share one `anonymous_id` — joinable
in ClickHouse — with no id in the URL. The CLI supplies its id via the
`X-Substrate-Anonymous-Id` header instead (header wins over cookie). A
supplied id must be ≤128 chars and `[A-Za-z0-9._:-]`, else it is ignored
and a fresh UUID is used.

**Analytics-side dependency (now minimal).** Nothing on the page reaches
`data.agx.so` directly — events ride the same-origin `/_data/v1/<type>`
route and the worker forwards Worker-to-Worker to
`${ANALYTICS_DATA_PLANE_URL}/v1/batch`. The analytics ingest only needs (a) a
web write key per domain in the `WRITE_KEYS` KV mapped to `WEB:<HOST>`;
until a write key is configured for the request host, the page renders
without the SDK (graceful). The CORS contract on `data.agx.so` (commit
`012c7c5`) is no longer load-bearing for this page.

**Plugin filenames stay upstream-named** (`rsa-plugins.js`,
`rsa-plugins-remote-<Name>.min.js`) — the federated-module manifest is baked
into `rsa.min.js`, so renaming requires rewriting the SDK body on the fly.
Not in current EasyPrivacy; flagged as a future hardening step if filter
lists ever add a `rsa-plugins` rule.

### Bindings — `download-proxy/wrangler.toml`

- `[[r2_buckets]]` `KERNELS` → bucket `substrate-kernels`.
- `[[queues.producers]]` `EVENTS_QUEUE` → queue `analytics-events`
  (created by the analytics repo).
- `[[unsafe.bindings]]` `DOWNLOAD_RATE_LIMITER_IP` → Rate Limiting
  binding (60 req/min/IP).
- `[vars]` `ANALYTICS_DATA_PLANE_URL` (`https://data.agx.so`) and
  `ANALYTICS_WRITE_KEYS` (a JSON `hostname → write key` map; write keys are
  not secrets per analytics ADR 0010). Absent / unmatched host → no SDK.
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
  headers + body on the response, `source = WEB:<HOST>`, the `anonymous_id`
  resolution (header / cookie / header-beats-cookie / malformed-fallback),
  and that `GET /` injects the SDK only when a write key is configured.

End-to-end verification after deploy (`download-proxy/README.md`
captures the exact commands): `curl` the public hostnames for a known
kernel bundle, then query ClickHouse for `source = 'WEB:KERNELS.AGX.SO'`
(or the other host) events in the last 10 minutes; for the click→download
join, load the page, click a download, and confirm the
`kernel_download_click` and `kernel_download` rows share one `anonymous_id`.
CLAUDE.md §8 — tests panic on missing resources: the integration test seeds
R2 from a known fixture; absence fails loud, no silent skip.
