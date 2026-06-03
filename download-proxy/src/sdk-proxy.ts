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
 * Three routes, all served first-party from the download-proxy worker:
 *
 *   GET /_data/<build>/client.min.js          → cdn.rudderlabs.com/<v>/<build>/rsa.min.js
 *   GET /_data/<build>/p/<file>               → cdn.rudderlabs.com/<v>/<build>/plugins/<file>
 *   GET /_data/sourceConfig/?writeKey=<k>     → synthesized JSON
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

/** Anything else under `/_data/`. */
const PATH_PREFIX = /^\/_data\//;

export interface SdkProxyRoute {
  kind: 'sdk-file' | 'plugin-file' | 'source-config';
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
  if (route.kind === 'source-config') return serveSourceConfig(env, request);
  // sdk-file / plugin-file
  if (route.upstream === undefined) return null;
  return await proxySdkFile(route.upstream);
}
