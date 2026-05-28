/**
 * Integration test for the download-proxy fetch handler. Runs under
 * @cloudflare/vitest-pool-workers (real workerd isolate, real R2 binding
 * from miniflare). `EVENTS_QUEUE` is stubbed per test so we can assert
 * the analytics emit happens (or not) on each path.
 *
 * Cases mirror docs/design/download-proxy.md:
 *   - GET full body            → 200 + body + one queue send (source=kernel_download_proxy, event_name=kernel_download)
 *   - HEAD                     → 200 + headers + NO queue send
 *   - GET with Range           → 206 + Content-Range + NO queue send
 *   - GET missing R2 key       → 404 + NO queue send
 *   - POST                     → 405 + NO queue send
 *   - GET unknown path shape   → 404 + NO queue send
 */

import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import type { Env } from '../src/types.ts';

const FIXTURE_KEY = 'linux-6.12.91-base-x86_64.kernel';
// Tiny deterministic payload — large enough to make Content-Length / Range
// asserts meaningful, small enough to print on a failure without flooding.
const FIXTURE_BODY = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff);

interface SendStub {
  sent: unknown[];
  queue: { send: ReturnType<typeof vi.fn>; sendBatch: ReturnType<typeof vi.fn> };
}

function stubQueue(): SendStub {
  const sent: unknown[] = [];
  return {
    sent,
    queue: {
      send: vi.fn(async (msg: unknown) => {
        sent.push(msg);
      }),
      sendBatch: vi.fn(),
    },
  };
}

function makeRequest(method: string, path: string, headers: HeadersInit = {}): Request {
  const req = new Request(`https://kernels.substrate.loopholelabs.io${path}`, {
    method,
    // CF-Connecting-IP keys the per-IP rate limiter. A fresh IP per test
    // method means the existing cases never trip the limiter; the
    // dedicated rate-limit test below uses one fixed IP with a stub
    // binding that denies the second request.
    headers: { 'CF-Connecting-IP': '203.0.113.42', ...headers },
  });
  // request.cf is populated by CF's edge in production. The proxy-producer
  // enrichment guards on undefined, so omitting it here exercises the
  // null-fallback path. (The library's own tests cover the populated path.)
  return req;
}

beforeEach(async () => {
  // Re-seed R2 from a known fixture. The bucket persists across tests
  // within a worker instance, so explicitly delete-then-put every test to
  // guarantee a consistent starting state — CLAUDE.md §8: tests panic on
  // missing resources, never silently rely on prior state.
  await env.KERNELS.delete(FIXTURE_KEY);
  await env.KERNELS.put(FIXTURE_KEY, FIXTURE_BODY);
});

describe('download-proxy fetch', () => {
  it('GET on a present .kernel → 200 + body + one kernel_download event', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    const req = makeRequest('GET', `/${FIXTURE_KEY}`);
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Length')).toBe(String(FIXTURE_BODY.length));
    expect(res.headers.get('Cache-Control')).toMatch(/immutable/);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FIXTURE_BODY);

    expect(sent).toHaveLength(1);
    const event = sent[0] as Record<string, unknown>;
    expect(event.source).toBe('kernel_download_proxy');
    expect(event.event_name).toBe('kernel_download');
    expect(event.user_id).toBeNull();
    expect(event.group_id).toBeNull();
    expect(event.anonymous_id).toEqual(expect.any(String));
    expect(event.properties).toEqual({
      package: 'linux-base-x86_64',
      version: '6.12.91',
      bytes: FIXTURE_BODY.length,
    });
  });

  it('HEAD on a present .kernel → 200 headers + NO event', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    const req = makeRequest('HEAD', `/${FIXTURE_KEY}`);
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(FIXTURE_BODY.length));
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(0);
    expect(sent).toEqual([]);
  });

  it('GET with Range → 206 + Content-Range + NO event (resumable downloads do not over-count)', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    const req = makeRequest('GET', `/${FIXTURE_KEY}`, { Range: 'bytes=0-15' });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-15/${FIXTURE_BODY.length}`);
    expect(res.headers.get('Content-Length')).toBe('16');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(FIXTURE_BODY.slice(0, 16));
    expect(sent).toEqual([]);
  });

  it('GET on a missing R2 key → 404 + NO event', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    const req = makeRequest('GET', '/linux-9.99.99-base-x86_64.kernel');
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(404);
    expect(sent).toEqual([]);
  });

  it('POST → 405 with Allow header + NO event', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    const req = makeRequest('POST', `/${FIXTURE_KEY}`);
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
    expect(sent).toEqual([]);
  });

  it('GET on an unknown path shape → 404 + NO event (router rejected before R2 read)', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    const req = makeRequest('GET', '/random/path.bin');
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(404);
    expect(sent).toEqual([]);
  });

  it('returns 429 + Retry-After when the per-IP rate limit denies', async () => {
    const { sent, queue } = stubQueue();
    // Stub the rate limiter to deny — the real binding is rate-limited
    // to 10k/min in miniflare so it'd never trip in tests otherwise.
    const denyingLimiter: RateLimit = {
      limit: async () => ({ success: false }),
    };
    const testEnv: Env = {
      ...env,
      EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'],
      DOWNLOAD_RATE_LIMITER_IP: denyingLimiter,
    };

    const req = makeRequest('GET', `/${FIXTURE_KEY}`);
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(sent).toEqual([]); // no analytics emit on a rate-limited request
  });

  it('GET SHA256SUMS → text/plain + 200 + one event with linux-SHA256SUMS package', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    const sumsKey = 'linux-6.12.91-SHA256SUMS';
    const sumsBody = new TextEncoder().encode(
      'abcd1234  linux-6.12.91-base-x86_64.kernel\n',
    );
    await env.KERNELS.put(sumsKey, sumsBody);

    const req = makeRequest('GET', `/${sumsKey}`);
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(sent).toHaveLength(1);
    const event = sent[0] as Record<string, unknown>;
    expect((event.properties as Record<string, unknown>).package).toBe('linux-SHA256SUMS');

    await env.KERNELS.delete(sumsKey);
  });
});
