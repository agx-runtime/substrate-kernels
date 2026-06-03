# ADR 0012 — Listing-page web analytics and download correlation

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context doc:** [../design/download-proxy.md](../design/download-proxy.md)
  ("Analytics & correlation"); [ADR 0011](0011-download-proxy-with-analytics.md)
  (the download proxy this extends)

## Context

The download proxy ([ADR 0011](0011-download-proxy-with-analytics.md)) emits one
server-side `kernel_download` event per full download. That captures *what was
downloaded*, but nothing about *who reached the listing page, what they searched,
or which artifact they clicked* — and the server-side event's `anonymous_id` was a
throwaway random UUID, so it could not be tied to anything.

We want three things:

1. **Visit-level analytics on the `GET /` listing page** — page views, searches,
   and download-click intent — in the same analytics pipeline the proxy already
   writes to.
2. **A `source` that names the site** so dashboards can slice per-domain (the proxy
   answers on two hostnames, `kernels.substrate.loopholelabs.io` and
   `kernels.agx.so`).
3. **Correlation** between the page's "download click" and the proxy's actual
   `kernel_download` byte-transfer event — and the ability for the CLI to tag its
   downloads too.

Two facts shape the design:

- The analytics stack is RudderStack/Segment-wire-compatible: a browser SDK posts
  to `POST /v1/batch` at the analytics data plane (`data.agx.so`), authenticated by
  a write key whose KV record stamps the event `source` (analytics ADR 0010 — write
  keys are not secrets; ADR 0002 — `source` is an open set).
- **The listing page and the download proxy are the same origin** (one Worker on
  each hostname). A first-party cookie set by JS on the page is therefore sent
  automatically on the same-origin navigation to a `/<artifact>` download URL — so
  the proxy can read it without the anonymous id ever appearing in the URL.

## Decision

1. **Load the RudderStack JS SDK on `GET /` via a same-origin reverse proxy.**
   The Worker injects the v3 loader into `<head>` only when a write key is
   configured for the request host (below); otherwise the page renders without
   it (graceful no-op). The loader is modified to load every SDK URL from
   first-party paths under `/_data/` on this Worker — see §6 for the route
   set. The page fires `page` on load and `track` events for `kernel_search`
   (debounced), and `kernel_download_click` / `sha256sums_download` on the
   matching download clicks.

2. **`source` = `WEB:<HOSTNAME UPPERCASE>`** (e.g. `WEB:KERNELS.AGX.SO`), on **both**
   surfaces:
   - **Page SDK events:** each hostname has its own write key, whose analytics-side
     KV record is `{ source: "WEB:<HOST>", enabled: true }`. The Worker injects the
     write key for the request host from the `ANALYTICS_WRITE_KEYS` var.
   - **Proxy server event:** the `kernel_download` producer stamps the same string,
     derived from the request host ([ADR 0011](0011-download-proxy-with-analytics.md) §4).

   They match per host by construction. `event_name` distinguishes the page's click
   intent (`kernel_download_click`) from the server's byte transfer
   (`kernel_download`). `WEB:KERNELS.SUBSTRATE.LOOPHOLELABS.IO` is 37 bytes — well
   within the analytics `MAX_SOURCE_LENGTH` (64).

3. **Correlate via a same-origin first-party cookie.** After the SDK is ready the
   page writes `substrate_aid = rudderanalytics.getAnonymousId()` as a first-party
   cookie (`Path=/; Max-Age=1y; SameSite=Lax; Secure`). When the browser navigates
   to a download URL, that cookie rides along; the proxy reads it and stamps it as
   the `kernel_download` event's `anonymous_id`. The page's click event and the
   server's download event then share one `anonymous_id`, joinable in ClickHouse.
   We set our own cookie rather than parsing RudderStack's `rl_anonymous_id` because
   that cookie's encoding/storage is not a stable contract.

4. **The proxy accepts an optional anonymous id, header- or cookie-supplied.**
   `recordDownload` resolves it as: `X-Substrate-Anonymous-Id` header (the CLI) →
   `substrate_aid` cookie (the browser) → a fresh random UUID. A supplied id must be
   ≤128 chars (analytics `MAX_ID_LENGTH`) and match `[A-Za-z0-9._:-]`; anything else
   is ignored so a malformed input never poisons the column.

