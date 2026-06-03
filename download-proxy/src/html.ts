/**
 * SSR for `GET /` — the kernels listing page.
 *
 * Visual identity mirrors agx/substrate/tools/bench/dashboard/index.html
 * (same CSS variables, fonts, header/footer shape, responsive
 * breakpoints) so the two pages share an identity. The structure follows
 * Pencil node `j9Oy9v`.
 *
 * The substrate-bench dashboard made three load-bearing UX choices that
 * diverge from its own Pencil design; we keep the same divergences:
 *   1. Header nav is just "GitHub" (drop Docs / Benchmarks / Blog).
 *   2. Footer left is `© 2026 Loophole Labs` as a single link; middle
 *      is the 3-item `status / privacy / terms` (no `changelog`); right
 *      is `hello@loopholelabs.io` as plain text.
 *   3. The "Featured" card is server-curated (newest mainline), not
 *      derived from generic data — same shape as the bench dashboard's
 *      pinned `HEADLINE[]` array.
 *
 * docs/design/download-proxy.md "Listing page" is authoritative.
 */

import {
  type KernelArtifact,
  type Listing,
  type VersionGroup,
  humanDate,
  humanSize,
  shortHash,
} from './listing.ts';
import type { AnalyticsConfig } from './types.ts';

const REPO_URL = 'https://github.com/loopholelabs/substrate-kernel';
const ORG_URL = 'https://github.com/loopholelabs';
const RELEASES_URL = `${REPO_URL}/releases`;
const DESIGN_DOC_URL = `${REPO_URL}/blob/main/docs/design/build-pipeline.md`;

/**
 * Render the full HTML page from a prepared Listing. When `analytics` is
 * provided the RudderStack SDK is injected into <head> (docs/adr/0012);
 * `null` renders the page without it (graceful no-op).
 */
