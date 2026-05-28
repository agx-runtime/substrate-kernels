/**
 * substrate-kernel download proxy. A thin Cloudflare Worker bound at
 * `kernels.substrate.loopholelabs.io` and `kernels.agx.so` that serves
 * `.kernel` bundles + SHA256SUMS from R2 and emits one `proxy_download`
 * event per successful full download into the analytics events queue.
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
import { serveFromR2 } from './r2.ts';
import { parsePath } from './router.ts';
import type { Env } from './types.ts';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
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
