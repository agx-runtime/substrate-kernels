/**
 * Pure pathname → R2 key + analytics label parser. The Worker has exactly
 * two accepted path shapes; everything else is a 404 with no analytics
 * emit. Keeping this routing logic pure (no I/O, no bindings) lets the
 * unit tests cover every accepted + rejected case against the function
 * directly.
 *
 * Accepted path shapes (mirror the names release.yml writes to R2 — kept
 * stable across kernel versions so the public download URL is content-
 * stable per pinned version):
 *
 *   /linux-<version>-<variant>-<arch>.kernel    e.g. /linux-6.12.91-base-x86_64.kernel
 *   /linux-<version>-SHA256SUMS                 e.g. /linux-6.12.91-SHA256SUMS
 *
 * docs/design/download-proxy.md is authoritative.
 */

import type { PackageName, R2Key, Version } from './types.ts';

/**
 * Bounded inputs (CLAUDE.md §5 — every dimension named). A URL longer than
 * MAX_PATH_BYTES is rejected before any regex work happens; the version /
 * variant / arch tokens are bounded by the regex character classes.
 */
const LIMITS = {
  MAX_PATH_BYTES: 256,
} as const;

const KERNEL_PATTERN =
  /^\/linux-(?<version>[0-9]+\.[0-9]+\.[0-9]+)-(?<variant>[a-z]+)-(?<arch>[a-z0-9_]+)\.kernel$/;
const SHA256SUMS_PATTERN = /^\/linux-(?<version>[0-9]+\.[0-9]+\.[0-9]+)-SHA256SUMS$/;

export interface ParsedRoute {
  r2_key: R2Key;
  package: PackageName;
  version: Version;
  /** Content-Type the Worker advertises for this object. */
  content_type: 'application/octet-stream' | 'text/plain; charset=utf-8';
}

/**
 * Parse a request pathname into the R2 key to fetch and the
 * (package, version) labels to stamp on the analytics event. Returns
 * `null` for any path that doesn't match either accepted shape — the
 * caller responds 404 and emits NO analytics event.
 */
export function parsePath(pathname: string): ParsedRoute | null {
  if (pathname.length > LIMITS.MAX_PATH_BYTES) return null;

  const kernel = KERNEL_PATTERN.exec(pathname);
  if (kernel?.groups) {
    const { version, variant, arch } = kernel.groups;
    if (!version || !variant || !arch) return null;
    return {
      r2_key: pathname.slice(1) as R2Key,
      package: `linux-${variant}-${arch}` as PackageName,
      version: version as Version,
      content_type: 'application/octet-stream',
    };
  }

  const sums = SHA256SUMS_PATTERN.exec(pathname);
  if (sums?.groups) {
    const { version } = sums.groups;
    if (!version) return null;
    return {
      r2_key: pathname.slice(1) as R2Key,
      package: 'linux-SHA256SUMS' as PackageName,
      version: version as Version,
      content_type: 'text/plain; charset=utf-8',
    };
  }

  return null;
}