export function renderListingHtml(
  listing: Listing,
  analytics: AnalyticsConfig | null = null,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Substrate — Kernels</title>
<meta name="description" content="Pre-built Linux kernel bundles for the Substrate hypervisor — monolithic, virtio-only, reproducible." />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
<style>${PAGE_CSS}</style>
${renderAnalytics(analytics)}
</head>
<body>
  ${renderHeader()}
  <main>
    <div class="inner">
      ${renderHero()}
      ${renderToolbar()}
      ${renderFeatured(listing.featured)}
      ${renderTable(listing)}
      ${renderNotes()}
    </div>
  </main>
  ${renderFooter()}
<script>${PAGE_JS}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTML escape (defense in depth — the data is from R2 + our own regex
// parser, but renderListingHtml is the boundary that emits to the browser).
// ---------------------------------------------------------------------------
function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"]/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderHeader(): string {
  return `<header class="site">
    <a class="logo" href="/">
      <span class="mark mono">[S]</span>
      <span class="word">SUBSTRATE</span>
    </a>
    <nav class="top">
      <a href="${esc(ORG_URL)}" target="_blank" rel="noopener">GitHub</a>
    </nav>
  </header>`;
}

function renderHero(): string {
  return `<section class="hero">
    <div class="titlerow">
      <div class="titleL">
        <h1>Kernels</h1>
        <p class="subtitle">Pre-built Linux kernels tuned for the Substrate hypervisor. Click any row to download.</p>
      </div>
      <a class="repolink" href="${esc(REPO_URL)}" target="_blank" rel="noopener">
        ${ICONS.github}
        <span>loopholelabs/substrate-kernel</span>
      </a>
    </div>
  </section>`;
}

function renderToolbar(): string {
  return `<section class="toolbar">
    <div class="tbL">
      <label class="search">
        ${ICONS.search}
        <input id="q" type="search" placeholder="search version or sha256…" autocomplete="off" spellcheck="false" />
      </label>
      <div class="seg" id="seg-arch" role="group" aria-label="Filter by architecture">
        <button data-arch="" class="active" type="button">all</button>
        <button data-arch="x86_64" type="button">x86_64</button>
        <button data-arch="aarch64" type="button">aarch64</button>
      </div>
    </div>
    <div class="tbR">
      <button id="sort-btn" class="sort" type="button" aria-label="Sort order">
        <span class="k">sort:</span>
        <span class="v" id="sort-v">newest</span>
        ${ICONS.chevronDown}
      </button>
    </div>
  </section>`;
}

function renderFeatured(featured: VersionGroup | null): string {
  if (featured === null) {
    return `<section class="featured empty">
      <p>No kernel bundles in this bucket yet.</p>
    </section>`;
  }
  // Headline card highlights the production kernel only; debug bundles are
  // for developers and live in the table below.
  const baseArtifacts = featured.artifacts.filter((a) => a.variant === 'base');
  const archButtons = baseArtifacts
    .map(
      (a, i) => `<a class="dl ${i === 0 ? 'primary' : ''}" href="/${esc(a.key)}" download>
      ${ICONS.download}
      <span>${esc(a.arch)}</span>
    </a>`,
    )
    .join('');
  const releaseDate = baseArtifacts[0]?.uploaded
    ? humanDate(baseArtifacts[0].uploaded)
    : '—';
  const sumsUrl = featured.sums ? `/${featured.sums.key}` : null;
  return `<section class="featured">
    <div class="ftL">
      <div class="ftRow1">
        <span class="badge">LATEST · MAINLINE</span>
        <span class="v">linux-${esc(featured.version)}</span>
        <span class="rel">released ${esc(releaseDate)}</span>
      </div>
      <p class="ftBody">The latest mainline Linux kernel, pre-built and tuned for Substrate microVMs — monolithic, virtio-only, and reproducible. Pick an architecture below to download.</p>
      <div class="ftMeta">
        ${baseArtifacts
          .map(
            (a) =>
              `<span class="kv"><span class="k">${esc(a.arch)}:</span><span class="v mono">${esc(shortHash(a.etag))}</span></span>`,
          )
          .join('')}
      </div>
    </div>
    <div class="ftR">
      <div class="dlgroup">${archButtons}</div>
      <nav class="ftNav">
        ${sumsUrl ? `<a href="${esc(sumsUrl)}" download>sha256sums</a>` : ''}
        <a href="${esc(RELEASES_URL)}/tag/v${esc(featured.version)}" target="_blank" rel="noopener">release notes</a>
        <a href="${esc(REPO_URL)}" target="_blank" rel="noopener">source</a>
      </nav>
    </div>
  </section>`;
}

function renderTable(listing: Listing): string {
  if (listing.lines.length === 0) {
    return `<section class="table empty"><p>Nothing to list.</p></section>`;
  }
  const head = `<div class="trow thead">
    <span class="c-version">VERSION</span>
    <span class="c-channel">CHANNEL</span>
    <span class="c-arch">ARCH</span>
    <span class="c-size">SIZE</span>
    <span class="c-built">BUILT</span>
    <span class="c-sha">SHA256</span>
    <span class="c-dl"></span>
  </div>`;
  const body = listing.lines.map(renderLineGroup).join('');
  return `<section class="table" id="tbl" aria-label="Kernel artifacts">
    ${head}
    ${body}
  </section>`;
}

function renderLineGroup(line: Listing['lines'][number]): string {
  const sectionHeader = `<div class="trow tsection" data-line="${esc(line.line)}">
    <span class="t">${esc(line.label)}</span>
    <span class="d">${esc(line.description)}</span>
  </div>`;
  const rows = line.versions
    .flatMap((v) => v.artifacts.map((a) => renderArtifactRow(a, v, line)))
    .join('');
  return sectionHeader + rows;
}

function renderArtifactRow(
  a: KernelArtifact,
  v: VersionGroup,
  line: Listing['lines'][number],
): string {
  const searchKey = `${a.version} ${a.variant} ${a.arch} ${shortHash(a.etag)} ${a.etag.replace(/"/g, '')}`.toLowerCase();
  const sortKey = `${a.version}|${a.arch}|${a.uploaded.getTime()}`;
  const sumsHref = v.sums ? `/${v.sums.key}` : null;
  const newPill = v.isNewest ? `<span class="newpill">NEW</span>` : '';
  const verCls = v.isNewest ? 'mono active' : 'mono';
  const dlHref = `/${esc(a.key)}`;
  // The outer row is a <div> so we can have BOTH the per-row sha link
  // and the per-row download link inside it (nested <a> tags are illegal
  // in HTML and browsers auto-close the outer one — that's what caused
  // the c-sha and c-dl cells to render as orphaned blocks below the
  // row). A click anywhere on the row triggers the .kernel download
  // via the inline JS handler; the .sumslink and .dlbtn anchors handle
  // their own clicks and stop propagation.
  return `<div class="trow tartifact" data-dl="${dlHref}"
    data-version="${esc(a.version)}"
    data-line="${esc(line.line)}"
    data-arch="${esc(a.arch)}"
    data-variant="${esc(a.variant)}"
    data-search="${esc(searchKey)}"
    data-sort="${esc(sortKey)}"
    role="link" tabindex="0">
    <span class="c-version">
      ${ICONS.fileArchive}
      <span class="${verCls}">linux-${esc(a.version)}</span>
      ${newPill}
    </span>
    <span class="c-channel"><span class="chip">${esc(a.variant)}</span></span>
    <span class="c-arch"><span class="chip filled">${esc(a.arch)}</span></span>
    <span class="c-size mono">${esc(humanSize(a.size))}</span>
    <span class="c-built mono">${esc(humanDate(a.uploaded))}</span>
    <span class="c-sha">${
      sumsHref
        ? `<a class="sumslink mono" href="${esc(sumsHref)}" title="Download SHA256SUMS for this version" download>${esc(shortHash(a.etag))}</a>`
        : `<span class="mono muted">${esc(shortHash(a.etag))}</span>`
    }</span>
    <span class="c-dl"><a class="dlbtn" href="${dlHref}" download>${ICONS.download}<span>.kernel</span></a></span>
  </div>`;
}

function renderNotes(): string {
  return `<section class="notes">
    <div class="nL">
      ${ICONS.info}
      <span>All kernels are reproducibly built. Source open at <a href="${esc(REPO_URL)}" target="_blank" rel="noopener">github.com/loopholelabs/substrate-kernel</a>.</span>
    </div>
    <div class="nR">
      <a href="${esc(REPO_URL)}" target="_blank" rel="noopener">source ${ICONS.arrowUpRight}</a>
      <a href="${esc(DESIGN_DOC_URL)}" target="_blank" rel="noopener">build pipeline ${ICONS.arrowUpRight}</a>
      <a href="${esc(RELEASES_URL)}" target="_blank" rel="noopener">release notes ${ICONS.arrowUpRight}</a>
    </div>
  </section>`;
}

function renderFooter(): string {
  return `<footer class="site">
    <div class="fleft"><a href="https://loopholelabs.io" target="_blank" rel="noopener">© 2026 Loophole Labs</a></div>
    <div class="fmid">
      <a href="https://status.loopholelabs.io" target="_blank" rel="noopener">status</a>
      <a href="https://loopholelabs.io/privacy" target="_blank" rel="noopener">privacy</a>
      <a href="https://loopholelabs.io/terms" target="_blank" rel="noopener">terms</a>
    </div>
    <div class="fright">hello@loopholelabs.io</div>
  </footer>`;
}

// ---------------------------------------------------------------------------
// Analytics — the RudderStack v3 JS SDK loaded via a same-origin reverse
// proxy. Every URL the SDK touches is served from THIS worker under `/_data/`:
//
//   sdkBaseUrl       /_data           → cdn.rudderlabs.com/<pinned>/<build>/rsa.min.js
//                                       served as `client.min.js`
//   pluginsSDKBaseURL /_data/<build>/p → cdn.rudderlabs.com/<pinned>/<build>/plugins/*
//   configUrl        /_data           → synthesized response (matches
//                                       isValidSourceConfig in rudder-sdk-js)
//   dataPlaneUrl     /_data           → POSTs ride /_data/v1/<type>, which
//                                       the worker forwards to
//                                       <ANALYTICS_DATA_PLANE_URL>/v1/batch
//
// Why: EasyPrivacy ships `||rudderlabs.com^$third-party` (verified on
// `easylist/easyprivacy/easyprivacy_thirdparty.txt`), so default-uBlock
// browsers can't load the stock SDK; and `api.rudderstack.com/sourceConfig`
// 400s any writeKey not registered with RudderStack's hosted control plane.
// Pointing dataPlaneUrl at our own origin also dodges the per-event /v1/<type>
// vs /v1/batch CORS gap — the analytics ingest only allows CORS for /v1/batch,
// but the SDK's XhrQueue posts to /v1/<type>. Same-origin POST → no CORS,
// and the worker rewrites to /v1/batch upstream. docs/adr/0012, sdk-proxy.ts.
//
// Two preserved behaviours from the stock snippet:
//   - `.page()` on load.
//   - `.ready(...)` callback writes a first-party `substrate_aid` cookie
//     from `getAnonymousId()` so a same-origin `.kernel` download carries the
//     same anonymous id the proxy stamps server-side — correlates the page's
//     `kernel_download_click` with the server-side `kernel_download`.
// ---------------------------------------------------------------------------
function renderAnalytics(analytics: AnalyticsConfig | null): string {
  if (analytics === null) return '';
  // JSON.stringify → safe JS string literal for the (env-sourced) writeKey.
  // `dataPlaneUrl` is no longer passed from the env — the SDK gets the
  // same-origin `/_data` prefix and the worker rewrites POSTs to /v1/batch
  // on `ANALYTICS_DATA_PLANE_URL` server-side.
  const wk = JSON.stringify(analytics.writeKey);
  return `<script>
!function(){"use strict";window.RudderSnippetVersion="3.0.62";var identifier="rudderanalytics";window[identifier]||(window[identifier]=[]);var rudderanalytics=window[identifier];if(rudderanalytics.snippetExecuted)window.console&&console.error&&console.error("Analytics SDK snippet included more than once.");else{rudderanalytics.snippetExecuted=!0,window.rudderAnalyticsBuildType="legacy";var sdkBaseUrl=window.location.origin+"/_data";var sdkName="client.min.js";var scriptLoadingMode="async";var e=["setDefaultInstanceKey","load","ready","page","track","identify","alias","group","reset","setAnonymousId","startSession","endSession","consent"];for(var n=0;n<e.length;n++){var t=e[n];rudderanalytics[t]=function(e){return function(){var n=Array.prototype.slice.call(arguments);rudderanalytics.push([e].concat(n))}}(t)}try{new Function('class Test{field=()=>{};test({prop=[]}={}){return prop?(prop?.property??[...prop]):import("")}}'),window.rudderAnalyticsBuildType="modern"}catch(a){}var d=document.head||document.getElementsByTagName("head")[0],o=document.body||document.getElementsByTagName("body")[0];window.rudderAnalyticsAddScript=function(e,t,n){var i=document.createElement("script");i.src=e,t&&n&&i.setAttribute(t,n),i.async="async"===scriptLoadingMode,i.defer="defer"===scriptLoadingMode,d?d.insertBefore(i,d.firstChild):o.insertBefore(i,o.firstChild)},window.rudderAnalyticsMount=function(){window.rudderAnalyticsAddScript("".concat(sdkBaseUrl,"/").concat(window.rudderAnalyticsBuildType,"/").concat(sdkName),"data-rsa-write-key",${wk})};window.rudderAnalyticsMount();var origin=window.location.origin;rudderanalytics.load(${wk},origin+"/_data",{configUrl:origin+"/_data",pluginsSDKBaseURL:origin+"/_data/"+window.rudderAnalyticsBuildType+"/p",destSDKBaseURL:origin+"/_data/"+window.rudderAnalyticsBuildType+"/d",lockPluginsVersion:true,lockIntegrationsVersion:true});rudderanalytics.page();rudderanalytics.ready(function(){try{document.cookie="substrate_aid="+rudderanalytics.getAnonymousId()+"; path=/; max-age=31536000; samesite=lax; secure"}catch(e){}})}}();
</script>`;
}

// ---------------------------------------------------------------------------
// Inline SVG icons (copied pattern from the bench dashboard — keeps the
// page self-contained, no font CDN beyond Google Fonts).
// ---------------------------------------------------------------------------
const ICONS = {
  arrowLeft:
    '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  arrowUpRight:
    '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M12 .5C5.4.5 0 5.9 0 12.6c0 5.3 3.4 9.8 8.2 11.4.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.9 2.8 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2 1-.3 2-.4 3-.4s2 .1 3 .4c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6C20.6 22.4 24 17.9 24 12.6 24 5.9 18.6.5 12 .5z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  chevronDown:
    '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="m6 9 6 6 6-6"/></svg>',
  fileArchive:
    '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M10 12v6"/><path d="M10 12h.01"/></svg>',
  download:
    '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
  info: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
} as const;

// ---------------------------------------------------------------------------
// CSS — color tokens + fonts + responsive breakpoints lifted from the
// bench dashboard so the two pages share an identity. New tokens
// (--info, --accent-10, --accent-20) and table-grid styles added below.
// ---------------------------------------------------------------------------
const PAGE_CSS = `
:root {
  --bg: #0a0a0a;
  --bg-card: #0f0f0f;
  --border: #262626;
  --secondary: #1a1a1a;
  --fg: #e5e5e5;
  --fg-80: #e5e5e5cc;
  --fg-60: #e5e5e599;
  --fg-20: #e5e5e533;
  --muted: #737373;
  --success: #4ade80;
  --info: #60a5fa;
  --accent: #4ade80;
  --accent-10: #4ade8014;
  --accent-20: #4ade8033;
  --ring: #404040;
  --sans: "Geist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
  --maxw: 1200px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  line-height: 1.5;
}
a { color: inherit; text-decoration: none; }
.mono { font-family: var(--mono); }
.muted { color: var(--muted); }

/* ---- Header ---- */
header.site {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: rgba(10,10,10,0.85);
  backdrop-filter: blur(8px);
  z-index: 10;
}
.logo { display: flex; align-items: center; gap: 8px; font-family: var(--mono); }
.logo .mark { color: var(--muted); font-size: 14px; }
.logo .word { color: var(--fg); font-size: 14px; font-weight: 700; letter-spacing: 1.5px; }
nav.top { display: flex; align-items: center; gap: 24px; font-family: var(--mono); font-size: 14px; }
nav.top a { color: var(--muted); transition: color .15s; }
nav.top a:hover { color: var(--fg-80); }

/* ---- Layout ---- */
main { padding: 48px 24px; display: flex; justify-content: center; }
.inner { width: 100%; max-width: var(--maxw); display: flex; flex-direction: column; gap: 32px; }

/* ---- Hero ---- */
.hero { display: flex; flex-direction: column; gap: 10px; }
.backrow { display: flex; align-items: center; gap: 8px; color: var(--muted); font-family: var(--mono); font-size: 12px; }
.titlerow { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.titleL { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
h1 { font-size: 36px; font-weight: 600; margin: 4px 0 0; letter-spacing: -0.5px; }
.subtitle { color: var(--muted); font-size: 16px; max-width: 680px; line-height: 1.6; margin: 0; }
.repolink { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-family: var(--mono); font-size: 12px; transition: color .15s; }
.repolink:hover { color: var(--fg); }

/* ---- Toolbar ---- */
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.tbL { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tbR { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.search { display: inline-flex; align-items: center; gap: 8px; background: var(--bg-card); border: 1px solid var(--border); padding: 8px 12px; width: 320px; max-width: 100%; transition: border-color .15s; }
.search:focus-within { border-color: var(--ring); }
.search svg { color: var(--muted); flex-shrink: 0; }
.search input { background: transparent; border: 0; outline: 0; color: var(--fg-80); font-family: var(--mono); font-size: 12px; width: 100%; }
.search input::placeholder { color: var(--muted); }
.seg { display: flex; border: 1px solid var(--border); }
.seg button {
  font-family: var(--mono); font-size: 11px; color: var(--muted); background: transparent;
  border: none; padding: 7px 12px; cursor: pointer; transition: color .15s, background .15s; white-space: nowrap;
}
.seg button:hover { color: var(--fg-80); }
.seg button.active { background: var(--secondary); color: var(--fg); }
.sort { display: inline-flex; align-items: center; gap: 6px; background: transparent; border: 1px solid var(--border); padding: 7px 12px; cursor: pointer; transition: color .15s; color: var(--fg-80); }
.sort:hover { color: var(--fg); }
.sort .k { color: var(--muted); font-family: var(--mono); font-size: 11px; }
.sort .v { color: var(--fg-80); font-family: var(--mono); font-size: 11px; }
.sort svg { color: var(--muted); }

/* ---- Featured ---- */
.featured {
  background: var(--bg-card); border: 1px solid var(--border); padding: 24px;
  display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap;
}
.featured.empty { justify-content: center; padding: 40px; color: var(--muted); font-family: var(--mono); font-size: 13px; }
.ftL { display: flex; flex-direction: column; gap: 10px; flex: 1 1 480px; min-width: 0; }
.ftRow1 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.badge { font-family: var(--mono); font-size: 10px; font-weight: 500; color: var(--accent); letter-spacing: 1.5px; padding: 3px 8px; background: var(--accent-10); border: 1px solid var(--accent-20); }
.ftRow1 .v { font-family: var(--mono); font-size: 18px; font-weight: 700; color: var(--fg); }
.ftRow1 .rel { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.ftBody { font-size: 13px; color: var(--fg-80); line-height: 1.55; margin: 0; max-width: 620px; }
.ftMeta { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.ftMeta .kv { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; }
.ftMeta .kv .k { color: var(--muted); }
.ftMeta .kv .v { color: var(--fg-80); }
.ftR { display: flex; flex-direction: column; gap: 10px; align-items: flex-end; }
.dlgroup { display: inline-flex; border: 1px solid var(--border); }
.dl { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; font-family: var(--mono); font-size: 12px; color: var(--fg-80); cursor: pointer; transition: color .15s, background .15s; }
.dl + .dl { border-left: 1px solid var(--border); }
.dl.primary { background: var(--fg); color: var(--bg); }
.dl.primary:hover { background: var(--fg-80); }
.dl:not(.primary):hover { color: var(--fg); background: var(--secondary); }
.ftNav { display: flex; align-items: center; gap: 12px; font-family: var(--mono); font-size: 11px; }
.ftNav a { color: var(--muted); transition: color .15s; }
.ftNav a:hover { color: var(--fg); }

/* ---- Table ---- */
.table { border: 1px solid var(--border); display: flex; flex-direction: column; }
.table.empty { padding: 40px; align-items: center; color: var(--muted); font-family: var(--mono); font-size: 13px; }
.trow {
  display: grid; align-items: center; gap: 16px; padding: 12px 18px;
  grid-template-columns: minmax(160px, 1fr) 110px 100px 80px 110px 170px 110px;
  border-bottom: 1px solid var(--border);
  transition: background .12s;
}
.trow:last-child { border-bottom: none; }
.trow.thead {
  padding: 10px 18px;
  background: transparent;
  font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: 1.5px;
  color: var(--muted); text-transform: uppercase;
}
.trow.tsection {
  background: var(--secondary);
  padding: 10px 18px;
  grid-template-columns: auto 1fr;
}
.trow.tsection .t { font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: 1.5px; color: var(--fg-80); text-transform: uppercase; }
.trow.tsection .d { font-family: var(--mono); font-size: 10px; color: var(--muted); justify-self: end; }
.trow.tartifact { color: var(--fg-80); cursor: pointer; }
.trow.tartifact:hover { background: var(--secondary); color: var(--fg); }
.trow.tartifact .c-version { display: inline-flex; align-items: center; gap: 8px; min-width: 0; font-family: var(--mono); font-size: 13px; }
.trow.tartifact .c-version .mono { color: var(--fg-80); font-weight: normal; }
.trow.tartifact .c-version .mono.active { color: var(--fg); font-weight: 500; }
.trow.tartifact .c-version svg { color: var(--muted); flex-shrink: 0; }
.trow.tartifact:hover .c-version svg { color: var(--fg-80); }
.newpill { font-family: var(--mono); font-size: 9px; font-weight: 500; color: var(--accent); letter-spacing: 1px; padding: 2px 6px; background: var(--accent-10); border: 1px solid var(--accent-20); }
.chip { display: inline-flex; align-items: center; padding: 3px 8px; font-family: var(--mono); font-size: 10px; color: var(--fg-80); border: 1px solid var(--border); }
.chip.filled { background: var(--secondary); border-color: transparent; }
.c-size, .c-built { font-size: 12px; color: var(--fg-80); }
.c-built { color: var(--muted); }
.c-sha { min-width: 0; }
.sumslink { display: inline-block; font-size: 12px; color: var(--muted); border-bottom: 1px dashed transparent; transition: color .15s, border-color .15s; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.sumslink:hover { color: var(--fg); border-bottom-color: var(--ring); }
.c-dl { justify-self: end; }
.dlbtn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--fg); transition: background .15s, border-color .15s, color .15s; text-decoration: none; }
.dlbtn:hover { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.trow.tartifact:hover .dlbtn { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.trow.tartifact:focus { outline: 1px solid var(--ring); outline-offset: -1px; }
.trow.hidden { display: none; }

/* ---- Notes ---- */
.notes { background: var(--bg-card); border: 1px solid var(--border); padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.nL { display: inline-flex; align-items: center; gap: 10px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.nL svg { color: var(--info); flex-shrink: 0; }
.nL a { color: var(--fg-80); border-bottom: 1px dashed var(--border); transition: color .15s, border-color .15s; }
.nL a:hover { color: var(--fg); border-bottom-color: var(--ring); }
.nR { display: inline-flex; align-items: center; gap: 12px; }
.nR a { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 11px; color: var(--fg-80); transition: color .15s; }
.nR a svg { color: var(--muted); }
.nR a:hover { color: var(--fg); }
.nR a:hover svg { color: var(--fg-80); }

/* ---- Footer ---- */
footer.site {
  height: 48px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
  padding: 12px 24px; border-top: 1px solid var(--border);
}
footer .fleft { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
footer .fmid { display: flex; align-items: center; gap: 16px; font-family: var(--mono); font-size: 11px; }
footer .fmid a { color: var(--muted); }
footer .fmid a:hover { color: var(--fg-80); }
footer .fleft a { color: inherit; }
footer .fleft a:hover { color: var(--fg-80); }
footer .fright { font-size: 12px; color: var(--muted); }

/* ---- Responsive ---- */
@media (max-width: 900px) {
  main { padding: 32px 16px; }
  h1 { font-size: 30px; }
  nav.top { gap: 16px; }
  /* Drop SHA + BUILT columns at narrow widths — they're recoverable via the artifact URL. */
  .trow { grid-template-columns: minmax(120px, 1fr) 90px 90px 70px 90px; gap: 12px; padding: 10px 14px; }
  .c-built, .c-sha { display: none; }
  .featured { padding: 20px; }
  .ftR { align-items: flex-start; width: 100%; }
  .dlgroup { width: 100%; }
  .dl { flex: 1; justify-content: center; }
}
@media (max-width: 560px) {
  /* Drop CHANNEL too. Just VERSION ARCH SIZE Download. */
  .trow { grid-template-columns: minmax(110px, 1fr) 80px 64px 88px; gap: 10px; padding: 10px 12px; }
  .c-channel { display: none; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .tbL, .tbR { width: 100%; justify-content: space-between; }
  .search { width: 100%; }
  /* Keep the featured card compact when it stacks: tighter rhythm and drop
     the per-arch hash row (recoverable from the table / the artifact URL).
     Reset .ftL's flex-basis (480px) to auto — in column mode that basis would
     become a height-basis, forcing the card hundreds of px tall and pushing
     .ftR to the bottom via the outer justify-content: space-between. */
  .featured { flex-direction: column; align-items: stretch; justify-content: flex-start; gap: 14px; }
  .ftL { flex: 0 0 auto; gap: 8px; }
  .ftMeta { display: none; }
  .ftR { align-items: stretch; gap: 10px; }
  .ftNav { justify-content: space-between; width: 100%; flex-wrap: wrap; }
  .titlerow .repolink { display: none; }
}
`;

// ---------------------------------------------------------------------------
// Client-side JS: search / arch filter / sort over the rendered DOM.
// No fetch, no re-render — toggles `.hidden` and reorders DOM children.
// ---------------------------------------------------------------------------
const PAGE_JS = `
(function () {
  "use strict";
  var tbl = document.getElementById("tbl");
  if (!tbl) return;
  var q = document.getElementById("q");
  var segArch = document.getElementById("seg-arch");
  var sortBtn = document.getElementById("sort-btn");
  var sortV = document.getElementById("sort-v");

  var state = { q: "", arch: "", sort: "newest" };

  // ---- analytics (all no-ops unless the RudderStack SDK was injected) ----
  // window.rudderanalytics is either the loaded SDK or the buffering stub
  // (an array whose .track queues until the SDK loads) — both have .track.
  function ra() {
    return (window.rudderanalytics &&
      typeof window.rudderanalytics.track === "function")
      ? window.rudderanalytics : null;
  }
  function track(name, props) {
    var r = ra();
    if (r) { try { r.track(name, props); } catch (e) {} }
  }
  // Map a download href to its analytics event. Mirrors the server router
  // patterns so the page and the proxy agree on package/version/arch.
  function trackDownloadHref(href) {
    var km = /^\\/linux-(\\d+\\.\\d+\\.\\d+)-([a-z]+)-([a-z0-9_]+)\\.kernel$/.exec(href || "");
    if (km) {
      track("kernel_download_click", { package: "linux-" + km[2] + "-" + km[3], version: km[1], arch: km[3] });
      return;
    }
    var sm = /^\\/linux-(\\d+\\.\\d+\\.\\d+)-SHA256SUMS$/.exec(href || "");
    if (sm) { track("sha256sums_download", { version: sm[1] }); }
  }
  // Capture phase: catch every download anchor (featured card, per-row sha
  // link, per-row .kernel button) before the browser navigates. The SDK's
  // beacon transport flushes the event on unload, so fire-and-forget is safe.
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var a = t.closest("a[href]");
    if (a) trackDownloadHref(a.getAttribute("href"));
  }, true);
  var searchTimer = null;

  // Row-click: trigger the row's primary download. The inner <a> tags
  // (.sumslink, .dlbtn) handle their own clicks — closest(".trow") will
  // still match, so guard against re-firing by checking the original
  // target.
  tbl.addEventListener("click", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("a")) return; // an inner <a> handled it
    var row = t.closest(".tartifact");
    if (!row) return;
    var href = row.getAttribute("data-dl");
    if (href) { trackDownloadHref(href); window.location.href = href; }
  });
  // Keyboard activation for the role=link rows.
  tbl.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var t = e.target;
    if (!(t instanceof Element)) return;
    var row = t.closest(".tartifact");
    if (!row || t !== row) return;
    var href = row.getAttribute("data-dl");
    if (href) {
      e.preventDefault();
      trackDownloadHref(href);
      window.location.href = href;
    }
  });

  function rows() {
    return Array.prototype.slice.call(tbl.querySelectorAll(".tartifact"));
  }

  function applyFilter() {
    var needle = state.q.trim().toLowerCase();
    var counts = {};
    rows().forEach(function (r) {
      var matchesArch = state.arch === "" || r.dataset.arch === state.arch;
      var matchesQ = needle === "" || (r.dataset.search || "").indexOf(needle) !== -1;
      var visible = matchesArch && matchesQ;
      r.classList.toggle("hidden", !visible);
      var line = r.dataset.line || "";
      counts[line] = counts[line] || 0;
      if (visible) counts[line] = counts[line] + 1;
    });
    // Hide section headers whose group has no visible rows.
    Array.prototype.slice.call(tbl.querySelectorAll(".tsection")).forEach(function (s) {
      var line = s.dataset.line || "";
      s.classList.toggle("hidden", (counts[line] || 0) === 0);
    });
  }

  function applySort() {
    var parent = tbl;
    var ordered = rows().slice().sort(function (a, b) {
      var ak = (a.dataset.sort || "").split("|");
      var bk = (b.dataset.sort || "").split("|");
      var va = ak[0] || "";
      var vb = bk[0] || "";
      var ta = Number(ak[2] || "0");
      var tb = Number(bk[2] || "0");
      if (state.sort === "newest") {
        // newest version first, then newest upload time, then arch
        var cmp = compareSemver(vb, va);
        if (cmp !== 0) return cmp;
        if (tb !== ta) return tb - ta;
        return (ak[1] || "").localeCompare(bk[1] || "");
      } else {
        // oldest first
        var cmp2 = compareSemver(va, vb);
        if (cmp2 !== 0) return cmp2;
        if (ta !== tb) return ta - tb;
        return (ak[1] || "").localeCompare(bk[1] || "");
      }
    });
    // Reorder: keep section headers in place; just rearrange artifact
    // rows within each section. The section headers stay anchored to
    // their data-line attribute, so we move artifact rows under their
    // matching section.
    var sections = {};
    Array.prototype.slice.call(parent.querySelectorAll(".tsection")).forEach(function (s) {
      sections[s.dataset.line || ""] = s;
    });
    ordered.forEach(function (r) {
      var line = r.dataset.line || "";
      var section = sections[line];
      if (!section) return;
      parent.insertBefore(r, section.nextSibling);
      // shift the section pointer so successive rows land in the right order
      sections[line] = r;
    });
    // Restore the original section→row anchor for subsequent sorts.
    Array.prototype.slice.call(parent.querySelectorAll(".tsection")).forEach(function (s) {
      sections[s.dataset.line || ""] = s;
    });
  }

  function compareSemver(a, b) {
    var pa = a.split(".").map(Number);
    var pb = b.split(".").map(Number);
    for (var i = 0; i < 3; i++) {
      var av = pa[i] || 0;
      var bv = pb[i] || 0;
      if (av !== bv) return av < bv ? -1 : 1;
    }
    return 0;
  }

  if (q) {
    q.addEventListener("input", function () {
      state.q = q.value || "";
      applyFilter();
      // Debounced so we record the settled query, not every keystroke.
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        var query = state.q.trim();
        if (query.length > 0) track("kernel_search", { query: query });
      }, 500);
    });
  }
  if (segArch) {
    segArch.addEventListener("click", function (e) {
      var t = e.target;
      if (!(t instanceof HTMLElement)) return;
      var btn = t.closest("button[data-arch]");
      if (!btn) return;
      state.arch = btn.getAttribute("data-arch") || "";
      Array.prototype.slice.call(segArch.querySelectorAll("button")).forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      applyFilter();
    });
  }
  if (sortBtn && sortV) {
    sortBtn.addEventListener("click", function () {
      state.sort = state.sort === "newest" ? "oldest" : "newest";
      sortV.textContent = state.sort;
      applySort();
    });
  }
})();
`;
