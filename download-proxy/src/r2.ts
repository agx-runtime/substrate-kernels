/**
 * R2-backed serving with HEAD + GET + bounded single-range support. The
 * Worker never speaks S3; it reads the bucket via its binding (faster, no
 * SigV4 in the worker, no egress fees inside the CF network).
 *
 * Range semantics: a single `Range: bytes=<from>-[<to>]` is supported and
 * returns 206 + `Content-Range`. Multi-range requests (`bytes=0-9,20-29`)
 * are NOT supported — we return the full body (200) to keep the parser
 * simple. Per RFC 9110 §14.2, ignoring a Range header you can't honor is
 * legal; the cost is bandwidth, not correctness.
 *
 * Headers follow the idiomatic R2 worker pattern: `object.writeHttpMetadata`
 * propagates any R2-stored metadata (Content-Type / Content-Encoding /
 * Content-Disposition / Content-Language / Cache-Control) to the response,
 * then we override `Content-Type` defensively from our known-correct value
 * (the router decides this from the path shape) and set our own caching +
 * Accept-Ranges (policy, not metadata).
 *
 * docs/design/download-proxy.md is authoritative.
 */

import type { Env, R2Key } from './types.ts';

const LIMITS = {
  /** `Range: bytes=N-M` is at most ~40 chars in practice — cap to bound parsing. */
  MAX_RANGE_HEADER_BYTES: 64,
} as const;

/** Long-lived for the `.kernel` files (content-stable per pinned version). */
const CACHE_KERNEL = 'public, max-age=31536000, immutable';
/** Short for SHA256SUMS — re-released within a version on patch/config changes. */
const CACHE_SHA256SUMS = 'public, max-age=300';

interface ParsedRange {
  offset: number;
  length?: number;
}

/**
 * Parse a single-range `Range: bytes=<from>-[<to>]` header into an R2-shaped
 * offset/length pair. Returns `null` if the header is absent, malformed, or
 * a multi-range request (which we do not support — caller serves the full
 * body in that case).
 */
function parseSingleRange(header: string | null): ParsedRange | null {
  if (header === null) return null;
  if (header.length > LIMITS.MAX_RANGE_HEADER_BYTES) return null;
  if (header.includes(',')) return null; // multi-range — fall back to full body
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) return null;
  const from = Number(match[1]);
  const to = match[2] === '' ? undefined : Number(match[2]);
  if (!Number.isInteger(from)) return null;
  if (to !== undefined) {
    if (!Number.isInteger(to) || to < from) return null;
    return { offset: from, length: to - from + 1 };
  }
  return { offset: from };
}

function cacheControl(contentType: string): string {
  return contentType.startsWith('text/') ? CACHE_SHA256SUMS : CACHE_KERNEL;
}

/**
 * Initialize a response Headers object from an R2 object's metadata, then
 * stamp our own per-request invariants on top. Single source of header
 * construction for HEAD and GET paths.
 */
function headersFor(
  object: R2Object | R2ObjectBody,
  contentType: string,
): Headers {
  const headers = new Headers();
  // Pulls Content-Type / Content-Encoding / Content-Language /
  // Content-Disposition / Cache-Control from the R2 object's HTTP metadata.
  object.writeHttpMetadata(headers);
  // Override Content-Type defensively — release.yml uploads `.kernel`
  // bundles + SHA256SUMS without setting MIME, so trusting R2's stored type
  // would frequently land as the empty string. The router knows the right
  // type from the path shape.
  headers.set('Content-Type', contentType);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', cacheControl(contentType));
  headers.set('Accept-Ranges', 'bytes');
  return headers;
}

interface ServeArgs {
  env: Env;
  key: R2Key;
  contentType: string;
  request: Request;
}

/**
 * Serve a known-good R2 key. Returns:
 *   - 200 + body for a regular GET, with caching headers,
 *   - 206 + body + `Content-Range` for a single-range GET,
 *   - 200 + body for a multi-range GET (we don't honor the Range; see above),
 *   - 200 + headers (no body) for HEAD,
 *   - 404 if the object is missing,
 *   - 405 for any other method.
 */
export async function serveFromR2(args: ServeArgs): Promise<Response> {
  const { env, key, contentType, request } = args;
  const method = request.method;

  if (method === 'HEAD') {
    const head = await env.KERNELS.head(key);
    if (head === null) return new Response(null, { status: 404 });
    const headers = headersFor(head, contentType);
    headers.set('Content-Length', String(head.size));
    return new Response(null, { status: 200, headers });
  }

  if (method !== 'GET') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    });
  }

  const range = parseSingleRange(request.headers.get('Range'));
  const object = range
    ? await env.KERNELS.get(key, { range: { offset: range.offset, length: range.length } })
    : await env.KERNELS.get(key);

  if (object === null) return new Response('Not found', { status: 404 });

  const headers = headersFor(object, contentType);

  if (range) {
    // R2's `range` field on the returned object carries the offset/length
    // it actually served — use it so an open-ended `bytes=N-` reports the
    // correct end byte.
    const r = object.range as { offset: number; length: number } | undefined;
    const offset = r?.offset ?? range.offset;
    const length = r?.length ?? range.length ?? object.size - offset;
    const end = offset + length - 1;
    headers.set('Content-Length', String(length));
    headers.set('Content-Range', `bytes ${offset}-${end}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}
