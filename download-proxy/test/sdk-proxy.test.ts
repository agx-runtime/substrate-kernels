/**
 * Unit tests for the RudderStack SDK reverse proxy. Pure-function shape:
 * pathname classification + source-config synthesizer. The CDN-proxy fetch
 * itself is exercised in `integration.test.ts` where we can stub the
 * outbound fetch via vitest's spies.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  classifySdkPath,
  isSdkProxyPath,
  sanitizeBody,
  serveSourceConfig,
} from '../src/sdk-proxy.ts';
import type { Env } from '../src/types.ts';

describe('classifySdkPath', () => {
  it('matches modern + legacy SDK file paths', () => {
    expect(classifySdkPath('/_data/modern/client.min.js')).toEqual({
      kind: 'sdk-file',
      upstream: 'https://cdn.rudderlabs.com/3.31.2/modern/rsa.min.js',
    });
    expect(classifySdkPath('/_data/legacy/client.min.js')).toEqual({
      kind: 'sdk-file',
      upstream: 'https://cdn.rudderlabs.com/3.31.2/legacy/rsa.min.js',
    });
  });

  it('matches plugin paths with a safe-charset filename', () => {
    expect(classifySdkPath('/_data/modern/p/rsa-plugins.js')).toEqual({
      kind: 'plugin-file',
      upstream: 'https://cdn.rudderlabs.com/3.31.2/modern/plugins/rsa-plugins.js',
    });
    expect(
      classifySdkPath('/_data/modern/p/rsa-plugins-remote-XhrQueue.min.js'),
    ).toEqual({
      kind: 'plugin-file',
      upstream:
        'https://cdn.rudderlabs.com/3.31.2/modern/plugins/rsa-plugins-remote-XhrQueue.min.js',
    });
  });

  it('matches /_data/sourceConfig/ with and without the trailing slash', () => {
    expect(classifySdkPath('/_data/sourceConfig/')?.kind).toBe('source-config');
    expect(classifySdkPath('/_data/sourceConfig')?.kind).toBe('source-config');
  });

  it('matches /_data/v1/<type> as the analytics-ingest forwarder', () => {
    expect(classifySdkPath('/_data/v1/page')?.kind).toBe('analytics-ingest');
    expect(classifySdkPath('/_data/v1/track')?.kind).toBe('analytics-ingest');
    expect(classifySdkPath('/_data/v1/identify')?.kind).toBe('analytics-ingest');
    expect(classifySdkPath('/_data/v1/group')?.kind).toBe('analytics-ingest');
    expect(classifySdkPath('/_data/v1/batch')?.kind).toBe('analytics-ingest');
    // Path validator: lowercase letters only; trailing slash and traversal rejected.
    expect(classifySdkPath('/_data/v1/Page')).toBeNull();
    expect(classifySdkPath('/_data/v1/page/')).toBeNull();
    expect(classifySdkPath('/_data/v1/')).toBeNull();
    expect(classifySdkPath('/_data/v1/../escape')).toBeNull();
  });

  it('rejects unknown shapes under /_data/', () => {
    expect(classifySdkPath('/_data/')).toBeNull();
    expect(classifySdkPath('/_data/modern/')).toBeNull();
    expect(classifySdkPath('/_data/modern/other.js')).toBeNull();
    expect(classifySdkPath('/_data/evil/client.min.js')).toBeNull();
    // Plugin filenames must end in .js and use only the safe charset.
    expect(classifySdkPath('/_data/modern/p/has space.js')).toBeNull();
    expect(classifySdkPath('/_data/modern/p/../escape.js')).toBeNull();
    expect(classifySdkPath('/_data/modern/p/etc/passwd')).toBeNull();
  });

  it('rejects paths outside /_data/', () => {
    expect(classifySdkPath('/linux-6.12.91-base-x86_64.kernel')).toBeNull();
    expect(classifySdkPath('/')).toBeNull();
  });
});

describe('isSdkProxyPath', () => {
  it('returns true for every /_data/* path (including unknown shapes)', () => {
    expect(isSdkProxyPath('/_data/')).toBe(true);
    expect(isSdkProxyPath('/_data/modern/client.min.js')).toBe(true);
    expect(isSdkProxyPath('/_data/anything/at/all')).toBe(true);
  });
  it('returns false outside /_data/', () => {
    expect(isSdkProxyPath('/')).toBe(false);
    expect(isSdkProxyPath('/_data')).toBe(false); // no trailing slash
    expect(isSdkProxyPath('/linux-6.12.91-base-x86_64.kernel')).toBe(false);
  });
});

describe('serveSourceConfig', () => {
  const KEY = 'test-write-key-abc123';
  const KEY_OTHER = 'other-write-key-xyz';
  const envWithKeys: Env = {
    ...env,
    AGX_ANALYTICS_KEYS: JSON.stringify({
      'kernels.agx.so': KEY,
      'kernels.substrate.so': KEY_OTHER,
    }),
  };

  function req(query = ''): Request {
    return new Request(`https://kernels.agx.so/_data/sourceConfig/${query}`);
  }

  it('returns 200 + valid JSON for a known writeKey', async () => {
    const res = serveSourceConfig(envWithKeys, req(`?writeKey=${KEY}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toContain('max-age=300');
    const body = await res.json();
    // Passes rudder-sdk-js isValidSourceConfig (validate.ts): source.id
    // non-null, source.config object-literal, source.destinations array.
    expect(body).toMatchObject({
      source: {
        id: KEY,
        writeKey: KEY,
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
    expect(Array.isArray((body as { source: { destinations: unknown } }).source.destinations)).toBe(true);
  });

  it('accepts any of our configured writeKeys (not host-bound)', async () => {
    const res = serveSourceConfig(envWithKeys, req(`?writeKey=${KEY_OTHER}`));
    expect(res.status).toBe(200);
  });

  it('returns 401 for an unknown writeKey', async () => {
    const res = serveSourceConfig(envWithKeys, req('?writeKey=unknown-key'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unknown writeKey' });
  });

  it('returns 401 when the writeKey is missing', async () => {
    const res = serveSourceConfig(envWithKeys, req(''));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing writeKey' });
  });

  it('returns 401 when AGX_ANALYTICS_KEYS is unset', async () => {
    const bareEnv: Env = { ...env, AGX_ANALYTICS_KEYS: undefined };
    const res = serveSourceConfig(bareEnv, req(`?writeKey=${KEY}`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unknown writeKey' });
  });

  it('returns 401 when AGX_ANALYTICS_KEYS is malformed JSON', async () => {
    const badEnv: Env = { ...env, AGX_ANALYTICS_KEYS: '{not-json' };
    const res = serveSourceConfig(badEnv, req(`?writeKey=${KEY}`));
    expect(res.status).toBe(401);
  });

  it('response is byte-stable for the same writeKey (so CF edge can cache)', async () => {
    const a = await serveSourceConfig(envWithKeys, req(`?writeKey=${KEY}`)).text();
    const b = await serveSourceConfig(envWithKeys, req(`?writeKey=${KEY}`)).text();
    expect(a).toBe(b);
  });
});

describe('sanitizeBody (strips empty/null identity fields)', () => {
  it('strips empty-string userId from a single-message body', () => {
    // The RudderStack v3 SDK ships `userId: ""` for unidentified visitors.
    // The analytics validator treats "" as invalid (only null/undefined are
    // "absent"). Stripping turns it into absent → validator accepts.
    expect(
      sanitizeBody({
        type: 'page',
        anonymousId: 'a-1',
        userId: '',
        messageId: 'm-1',
      }),
    ).toEqual({ type: 'page', anonymousId: 'a-1', messageId: 'm-1' });
  });

  it('strips null userId and groupId equally', () => {
    expect(
      sanitizeBody({
        type: 'track',
        anonymousId: 'a-1',
        userId: null,
        groupId: null,
        event: 'kernel_search',
      }),
    ).toEqual({ type: 'track', anonymousId: 'a-1', event: 'kernel_search' });
  });

  it('keeps real userId / groupId values', () => {
    expect(
      sanitizeBody({
        type: 'page',
        anonymousId: 'a-1',
        userId: 'u_abc',
        groupId: 'org_acme',
      }),
    ).toEqual({
      type: 'page',
      anonymousId: 'a-1',
      userId: 'u_abc',
      groupId: 'org_acme',
    });
  });

  it('strips empty context.groupId (Segment-style group binding on track/page)', () => {
    expect(
      sanitizeBody({
        type: 'track',
        anonymousId: 'a-1',
        event: 'kernel_download_click',
        context: { groupId: '', library: { name: 'rsa-js' } },
      }),
    ).toEqual({
      type: 'track',
      anonymousId: 'a-1',
      event: 'kernel_download_click',
      context: { library: { name: 'rsa-js' } },
    });
  });

  it('handles wrapped batches', () => {
    expect(
      sanitizeBody({
        batch: [
          { type: 'page', anonymousId: 'a-1', userId: '' },
          { type: 'track', anonymousId: 'a-2', userId: 'u_x', event: 'foo' },
        ],
        sentAt: '2026-06-03T00:00:00.000Z',
      }),
    ).toEqual({
      batch: [
        { type: 'page', anonymousId: 'a-1' },
        { type: 'track', anonymousId: 'a-2', userId: 'u_x', event: 'foo' },
      ],
      sentAt: '2026-06-03T00:00:00.000Z',
    });
  });

  it('passes through non-object bodies untouched', () => {
    expect(sanitizeBody('not an object')).toBe('not an object');
    expect(sanitizeBody(null)).toBe(null);
    expect(sanitizeBody(42)).toBe(42);
  });
});
