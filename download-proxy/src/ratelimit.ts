/**
 * Per-IP rate limit. The download proxy is public + unauthenticated, so a
 * single IP hammering the bucket would (a) chew CPU + request quota, (b)
 * fan out one analytics event per full GET (bloats the queue + CH cost),
 * and (c) potentially trip CF abuse detection.
 *
 * 60 requests/minute/IP is generous for any real use — a developer
 * running `make` cycles through ~3 kernel files per setup; a CI replacing
 * a node fleet might do dozens but spread across IPs. A single IP doing
 * >60/min is either abusive or wants to be rate-limited.
 *
 * Falls open if `CF-Connecting-IP` is missing (in production it never is;
 * in local `wrangler dev` it sometimes is). Better to serve a download
 * than to 429 a real user because the test rig didn't set the header.
 */

import type { Env } from './types.ts';

export type RateLimitOutcome = { ok: true } | { ok: false; status: 429; retryAfter: number };

export async function checkRateLimit(env: Env, ip: string | null): Promise<RateLimitOutcome> {
  if (ip === null) return { ok: true }; // no IP to throttle on — fall open
  const { success } = await env.DOWNLOAD_RATE_LIMITER_IP.limit({ key: ip });
  if (success) return { ok: true };
  // The binding's `period` is 60s; the Retry-After we suggest matches.
  return { ok: false, status: 429, retryAfter: 60 };
}
