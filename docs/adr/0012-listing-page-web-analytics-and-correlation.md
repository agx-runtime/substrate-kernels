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

1. **Load the RudderStack JS SDK on `GET /`.** The Worker injects the official v3
   loader into `<head>` only when a write key is configured for the request host
   (below); otherwise the page renders without it (graceful no-op). The page fires
   `page` on load and `track` events for `kernel_search` (debounced), and
   `kernel_download_click` / `sha256sums_download` on the matching download clicks.

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

6. **The analytics side is a dependency, tracked, not in this repo.** For the SDK to
   work end-to-end the analytics ingest must (a) allow CORS from the two hostnames,
   (b) have a web write key per domain in its `WRITE_KEYS` KV mapped to
   `WEB:<HOST>`, and (c) make the SDK's source config reachable. Until then the
   Worker degrades gracefully (no write key configured → no SDK; the page and all
   downloads still work).

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
