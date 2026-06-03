/**
 * substrate-kernel download proxy. A thin Cloudflare Worker bound at
 * `kernels.substrate.loopholelabs.io` and `kernels.agx.so` that serves
 * `.kernel` bundles + SHA256SUMS from R2 and emits one `kernel_download`
 * event per successful full download into the analytics events queue. The
 * `/` listing page also loads the RudderStack SDK (docs/adr/0012) so page
 * views / searches / download-clicks land in the same pipeline.
 *
 * Substrate-kernel CLAUDE.md §1: substrate-native naming; the artifact
 * we serve is the *kernel bundle* (the SUBK header + payload), produced
 * by this repo's build pipeline and pushed to R2 by release.yml.
 *
 * The analytics event conforms to the queue contract at
 * https://github.com/loopholelabs/analytics/blob/main/docs/spec/queue-protocol.md.
 * The producer is implemented locally in `./analytics.ts` per analytics
 * ADR 0015's first-class hand-roll path — substrate-kernel takes no
 * cross-repo dependency on the analytics monorepo.
 *
 * docs/design/download-proxy.md is authoritative.
 */

import { recordDownload } from './analytics.ts';
import { renderListingHtml } from './html.ts';
import { type Listing, listKernels } from './listing.ts';
import { serveFromR2 } from './r2.ts';
import { checkRateLimit } from './ratelimit.ts';
import { parsePath } from './router.ts';
import { isSdkProxyPath, serveSdkProxy } from './sdk-proxy.ts';
import type { AnalyticsConfig, Env } from './types.ts';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Per-IP rate limit, BEFORE routing — scan traffic on garbage paths
    // also counts against the bucket so a probe-and-back-off attack can't
    // bypass the limiter by varying the path.
    const ip = request.headers.get('CF-Connecting-IP');
    const limit = await checkRateLimit(env, ip);
    if (!limit.ok) {
      return new Response('Rate limited', {
        status: limit.status,
        headers: { 'Retry-After': String(limit.retryAfter) },
      });
    }

    const url = new URL(request.url);

    // GET/HEAD `/` → render the kernels listing page from R2. No
    // analytics emit (it's not a kernel download). 5-min edge cache via
    // Cache-Control + an ETag derived from the bucket state so repeat
    // hits short-circuit at the CF edge or via If-None-Match.
    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return await serveListing(request, env);
    }

    // First-party RudderStack SDK reverse proxy (docs/adr/0012). Routed
    // BEFORE the R2 fall-through so an unknown `/_data/...` shape returns
    // 404 instead of trying to read an R2 key. The reverse-proxy itself
    // enforces method per route (GET for the CDN/sourceConfig routes,
    // POST for the /_data/v1/* event-ingest forwarder). No analytics emit
    // (the proxy routes are infrastructure, not kernel downloads).
    if (isSdkProxyPath(url.pathname)) {
      const sdk = await serveSdkProxy(env, request);
      return sdk ?? new Response('Not found', { status: 404 });
    }

    const parsed = parsePath(url.pathname);
    if (parsed === null) return new Response('Not found', { status: 404 });

    const response = await serveFromR2({
      env,
      key: parsed.r2_key,
      contentType: parsed.content_type,
      request,
    });

    // Emit exactly one event per FULL download — never on HEAD (metadata),
    // 206 (one chunk of a resumable download — would over-count), 404, or
    // 405. The library swallows queue failures so an analytics outage
    // cannot block a kernel download.
    if (request.method === 'GET' && response.status === 200) {
      ctx.waitUntil(
        recordDownload(request, env, {
          package: parsed.package,
          version: parsed.version,
          bytes: Number(response.headers.get('Content-Length')) || 0,
        }),
      );
    }

    return response;
  },
} satisfies ExportedHandler<Env>;

/**
 * Serve the `/` listing page. Reads R2 once, renders HTML, sets cache +
 * ETag headers, honors `If-None-Match` for 304. HEAD returns the same
 * headers with no body.
 */
async function serveListing(request: Request, env: Env): Promise<Response> {
  const listing = await listKernels(env);
  const hostname = new URL(request.url).hostname;
  const analytics = resolveAnalytics(env, hostname);
  // The page HTML embeds a per-host write key, so fold the host into the
  // ETag — otherwise two hosts would share an ETag for different bodies.
  const etag = listingEtag(listing, hostname);
  const ifNoneMatch = request.headers.get('If-None-Match');
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300, s-maxage=300',
    ETag: etag,
    Vary: 'Accept-Encoding',
  };
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: baseHeaders });
  }
  const html = renderListingHtml(listing, analytics);
  return new Response(html, { status: 200, headers: baseHeaders });
}

/**
 * Quoted ETag derived from artifact count + newest upload timestamp + host.
 * Cheap to compute, stable under no-change reloads, and changes whenever a
 * new artifact is uploaded or an existing one replaced. The host is folded
 * in because the embedded analytics write key is per-host.
 */
function listingEtag(listing: Listing, hostname: string): string {
  const ms = listing.lastUpdated ? listing.lastUpdated.getTime() : 0;
  return `"l-${listing.totalArtifacts}-${ms}-${hostname}"`;
}

/**
 * Resolve the analytics config for a request host: the write key mapped to
 * this hostname plus the data plane URL, or `null` when either var is unset
 * or the host has no mapped key — the listing page then renders without the
 * SDK (graceful no-op). docs/adr/0012.
 */
function resolveAnalytics(env: Env, hostname: string): AnalyticsConfig | null {
  const dataPlaneUrl = env.ANALYTICS_DATA_PLANE_URL;
  const mapJson = env.ANALYTICS_WRITE_KEYS;
  if (!dataPlaneUrl || !mapJson) return null;
  let map: unknown;
  try {
    map = JSON.parse(mapJson);
  } catch {
    console.error('download-proxy: ANALYTICS_WRITE_KEYS is not valid JSON');
    return null;
  }
  if (typeof map !== 'object' || map === null) return null;
  const writeKey = (map as Record<string, unknown>)[hostname];
  if (typeof writeKey !== 'string' || writeKey.length === 0) return null;
  return { writeKey, dataPlaneUrl };
}
