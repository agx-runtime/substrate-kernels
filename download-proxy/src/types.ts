/**
 * Bindings and branded value types for the download-proxy Worker. The
 * Worker has no runtime state outside per-request handler scope — these
 * types pin its single seam with the Cloudflare runtime.
 *
 * docs/design/download-proxy.md is authoritative.
 */

import type { ProxyEnv } from './analytics.ts';

/**
 * The Worker's full environment: the R2 bucket carrying the published
 * `.kernel` bundles and SHA256SUMS files, plus the analytics queue
 * producer the local analytics module writes onto.
 */
export interface Env extends ProxyEnv {
  /** The substrate-kernels R2 bucket — bound, not fetched over S3. */
  KERNELS: R2Bucket;
  /** Per-IP rate limit (60 req/min); the binding is `unsafe` only in wrangler.toml shape. */
  DOWNLOAD_RATE_LIMITER_IP: RateLimit;
}

/** A validated R2 object key extracted from the request path. */
export type R2Key = string & { readonly __brand: 'R2Key' };

/** The `package` label that lands in the proxy_download event. */
export type PackageName = string & { readonly __brand: 'PackageName' };

/** The `version` label that lands in the proxy_download event. */
export type Version = string & { readonly __brand: 'Version' };
