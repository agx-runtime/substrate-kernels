/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Augment the test environment so test files can type-safely access the
 * miniflare-provided bindings. Pool-workers reads `env` from the global
 * `Cloudflare.Env` namespace (the standard CF Workers types pattern); the
 * `cloudflare:test`-exported `env` is then typed against it.
 */

import type { ProxyEnv } from '../src/analytics.ts';

declare global {
  namespace Cloudflare {
    interface Env extends ProxyEnv {
      KERNELS: R2Bucket;
      DOWNLOAD_RATE_LIMITER_IP: RateLimit;
    }
  }
}

declare module 'cloudflare:test' {
  // The cloudflare:test `env` is typed via this interface; making it extend
  // Cloudflare.Env keeps the two in sync — when we add a binding above,
  // tests see it automatically.
  interface ProvidedEnv extends Cloudflare.Env {}
}

export {};
