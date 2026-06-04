/// <reference types="@cloudflare/vitest-pool-workers" />
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the substrate-kernels download proxy. Two shapes:
 *
 *  - `test/router.test.ts`     — pure-function unit tests of the parser.
 *  - `test/integration.test.ts` — full fetch-handler test against a real
 *                                 miniflare R2 binding (seeded per-test),
 *                                 with `EVENTS_QUEUE` stubbed at call time
 *                                 so we can assert the analytics emit
 *                                 without spinning up a consumer.
 *
 * Both run under @cloudflare/vitest-pool-workers — the pure tests just
 * never reach for `env`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2025-04-01',
        // Real R2 binding so the integration test exercises the actual
        // get / head / range code path; seeded per-test via env.KERNELS.put.
        r2Buckets: ['KERNELS'],
        // Real per-IP rate limit binding. A generous limit so the existing
        // integration cases never hit it; a dedicated case opts into a
        // 1/min limit by overriding the binding via testEnv.
        ratelimits: {
          DOWNLOAD_RATE_LIMITER_IP: { simple: { limit: 10_000, period: 60 } },
        },
        // No queueProducers here — tests override env.EVENTS_QUEUE with a
        // stub at the call site so they can assert send() shapes directly.
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
