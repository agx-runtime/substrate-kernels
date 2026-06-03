/**
 * First-party reverse proxy for the RudderStack v3 SDK. Same origin as the
 * listing page (kernels.agx.so / kernels.substrate.loopholelabs.io), so:
 *
 *   - EasyPrivacy's `||rudderlabs.com^$third-party` rule (which blocks the
 *     stock CDN script when served to any non-rudderlabs.com page) cannot
 *     match — the requests go to OUR origin.
 *   - The SDK never reaches `api.rudderstack.com` for source config (which
 *     would 400 for our writeKeys — they live in our analytics-side KV, not
 *     RudderStack's hosted control plane). We synthesize the response per
 *     the SDK's `isValidSourceConfig` validator
 *     (`rudder-sdk-js`, `packages/analytics-js/src/components/configManager/util/validate.ts`).
 *
 * Four routes, all served first-party from the download-proxy worker:
 *
 *   GET  /_data/<build>/client.min.js          → cdn.rudderlabs.com/<v>/<build>/rsa.min.js
 *   GET  /_data/<build>/p/<file>               → cdn.rudderlabs.com/<v>/<build>/plugins/<file>
 *   GET  /_data/sourceConfig/?writeKey=<k>     → synthesized JSON
 *   POST /_data/v1/<type>                      → data.agx.so/v1/batch (event ingest)
 *
 * The `/v1/<type>` route exists because the SDK's `XhrQueue` plugin (default
 * events transport) builds `${dataPlaneUrl}/v1/${type}` per event, where
 * `type` ∈ `{track, page, identify, group, ...}`. Our analytics ingest only
 * accepts `/v1/batch`, and only sets CORS for that one path. By rewriting
 * everything to `/v1/batch` on the worker and using same-origin POSTs from
 * the page (`dataPlaneUrl = window.location.origin + "/_data"`), we avoid
 * the CORS preflight entirely AND get every URL onto a first-party origin.
 *
 * docs/adr/0012, docs/design/download-proxy.md.
 */

import type { Env } from './types.ts';

// ---------------------------------------------------------------------------
// Pinned SDK version. CDN serves both `v3/<build>/rsa.min.js` (moving latest)
// and `<version>/<build>/rsa.min.js`; we pin so a control-plane schema bump
// across SDK releases is a reviewed change, not silent drift. Verified live:
// 3.31.2/{modern,legacy}/rsa.min.js + 3.31.2/modern/plugins/* all serve 200.
// ---------------------------------------------------------------------------
const PINNED_SDK_VERSION = '3.31.2';
const SDK_ORIGIN = 'https://cdn.rudderlabs.com';

// Aggressive cache for the SDK + plugin files. The pin makes these
// content-stable forever; if we ever bump PINNED_SDK_VERSION, the URLs the
// page injects change too, so cached old responses naturally fall off.
const CACHE_SDK_FILE = 'public, max-age=86400, immutable';

// 5-min cache on the synthesized source-config response. The response is
// byte-stable per writeKey (we use a frozen `updatedAt`), so CF edge caches
// it efficiently. Short TTL leaves room for a future writeKey rotation.
const CACHE_SOURCE_CONFIG = 'public, max-age=300';

// ---------------------------------------------------------------------------
// Path validation. Defense in depth against open-proxy abuse: the worker
// only fetches upstream when the path strictly matches one of the patterns
// below, with no traversal sequences or query strings reaching upstream.
// ---------------------------------------------------------------------------

/** `/_data/modern/client.min.js` or `/_data/legacy/client.min.js`. */
const PATH_SDK_FILE = /^\/_data\/(?<build>modern|legacy)\/client\.min\.js$/;

/** `/_data/modern/p/<file>` — `<file>` is a plugin chunk emitted by the SDK. */
const PATH_PLUGIN_FILE =
  /^\/_data\/(?<build>modern|legacy)\/p\/(?<file>[A-Za-z0-9._-]+\.js)$/;

/** `/_data/sourceConfig/` — the SDK appends `/sourceConfig/` to `configUrl`. */
const PATH_SOURCE_CONFIG = /^\/_data\/sourceConfig\/?$/;

/**
 * `/_data/v1/<type>` — the SDK's XhrQueue posts per-event to `/v1/<type>`
 * (track/page/identify/group/…). We forward to `data.agx.so/v1/batch`,
 * which accepts both the single-message and the wrapped-batch shapes per
 * `analytics/docs/spec/wire-format.md`. Lowercase-only matches the event
 * types the SDK emits — anything else is 404.
 */
const PATH_ANALYTICS_INGEST = /^\/_data\/v1\/[a-z]+$/;

/** Anything else under `/_data/`. */
const PATH_PREFIX = /^\/_data\//;

export interface SdkProxyRoute {
  kind: 'sdk-file' | 'plugin-file' | 'source-config' | 'analytics-ingest';
  upstream?: string;
}

