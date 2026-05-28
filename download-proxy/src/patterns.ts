/**
 * Shared kernel-artifact patterns. The Worker parses two completely
 * separate inputs against the same shape: URL pathnames (router.ts, with
 * a leading `/`) and bare R2 object keys (listing.ts, without). Both
 * need to agree on what counts as a valid kernel filename, so the body
 * regex is defined once here and anchored two ways below.
 *
 * Accepted shapes:
 *   linux-<version>-<variant>-<arch>.kernel    e.g. linux-6.12.91-base-x86_64.kernel
 *   linux-<version>-SHA256SUMS                 e.g. linux-6.12.91-SHA256SUMS
 *
 * <version>  three dot-separated decimal components (matches kernel.org pin shape)
 * <variant>  lowercase letters (`base`, `windows`, `sev`, `tdx`)
 * <arch>     lowercase + digits + underscore (`x86_64`, `aarch64`, `riscv64`)
 */

const KERNEL_BODY =
  'linux-(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)-(?<variant>[a-z]+)-(?<arch>[a-z0-9_]+)\\.kernel';
const SHA256SUMS_BODY = 'linux-(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)-SHA256SUMS';

/** Match a request pathname (URL.pathname — has a leading `/`). */
export const KERNEL_PATH_PATTERN = new RegExp(`^/${KERNEL_BODY}$`);
export const SHA256SUMS_PATH_PATTERN = new RegExp(`^/${SHA256SUMS_BODY}$`);

/** Match a bare R2 object key (no leading `/`). */
export const KERNEL_KEY_PATTERN = new RegExp(`^${KERNEL_BODY}$`);
export const SHA256SUMS_KEY_PATTERN = new RegExp(`^${SHA256SUMS_BODY}$`);

/** Cap on a candidate URL pathname before regex work. */
export const MAX_PATH_BYTES = 256;

/** Cap on a candidate R2 key before regex work — R2's own limit is 1024. */
export const MAX_KEY_BYTES = 256;
