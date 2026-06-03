/**
 * Integration test for the download-proxy fetch handler. Runs under
 * @cloudflare/vitest-pool-workers (real workerd isolate, real R2 binding
 * from miniflare). `EVENTS_QUEUE` is stubbed per test so we can assert
 * the analytics emit happens (or not) on each path.
 *
 * Cases mirror docs/design/download-proxy.md:
 *   - GET full body            → 200 + body + one queue send (source=WEB:<HOST>, event_name=kernel_download)
 *   - GET + anon-id header/cookie → event carries the supplied anonymous_id
 *   - HEAD                     → 200 + headers + NO queue send
 *   - GET with Range           → 206 + Content-Range + NO queue send
 *   - GET missing R2 key       → 404 + NO queue send
 *   - POST                     → 405 + NO queue send
 *   - GET unknown path shape   → 404 + NO queue send
 *   - GET /                    → listing page; RudderStack SDK injected iff a write key is configured
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
// makeRequest uses the kernels.substrate.loopholelabs.io host, so the
// server-side download event's source is WEB:<that host, uppercased>.
const EXPECTED_SOURCE = 'WEB:KERNELS.SUBSTRATE.LOOPHOLELABS.IO';

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
    expect(event.source).toBe(EXPECTED_SOURCE);
    expect(event.event_name).toBe('kernel_download');
    expect(event.user_id).toBeNull();
    expect(event.group_id).toBeNull();
    // No header/cookie supplied → a fresh random UUID.
    expect(event.anonymous_id).toEqual(expect.any(String));
    expect(event.properties).toEqual({
      package: 'linux-base-x86_64',
      version: '6.12.91',
      bytes: FIXTURE_BODY.length,
    });
  });

  it('GET with X-Substrate-Anonymous-Id header → event carries that anonymous_id', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    const anon = 'cli-machine-uuid-1234';
    const req = makeRequest('GET', `/${FIXTURE_KEY}`, { 'X-Substrate-Anonymous-Id': anon });
    const ctx = createExecutionContext();
    await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(sent).toHaveLength(1);
    expect((sent[0] as Record<string, unknown>).anonymous_id).toBe(anon);
  });

  it('GET with substrate_aid cookie → event carries that anonymous_id', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    const anon = '8f2b9c10-1111-2222-3333-444455556666';
    const req = makeRequest('GET', `/${FIXTURE_KEY}`, {
      Cookie: `other=x; substrate_aid=${anon}; another=y`,
    });
    const ctx = createExecutionContext();
    await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(sent).toHaveLength(1);
    expect((sent[0] as Record<string, unknown>).anonymous_id).toBe(anon);
  });

  it('header beats cookie when both are present', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    const req = makeRequest('GET', `/${FIXTURE_KEY}`, {
      'X-Substrate-Anonymous-Id': 'from-header',
      Cookie: 'substrate_aid=from-cookie',
    });
    const ctx = createExecutionContext();
    await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect((sent[0] as Record<string, unknown>).anonymous_id).toBe('from-header');
  });

  it('rejects a malformed anonymous_id and falls back to a fresh UUID', async () => {
    const { sent, queue } = stubQueue();
    const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

    // Contains a space + a slash — outside the accepted charset.
    const bad = 'not a valid/id';
    const req = makeRequest('GET', `/${FIXTURE_KEY}`, { 'X-Substrate-Anonymous-Id': bad });
    const ctx = createExecutionContext();
    await worker.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    const id = (sent[0] as Record<string, unknown>).anonymous_id as string;
    expect(id).not.toBe(bad);
    // A UUID, not the rejected input.
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
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

  describe('GET / — kernels listing page', () => {
    const X86_KEY = 'linux-6.12.91-base-x86_64.kernel';
    const ARM_KEY = 'linux-6.12.91-base-aarch64.kernel';
    const SUMS_KEY = 'linux-6.12.91-SHA256SUMS';

    beforeEach(async () => {
      await env.KERNELS.put(X86_KEY, new Uint8Array(64));
      await env.KERNELS.put(ARM_KEY, new Uint8Array(60));
      await env.KERNELS.put(SUMS_KEY, new TextEncoder().encode('abcd  ' + X86_KEY + '\n'));
    });

    it('GET / → 200 HTML listing the artifacts, no analytics emit', async () => {
      const { sent, queue } = stubQueue();
      const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

      const req = makeRequest('GET', '/');
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, testEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('Cache-Control')).toContain('max-age=300');
      // ETag folds in the host (the page embeds a per-host analytics key).
      expect(res.headers.get('ETag')).toMatch(/^"l-\d+-\d+-[\w.-]+"$/);

      const body = await res.text();
      // Page structure
      expect(body).toContain('<title>Substrate — Kernels</title>');
      expect(body).toContain('Kernels'); // <h1>
      expect(body).toContain('substrate-kernel-download-proxy'.split('-')[0]); // 'substrate'
      // Listed artifacts — every key should appear as a download href
      expect(body).toContain(`href="/${X86_KEY}"`);
      expect(body).toContain(`href="/${ARM_KEY}"`);
      // Per-row sha256 link points at the SHA256SUMS for this version
      expect(body).toContain(`href="/${SUMS_KEY}"`);
      // Bench-decision: header nav is just GitHub
      expect(body).toMatch(/<nav class="top">\s*<a [^>]*github\.com\/loopholelabs[^"]*"[^>]*>GitHub<\/a>\s*<\/nav>/);
      // Bench-decision: footer middle is 3 items, no `changelog`
      expect(body).not.toMatch(/changelog/i);
      expect(body).toMatch(/status\.loopholelabs\.io/);
      expect(body).toMatch(/loopholelabs\.io\/privacy/);
      expect(body).toMatch(/loopholelabs\.io\/terms/);
      // Cosign claim replaced by source link
      expect(body).not.toMatch(/cosign/i);
      expect(body).toMatch(/github\.com\/loopholelabs\/substrate-kernel/);
      // No analytics vars configured here → the SDK loader is NOT injected.
      // (Stable presence markers: the loader URL we'd build, the load() call,
      // and the renamed client filename.)
      expect(body).not.toContain('/_data/modern/client.min.js');
      expect(body).not.toContain('rudderanalytics.load(');
      // Belt-and-braces against ever shipping the third-party CDN URLs.
      expect(body).not.toContain('cdn.rudderlabs.com');
      expect(body).not.toContain('api.rudderstack.com');
      expect(body).not.toContain('rsa.min.js');

      expect(sent).toEqual([]); // not a kernel download
    });

    it('GET / with a write key configured → injects the reverse-proxied SDK loader', async () => {
      const { queue } = stubQueue();
      const testEnv: Env = {
        ...env,
        EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'],
        ANALYTICS_DATA_PLANE_URL: 'https://data.agx.so',
        ANALYTICS_WRITE_KEYS: JSON.stringify({
          'kernels.substrate.loopholelabs.io': 'test-web-key',
        }),
      };

      const req = makeRequest('GET', '/');
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, testEnv, ctx);
      await waitOnExecutionContext(ctx);

      const body = await res.text();
      // The loader is overridden to point at our origin under /_data/.
      expect(body).toContain('"/_data"');
      expect(body).toContain('"client.min.js"');
      expect(body).toContain('rudderanalytics.load("test-web-key","https://data.agx.so",');
      expect(body).toContain('configUrl:origin+"/_data"');
      expect(body).toContain('pluginsSDKBaseURL');
      expect(body).toContain('lockPluginsVersion:true');
      // The correlation cookie is set from the SDK's anonymous id.
      expect(body).toContain('substrate_aid');
      // The third-party CDN URLs do NOT appear anywhere on the page.
      expect(body).not.toContain('cdn.rudderlabs.com');
      expect(body).not.toContain('api.rudderstack.com');
      expect(body).not.toContain('rsa.min.js');
    });

    it('GET / does NOT inject the SDK for a host with no mapped write key', async () => {
      const { queue } = stubQueue();
      const testEnv: Env = {
        ...env,
        EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'],
        ANALYTICS_DATA_PLANE_URL: 'https://data.agx.so',
        // Map a DIFFERENT host — the request host has no key, so no SDK.
        ANALYTICS_WRITE_KEYS: JSON.stringify({ 'kernels.agx.so': 'other-key' }),
      };

      const req = makeRequest('GET', '/');
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, testEnv, ctx);
      await waitOnExecutionContext(ctx);

      const body = await res.text();
      expect(body).not.toContain('/_data/modern/client.min.js');
      expect(body).not.toContain('rudderanalytics.load(');
    });

    it('HEAD / → 200 with the same headers and no body', async () => {
      const { sent, queue } = stubQueue();
      const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

      const req = makeRequest('HEAD', '/');
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, testEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('ETag')).toMatch(/^"l-/);
      const body = await res.arrayBuffer();
      expect(body.byteLength).toBe(0);
      expect(sent).toEqual([]);
    });

    it('If-None-Match round-trip → 304 with no body, no emit', async () => {
      const { sent, queue } = stubQueue();
      const testEnv: Env = { ...env, EVENTS_QUEUE: queue as unknown as Env['EVENTS_QUEUE'] };

      const first = await worker.fetch(
        makeRequest('GET', '/'),
        testEnv,
        createExecutionContext(),
      );
      const etag = first.headers.get('ETag');
      expect(etag).toBeTruthy();

      const req = makeRequest('GET', '/', { 'If-None-Match': etag ?? '' });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, testEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(304);
      const body = await res.arrayBuffer();
      expect(body.byteLength).toBe(0);
      expect(sent).toEqual([]);
    });
  });

  describe('GET /_data/* — RudderStack SDK reverse proxy', () => {
    const WRITE_KEY = 'kernels-substrate-key';
    const envWithKeys: Env = {
      ...env,
      ANALYTICS_WRITE_KEYS: JSON.stringify({
        'kernels.substrate.loopholelabs.io': WRITE_KEY,
      }),
    };

    it('GET /_data/sourceConfig/?writeKey=<known> → 200 + valid source config', async () => {
      const req = makeRequest('GET', `/_data/sourceConfig/?writeKey=${WRITE_KEY}`);
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, envWithKeys, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body).toMatchObject({
        source: {
          id: WRITE_KEY,
          writeKey: WRITE_KEY,
          enabled: true,
          destinations: [],
          config: {
            statsCollection: {
              errors: { enabled: false },
              metrics: { enabled: false },
            },
          },
        },
      });
    });

    it('GET /_data/sourceConfig/?writeKey=<unknown> → 401', async () => {
      const req = makeRequest('GET', '/_data/sourceConfig/?writeKey=bogus');
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, envWithKeys, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unknown writeKey' });
    });

    it('GET /_data/sourceConfig/ (no writeKey) → 401', async () => {
      const req = makeRequest('GET', '/_data/sourceConfig/');
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, envWithKeys, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'missing writeKey' });
    });

    it('GET /_data/modern/client.min.js → proxies cdn.rudderlabs.com (fetch stub asserts upstream URL)', async () => {
      const upstreamBody = 'var __FAKE_SDK__ = 1;';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(upstreamBody, {
          status: 200,
          headers: { 'content-type': 'application/javascript' },
        }),
      );
      try {
        const req = makeRequest('GET', '/_data/modern/client.min.js');
        const ctx = createExecutionContext();
        const res = await worker.fetch(req, envWithKeys, ctx);
        await waitOnExecutionContext(ctx);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const upstreamUrl = fetchSpy.mock.calls[0]?.[0];
        expect(upstreamUrl).toBe(
          'https://cdn.rudderlabs.com/3.31.2/modern/rsa.min.js',
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/javascript');
        expect(res.headers.get('Cache-Control')).toContain('immutable');
        expect(await res.text()).toBe(upstreamBody);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('GET /_data/modern/p/rsa-plugins.js → proxies the upstream plugins directory', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('// plugin chunk', {
          status: 200,
          headers: { 'content-type': 'application/javascript' },
        }),
      );
      try {
        const req = makeRequest('GET', '/_data/modern/p/rsa-plugins.js');
        const ctx = createExecutionContext();
        const res = await worker.fetch(req, envWithKeys, ctx);
        await waitOnExecutionContext(ctx);

        expect(fetchSpy.mock.calls[0]?.[0]).toBe(
          'https://cdn.rudderlabs.com/3.31.2/modern/plugins/rsa-plugins.js',
        );
        expect(res.status).toBe(200);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('GET /_data/<bad>/client.min.js → 404, no upstream fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        const req = makeRequest('GET', '/_data/evil/client.min.js');
        const ctx = createExecutionContext();
        const res = await worker.fetch(req, envWithKeys, ctx);
        await waitOnExecutionContext(ctx);

        expect(res.status).toBe(404);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('GET /_data/ (no specific route) → 404, no upstream fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        const req = makeRequest('GET', '/_data/');
        const ctx = createExecutionContext();
        const res = await worker.fetch(req, envWithKeys, ctx);
        await waitOnExecutionContext(ctx);

        expect(res.status).toBe(404);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('POST /_data/modern/client.min.js → 405', async () => {
      const req = makeRequest('POST', '/_data/modern/client.min.js');
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, envWithKeys, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET, HEAD');
    });
  });
});