/** Classify `/_data/...` paths. Returns null for unknown shapes. */
export function classifySdkPath(pathname: string): SdkProxyRoute | null {
  const sdk = PATH_SDK_FILE.exec(pathname);
  if (sdk?.groups?.build) {
    return {
      kind: 'sdk-file',
      upstream: `${SDK_ORIGIN}/${PINNED_SDK_VERSION}/${sdk.groups.build}/rsa.min.js`,
    };
  }
  const plugin = PATH_PLUGIN_FILE.exec(pathname);
  if (plugin?.groups?.build && plugin.groups.file) {
    return {
      kind: 'plugin-file',
      upstream: `${SDK_ORIGIN}/${PINNED_SDK_VERSION}/${plugin.groups.build}/plugins/${plugin.groups.file}`,
    };
  }
  if (PATH_SOURCE_CONFIG.test(pathname)) return { kind: 'source-config' };
  if (PATH_ANALYTICS_INGEST.test(pathname)) return { kind: 'analytics-ingest' };
  return null;
}

/** Does this path belong to the SDK reverse proxy? */
export function isSdkProxyPath(pathname: string): boolean {
  return PATH_PREFIX.test(pathname);
}

// ---------------------------------------------------------------------------
// Source-config synthesizer. Mirrors the SDK team's own mock
// (`rudder-sdk-js/examples/utils/mock-servers/control-plane.js`) with one
// substantive change: `statsCollection.{errors,metrics}.enabled = false` so
// the SDK does NOT spin up the `/rsaMetrics` error-reporting plugin (which
// would POST to our data plane on an endpoint the analytics ingest doesn't
// implement).
//
// `updatedAt` is a frozen epoch so the response is byte-stable per writeKey
// — the CF edge cache and downstream `If-None-Match` round-trips work
// without writeKey-specific cache fragmentation.
// ---------------------------------------------------------------------------

interface SourceConfigInput {
  writeKey: string;
  hostname: string;
}

function buildSourceConfig({ writeKey, hostname }: SourceConfigInput): string {
  const stamp = '1970-01-01T00:00:00.000Z';
  return JSON.stringify({
    source: {
      id: writeKey,
      name: hostname,
      writeKey,
      enabled: true,
      workspaceId: 'substrate-kernel',
      destinations: [],
      config: {
        statsCollection: {
          errors: { enabled: false },
          metrics: { enabled: false },
        },
      },
      updatedAt: stamp,
    },
    updatedAt: stamp,
  });
}

/**
 * Look up the `ANALYTICS_WRITE_KEYS` host→key map and return the set of
 * acceptable writeKeys. Any of our configured per-host write keys is valid
 * for the source-config endpoint — write keys are not secrets (analytics
 * ADR 0010) and we just need to reject garbage / abusive lookups.
 */
function knownWriteKeys(env: Env): Set<string> {
  const raw = env.ANALYTICS_WRITE_KEYS;
  if (!raw) return new Set();
  let map: unknown;
  try {
    map = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (typeof map !== 'object' || map === null) return new Set();
  const out = new Set<string>();
  for (const v of Object.values(map as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out.add(v);
  }
  return out;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Serve the synthesized source-config response. Returns 401 if the writeKey
 * is missing or not one of our configured per-host keys.
 */
export function serveSourceConfig(env: Env, request: Request): Response {
  const url = new URL(request.url);
  const writeKey = url.searchParams.get('writeKey');
  if (writeKey === null || writeKey.length === 0) {
    return jsonError(401, 'missing writeKey');
  }
  const known = knownWriteKeys(env);
  if (!known.has(writeKey)) {
    return jsonError(401, 'unknown writeKey');
  }
  const body = buildSourceConfig({ writeKey, hostname: url.hostname });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': CACHE_SOURCE_CONFIG,
    },
  });
}

// ---------------------------------------------------------------------------
// CDN proxy. `fetch(upstream)` with CF's edge cache so the same bytes are
// served from the closest PoP after the first request. Pass through the
// upstream status and a minimal set of safe headers; stamp our own
// long-lived Cache-Control because the version is pinned.
// ---------------------------------------------------------------------------

const PASSTHROUGH_HEADERS = ['content-type', 'content-encoding', 'content-length'] as const;

