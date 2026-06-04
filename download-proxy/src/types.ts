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
  /**
   * RudderStack data plane URL the listing-page SDK posts to (e.g.
   * `https://data.agx.so`). Absent → the page renders without the SDK
   * (graceful no-op). docs/adr/0012.
   */
  ANALYTICS_DATA_PLANE_URL?: string;
  /**
   * JSON object mapping request hostname → RudderStack write key, e.g.
   * `{"kernels.agx.so":"<key>"}`. Each key's analytics-side KV record stamps
   * `source = WEB:<HOSTNAME UPPERCASE>`. Write keys are not secrets (analytics
   * ADR 0010), so this lives in `[vars]`. Absent / no match → no SDK.
   */
  AGX_ANALYTICS_KEYS?: string;
}

/**
 * Resolved per-host analytics config the Worker injects into the listing
 * page. Built by `resolveAnalytics` (index.ts); `null` when no write key is
 * configured for the request host, in which case the SDK is not injected.
 */
export interface AnalyticsConfig {
  /** RudderStack write key for this hostname (stamps `source = WEB:<HOST>`). */
  writeKey: string;
  /** RudderStack data plane URL, e.g. `https://data.agx.so`. */
  dataPlaneUrl: string;
}

/** A validated R2 object key extracted from the request path. */
export type R2Key = string & { readonly __brand: 'R2Key' };

/** The `package` label that lands in the kernel_download event. */
export type PackageName = string & { readonly __brand: 'PackageName' };

/** The `version` label that lands in the kernel_download event. */
export type Version = string & { readonly __brand: 'Version' };
