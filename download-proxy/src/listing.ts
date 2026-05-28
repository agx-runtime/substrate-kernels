/**
 * R2 bucket → grouped, sorted listing for the `/` page.
 *
 * Pure helpers + one I/O function (`listKernels`) that reads the bucket
 * once via the binding. The output is the shape `html.ts` consumes — no
 * rendering, no HTML, no globals. Tests target the pure helpers directly
 * and seed a fake R2 binding for `listKernels`.
 *
 * docs/design/download-proxy.md "Listing" section.
 */

import {
  KERNEL_KEY_PATTERN,
  MAX_KEY_BYTES,
  SHA256SUMS_KEY_PATTERN,
} from './patterns.ts';
import type { Env } from './types.ts';

/** Display order — arches present in fewer artifacts appear later. */
export const ARCH_ORDER = ['x86_64', 'aarch64', 'riscv64'] as const;
export type Arch = (typeof ARCH_ORDER)[number] | string;

/** Display order — channels with fewer artifacts appear later. */
export type Channel = 'base' | 'windows' | 'sev' | 'tdx' | string;

/**
 * Channel-line label. Pinned LTS lines come from kernel.org's known LTS
 * series; everything else is labelled "Mainline". Adjust when kernel.org
 * declares a new LTS line. docs/adr/0001 (the source pin) is the
 * authority on which line we ship.
 */
const KNOWN_LTS_LINES: ReadonlySet<string> = new Set([
  '4.14',
  '4.19',
  '5.4',
  '5.10',
  '5.15',
  '6.1',
  '6.6',
  '6.12',
]);

export interface KernelArtifact {
  /** Bare R2 key — feeds directly into a `/<key>` download URL. */
  key: string;
  version: string;
  variant: Channel;
  arch: Arch;
  /** Bytes on disk. */
  size: number;
  /** Upload time (CF R2 records this). */
  uploaded: Date;
  /** R2's content-addressable hash, formatted with the quotes CF emits. */
  etag: string;
}

export interface Sha256SumsArtifact {
  key: string;
  version: string;
  size: number;
  uploaded: Date;
  etag: string;
}

/** Heading row that introduces a version line in the table. */
export interface VersionLineGroup {
  /** Major.minor identifier, e.g. `6.12`. */
  line: string;
  /** Channel-aware label, e.g. `Mainline · 6.12` or `LTS · 6.6`. */
  label: string;
  description: string;
  /** Versions in this line, newest patch first. */
  versions: VersionGroup[];
}

/** All artifacts for one specific version, e.g. `6.12.91`. */
export interface VersionGroup {
  version: string;
  /** Artifacts (channel × arch) for this version, in display order. */
  artifacts: KernelArtifact[];
  /** Per-version checksums file, if present in the bucket. */
  sums: Sha256SumsArtifact | null;
  /**
   * `true` for the newest patch in its version line — drives the `NEW`
   * pill in the table.
   */
  isNewest: boolean;
}

export interface Listing {
  lines: VersionLineGroup[];
  /** Curated featured card target (the substrate-bench "decision"). */
  featured: VersionGroup | null;
  /** Total artifact count (including SHA256SUMS) — for the page meta. */
  totalArtifacts: number;
  /** Newest upload time across all artifacts — for the meta bar. */
  lastUpdated: Date | null;
}

// ---------------------------------------------------------------------------
// Pure parsing + formatting helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parsed shape of an R2 key, or null if the key is not a kernel artifact. */
export type ParsedKey =
  | { kind: 'kernel'; version: string; variant: string; arch: string }
  | { kind: 'sums'; version: string }
  | null;

export function parseKernelKey(key: string): ParsedKey {
  if (key.length === 0 || key.length > MAX_KEY_BYTES) return null;
  const kernel = KERNEL_KEY_PATTERN.exec(key);
  if (kernel?.groups) {
    const { version, variant, arch } = kernel.groups;
    if (!version || !variant || !arch) return null;
    return { kind: 'kernel', version, variant, arch };
  }
  const sums = SHA256SUMS_KEY_PATTERN.exec(key);
  if (sums?.groups) {
    const { version } = sums.groups;
    if (!version) return null;
    return { kind: 'sums', version };
  }
  return null;
}

/** `6.12.91` → `6.12` (the version line). */
export function versionLine(version: string): string {
  const parts = version.split('.');
  return `${parts[0] ?? '0'}.${parts[1] ?? '0'}`;
}

/** Pretty label for the table sub-header row. */
export function channelLabel(line: string): string {
  return KNOWN_LTS_LINES.has(line) ? `LTS · ${line}` : `Mainline · ${line}`;
}

export function channelDescription(line: string): string {
  return KNOWN_LTS_LINES.has(line)
    ? 'long-term support · security backports'
    : 'latest mainline kernel';
}

/**
 * `1 -1` semver compare on three-component numeric versions. Newer
 * (higher) wins; returns -1 / 0 / 1 like Array.sort callbacks.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/** Compare two version lines (`6.12`, `6.6`, …) — newest first. */
function compareLines(a: string, b: string): number {
  const [aMaj, aMin] = a.split('.').map(Number) as [number, number];
  const [bMaj, bMin] = b.split('.').map(Number) as [number, number];
  if (aMaj !== bMaj) return bMaj - aMaj;
  return bMin - aMin;
}