5. **Per-host write keys live in `[vars]`, not code.** `ANALYTICS_DATA_PLANE_URL`
   and `ANALYTICS_WRITE_KEYS` (a JSON `hostname → write key` map) are Worker vars.
   Write keys are not secrets (analytics ADR 0010), so `[vars]` is the right home,
   and the SDK config is changeable without a code edit. The page HTML embeds a
   per-host write key, so the host is folded into the listing ETag.

6. **Reverse-proxy the SDK on our own origin** (this Worker, under `/_data/`):
   the SDK file, its lazy-loaded plugin chunks, and the source-config endpoint
   are all served first-party. The loaded SDK then posts events to
   `data.agx.so/v1/batch` (already CORS-allowed for both hostnames; analytics
   commit `012c7c5`). Two structural problems vanish:
   - **Adblock host filters can't match.** EasyPrivacy ships
     `||rudderlabs.com^$third-party` (verified on `easylist/easyprivacy/`
     master); the standard CDN load `cdn.rudderlabs.com/v3/<build>/rsa.min.js`
     is blocked by default uBlock / Brave Shields. First-party URLs defeat
     this unconditionally.
   - **The control-plane dependency vanishes.** Stock `load()` fetches source
     config from `api.rudderstack.com/sourceConfig` — which 400s any writeKey
     not registered with RudderStack's hosted control plane. We host our own
     ingest; our writeKeys exist only in our KV. Synthesizing the response on
     our side bypasses the dependency entirely.

   Routes served by `download-proxy/src/sdk-proxy.ts`:
   | Method | Path | Behavior |
   |---|---|---|
   | GET | `/_data/<modern\|legacy>/client.min.js` | proxies `cdn.rudderlabs.com/<pinned>/<build>/rsa.min.js` (filename renamed in our URL) |
   | GET | `/_data/<modern\|legacy>/p/<file>` | proxies `cdn.rudderlabs.com/<pinned>/<build>/plugins/<file>` (lazy plugin chunks) |
   | GET | `/_data/sourceConfig/?writeKey=<k>` | synthesized JSON; `?writeKey` must be one of the configured per-host write keys |
   | POST | `/_data/v1/<type>` | event ingest forwarder — see below |

   The SDK loader is modified to set `sdkBaseUrl = window.location.origin +
   "/_data"`, `sdkName = "client.min.js"`, and pass `configUrl`,
   `pluginsSDKBaseURL`, `destSDKBaseURL` load options pointing at the same
   prefix. **`dataPlaneUrl` is also set to `window.location.origin + "/_data"`
   so every event POST stays first-party.** The pinned SDK version (currently
   **3.31.2**) is a single constant in `sdk-proxy.ts`; bumping it is a reviewed
   change re-validated against the `isValidSourceConfig` shape.

   The `/_data/v1/<type>` POST route exists because the SDK's default
   `XhrQueue` plugin builds `${dataPlaneUrl}/v1/${type}` per event (where
   `type` ∈ `{track, page, identify, group}`), not `/v1/batch`. Our analytics
   ingest only accepts `/v1/batch`, and only sets CORS for that path — so the
   stock `dataPlaneUrl=https://data.agx.so` configuration would: (a) get
   CORS-blocked on the preflight to `data.agx.so/v1/page`, and (b) 404 on
   the path even if CORS passed. The forwarder rewrites every `/_data/v1/*`
   POST to `${ANALYTICS_DATA_PLANE_URL}/v1/batch` server-side (the wire
   format accepts both the single-message and the wrapped-batch shape per
   `wire-format.md`), preserves the `Authorization`, `Content-Type`, and
   `CF-Connecting-IP` headers (so writeKey auth, body parsing, and the
   analytics per-IP rate limit + `ip_*` enrichment all see what they
   expect), and propagates the upstream status verbatim so the SDK's
   `RetryQueue` plugin can do its job on 5xx / network failures.

   The synthesized source-config body mirrors the SDK team's own mock
   (`rudder-sdk-js/examples/utils/mock-servers/control-plane.js`) with
   `source.config.statsCollection.{errors,metrics}.enabled = false` so the
   SDK does not spin up the `/rsaMetrics` error-reporting path. The minimum
   shape the SDK accepts is `{ source: { id, config: {}, destinations: [] } }`
   per `rudder-sdk-js/packages/analytics-js/src/components/configManager/util/validate.ts::isValidSourceConfig`;
   the extra fields we ship (writeKey, enabled, name, workspaceId, updatedAt)
   match the mock for forward-compatibility.

   **Plugin filenames stay upstream-named** (`rsa-plugins.js`,
   `rsa-plugins-remote-<Name>.min.js`) because the federated-module manifest
   is baked into the SDK proper; renaming requires rewriting the SDK body on
   the fly. Not in current EasyPrivacy; flagged as a future hardening step if
   filter lists ever add a `rsa-plugins` rule.