export async function proxySdkFile(upstream: string): Promise<Response> {
  const res = await fetch(upstream, {
    method: 'GET',
    cf: { cacheTtl: 86400, cacheEverything: true } as RequestInitCfProperties,
  });
  // Upstream miss → propagate as 404 (the pinned version is supposed to
  // exist; a real 404 here is a bug to investigate, not a silent retry).
  if (!res.ok) {
    return new Response('Not found', { status: res.status });
  }
  const headers = new Headers();
  for (const h of PASSTHROUGH_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  headers.set('Cache-Control', CACHE_SDK_FILE);
  headers.set('Vary', 'Accept-Encoding');
  return new Response(res.body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Analytics ingest forwarder. Rewrites every `/_data/v1/<type>` POST onto
// `${dataPlane}/v1/batch`. The analytics ingest's `parseBatch` accepts a
// single-message body (`{type:"page",…}`) directly, so no body rewrite is
// needed (analytics/docs/spec/wire-format.md "Single form").
//
// Authorization (Basic <writeKey:>) and Content-Type are forwarded verbatim.
// `CF-Connecting-IP` is forwarded so the analytics ingest's per-IP rate
// limit and ip_* enrichment see the END USER's IP, not our worker's egress.
// ---------------------------------------------------------------------------

const DEFAULT_DATA_PLANE_URL = 'https://data.agx.so';

const FORWARD_HEADERS = [
  'authorization',
  'content-type',
  'cf-connecting-ip',
  'user-agent',
  'accept-language',
] as const;

/**
 * Drop empty-string identity fields before forwarding to the analytics
 * ingest. The RudderStack v3 SDK initializes `userId` (and sometimes
 * `groupId` / `context.groupId`) to `""` when no `identify()` / `group()`
 * call has been made and sends them on every payload. The ingest's
 * validator (`packages/shared/src/validation.ts::optionalBoundedString`)
 * treats `null`/`undefined` as "absent" but `""` as INVALID → 400
 * `batch[N].userId invalid`. Stripping the empty strings here turns them
 * into absent fields, which is what they semantically are. Non-empty
 * strings pass through untouched. The wire format (see `wire-format.md`)
 * accepts both the wrapped `{batch:[...]}` and single-message shapes.
 */
const NULLISH_IDENTITY_FIELDS = ['userId', 'groupId'] as const;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function sanitizeMessage(msg: unknown): unknown {
  if (!isPlainObject(msg)) return msg;
  const out: Record<string, unknown> = { ...msg };
  for (const k of NULLISH_IDENTITY_FIELDS) {
    if (out[k] === '' || out[k] === null) delete out[k];
  }
  // `groupId` on track/page rides in `context.groupId` (Segment conv).
  if (isPlainObject(out.context)) {
    const ctx = { ...out.context };
    if (ctx.groupId === '' || ctx.groupId === null) delete ctx.groupId;
    out.context = ctx;
  }
  return out;
}

export function sanitizeBody(parsed: unknown): unknown {
  if (isPlainObject(parsed) && Array.isArray(parsed.batch)) {
    return { ...parsed, batch: parsed.batch.map(sanitizeMessage) };
  }
  return sanitizeMessage(parsed);
}

export async function proxyAnalyticsIngest(
  env: Env,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }
  const base = (env.ANALYTICS_DATA_PLANE_URL || DEFAULT_DATA_PLANE_URL).replace(
    /\/+$/,
    '',
  );
  const upstream = `${base}/v1/batch`;
  const headers = new Headers();
  for (const h of FORWARD_HEADERS) {
    const v = request.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  // Buffer + sanitize. SDK web payloads are small (< 1 KiB typical, well
  // under the ingest's 1 MiB cap), so the cost is negligible. A malformed
  // JSON body is forwarded verbatim so the ingest's own 400 is what the
  // SDK sees (no swallowing of validation failures by the proxy).
  const raw = await request.text();
  let body = raw;
  try {
    const parsed = JSON.parse(raw);
    body = JSON.stringify(sanitizeBody(parsed));
    headers.set('Content-Length', String(new TextEncoder().encode(body).byteLength));
  } catch {
    // Not JSON — let the ingest reject it.
  }
  const upstreamRes = await fetch(upstream, {
    method: 'POST',
    headers,
    body,
  });
  // Propagate the upstream status + body. Don't pass through upstream
  // headers wholesale (CORS / set-cookie / etc.); same-origin POST from
  // our page → no CORS headers needed.
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: { 'Content-Type': upstreamRes.headers.get('content-type') ?? 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Single entry point used by index.ts.
// ---------------------------------------------------------------------------

/**
 * Dispatch one `/_data/...` request to the right handler. Returns null if
 * the path matches the prefix but no specific route — the caller should 404.
 */
export async function serveSdkProxy(
  env: Env,
  request: Request,
): Promise<Response | null> {
  const route = classifySdkPath(new URL(request.url).pathname);
  if (route === null) return null;
  // /_data/v1/* is POST-only; the helper enforces and rejects others.
  if (route.kind === 'analytics-ingest') return await proxyAnalyticsIngest(env, request);
  // Everything else is GET / HEAD.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    });
  }
  if (route.kind === 'source-config') return serveSourceConfig(env, request);
  if (route.upstream === undefined) return null;
  return await proxySdkFile(route.upstream);
}