/** Stable arch order so x86_64 lands before aarch64 lands before riscv64. */
function archRank(arch: string): number {
  const i = (ARCH_ORDER as readonly string[]).indexOf(arch);
  return i === -1 ? ARCH_ORDER.length : i;
}

/** Channel display order — base first, then anything else alphabetically. */
function channelRank(variant: string): number {
  if (variant === 'base') return 0;
  if (variant === 'windows') return 1;
  if (variant === 'sev') return 2;
  if (variant === 'tdx') return 3;
  return 4;
}

/** Bytes → human-readable (`12.4 MB`, `983 KB`). KiB-base. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // 12.4 if < 100, otherwise 124 (one digit of precision is plenty).
  const formatted = v >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `${formatted} ${units[i]}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Date → `Aug 3, 2024` (UTC; matches the design's mockup format). */
export function humanDate(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '—';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Render the R2 ETag header (which arrives quoted) as `9f2c…a4b3`. */
export function shortHash(etag: string): string {
  const trimmed = etag.replace(/^"|"$/g, '');
  if (trimmed.length <= 9) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// R2 → grouped listing
// ---------------------------------------------------------------------------

/**
 * Build a fully-grouped Listing from the R2 bucket. Lists once with the
 * `linux-` prefix (matches both `.kernel` and `SHA256SUMS`), discards
 * keys that don't parse, then groups.
 *
 * Truncation: R2's default page size is 1000 and we have on the order of
 * dozens of artifacts long-term. If the bucket ever overflows we'll need
 * a cursor loop — for now, log + truncate so the page still renders.
 */
export async function listKernels(env: Env): Promise<Listing> {
  const objects = await env.KERNELS.list({ prefix: 'linux-' });
  if (objects.truncated) {
    console.warn(
      'download-proxy: R2 list truncated at default page size — extend listKernels with a cursor loop',
      { count: objects.objects.length },
    );
  }

  const kernels: KernelArtifact[] = [];
  const sums: Sha256SumsArtifact[] = [];
  let lastUpdated: Date | null = null;

  for (const obj of objects.objects) {
    const parsed = parseKernelKey(obj.key);
    if (!parsed) continue;
    const uploaded = obj.uploaded ?? new Date(0);
    if (lastUpdated === null || uploaded > lastUpdated) lastUpdated = uploaded;
    if (parsed.kind === 'kernel') {
      kernels.push({
        key: obj.key,
        version: parsed.version,
        variant: parsed.variant,
        arch: parsed.arch,
        size: obj.size,
        uploaded,
        etag: obj.httpEtag,
      });
    } else {
      sums.push({
        key: obj.key,
        version: parsed.version,
        size: obj.size,
        uploaded,
        etag: obj.httpEtag,
      });
    }
  }

  const lines = groupByVersionLine(kernels, sums);
  const featured = pickFeatured(lines);

  return {
    lines,
    featured,
    totalArtifacts: kernels.length + sums.length,
    lastUpdated,
  };
}

/**
 * Group a flat artifact list into `version line → version → artifacts`,
 * sorted newest-first throughout. Exported for testing.
 */
export function groupByVersionLine(
  kernels: ReadonlyArray<KernelArtifact>,
  sumsList: ReadonlyArray<Sha256SumsArtifact>,
): VersionLineGroup[] {
  const sumsByVersion = new Map<string, Sha256SumsArtifact>();
  for (const s of sumsList) sumsByVersion.set(s.version, s);

  const byLine = new Map<string, Map<string, KernelArtifact[]>>();
  for (const k of kernels) {
    const line = versionLine(k.version);
    let versions = byLine.get(line);
    if (!versions) {
      versions = new Map();
      byLine.set(line, versions);
    }
    let artifacts = versions.get(k.version);
    if (!artifacts) {
      artifacts = [];
      versions.set(k.version, artifacts);
    }
    artifacts.push(k);
  }

  const lineLabels = [...byLine.keys()].sort(compareLines);
  return lineLabels.map((line) => {
    const versions = byLine.get(line) ?? new Map<string, KernelArtifact[]>();
    const versionStrings = [...versions.keys()].sort((a, b) => compareSemver(b, a));
    const built: VersionGroup[] = versionStrings.map((v, i) => {
      const list = (versions.get(v) ?? []).slice().sort((a, b) => {
        const c = channelRank(a.variant) - channelRank(b.variant);
        if (c !== 0) return c;
        return archRank(a.arch) - archRank(b.arch);
      });
      return {
        version: v,
        artifacts: list,
        sums: sumsByVersion.get(v) ?? null,
        isNewest: i === 0,
      };
    });
    return {
      line,
      label: channelLabel(line),
      description: channelDescription(line),
      versions: built,
    };
  });
}

/**
 * Substrate-bench "decision" applied: curate the Featured card rather
 * than deriving it. Pick the newest version on the newest non-LTS line
 * we have; fall back to the newest version overall.
 */
export function pickFeatured(lines: ReadonlyArray<VersionLineGroup>): VersionGroup | null {
  const mainline = lines.find((l) => !KNOWN_LTS_LINES.has(l.line));
  if (mainline?.versions.length) return mainline.versions[0] ?? null;
  for (const line of lines) {
    if (line.versions.length) return line.versions[0] ?? null;
  }
  return null;
}