7. **The remaining analytics-side dependency.** None of `data.agx.so`
   appears on the page; events ride the same-origin `/_data/v1/<type>` route
   and the worker forwards to `${ANALYTICS_DATA_PLANE_URL}/v1/batch`
   server-side (no CORS — Worker-to-Worker fetch, no browser involvement).
   The analytics ingest only needs (a) a web write key per domain in its
   `WRITE_KEYS` KV mapped to `WEB:<HOST>`. The earlier CORS contract
   (commit `012c7c5`) is no longer load-bearing for this page, though it
   remains useful for other consumers.

## Consequences

- **Visit-level signal joins the pipeline.** Page views, searches, and click intent
  land alongside the server-side download events, all `source = WEB:<HOST>`, sliceable
  per domain and joinable on `anonymous_id`.
- **Click → download attribution.** The funnel "landed → searched → clicked →
  actually downloaded" is reconstructable: the click (`kernel_download_click`, web)
  and the transfer (`kernel_download`, server) carry one `anonymous_id` via the
  same-origin cookie — no anonymous id in the URL, no edge-cache fragmentation.
- **CLI downloads are taggable.** A CLI that sets `X-Substrate-Anonymous-Id` ties its
  downloads to its own machine identity.
- **A standing external dependency.** The analytics-side CORS + write keys + source
  config must exist for the SDK to emit; the substrate-kernel side is built to no-op
  cleanly until they do. This is the same shape of cross-repo coupling ADR 0011
  already accepts (the queue contract), now extended to the browser ingest path.
- **`source` semantics changed for the proxy event** — it was an implicit constant
  (`kernel_download_proxy`); it is now `WEB:<HOST>`, matching the page. ADR 0011 §4
  is amended to record this.

## Alternatives considered

- **The stock RudderStack v3 loader pointed at `cdn.rudderlabs.com` and
  `api.rudderstack.com`.** Initial choice, reverted. Two structural failures
  in production: (a) EasyPrivacy blocks `||rudderlabs.com^$third-party`, so
  default-uBlock browsers never load the script; (b) the SDK's `load()`
  fetches source config from `api.rudderstack.com/sourceConfig`, which 400s
  any writeKey not registered with RudderStack's hosted control plane — we
  host our own ingest, so the writeKeys exist only in our KV. The reverse
  proxy in §6 fixes both unconditionally and is the pattern RudderStack docs
  themselves recommend ("Harden JavaScript SDK", "Self-host JavaScript SDK in
  Your CDN") and that PostHog ships for their own SDK proxy.
- **A 50-line first-party inline tracker** matching the analytics wire format
  directly (`POST /v1/batch` with Basic auth). Considered, rejected: it works,
  but we lose the SDK's session / auto-page / queue / retry machinery and
  every future SDK improvement; the reverse proxy gives us those for ~100
  lines of worker code instead.
- **A same-origin in-repo ingest sink** (the page posts to a `/v1/batch` on this
  Worker, which enqueues directly) — rejected: it would avoid the analytics-side
  CORS dependency and give `source = domain` for free, but it re-implements the
  analytics ingest contract in this repo (drift risk) and forgoes the real SDK. We
  use the real RudderStack SDK against the canonical data plane; CORS is being added
  there separately.
- **Anonymous id in the download URL** (`?aid=…` on the redirect) — rejected: it
  pollutes the public, cache-`immutable` download URL and fragments the CF edge cache
  by query string. The same-origin cookie carries it with neither cost.
- **Read RudderStack's own `rl_anonymous_id` cookie in the proxy** — rejected: its
  encoding/storage backend (cookie vs localStorage, optional encryption) is not a
  documented contract; a self-owned `substrate_aid` cookie is stable and explicit.
- **A single `kernels_web` source with the domain in `properties`** — rejected: the
  decision is `source` = the domain, so dashboards `GROUP BY source` directly; a
  per-host write key is the SDK-native way to set it, and it makes the proxy event
  and the page events share the field.
- **Provision one shared write key for both hostnames** — rejected: it would collapse
  the two domains to one `source`, losing the per-domain split the proxy event also
  carries.
