/**
 * Pure-function tests for listing.ts. Targets the parser + grouping +
 * helpers directly. The R2 listing path (`listKernels`) is exercised by
 * `test/integration.test.ts` against the miniflare R2 binding.
 */

import { describe, expect, it } from 'vitest';
import {
  channelDescription,
  channelLabel,
  compareSemver,
  groupByVersionLine,
  humanDate,
  humanSize,
  type KernelArtifact,
  parseKernelKey,
  pickFeatured,
  type Sha256SumsArtifact,
  shortHash,
  versionLine,
} from '../src/listing.ts';

function k(overrides: Partial<KernelArtifact>): KernelArtifact {
  return {
    key: 'linux-6.12.91-base-x86_64.kernel',
    version: '6.12.91',
    variant: 'base',
    arch: 'x86_64',
    size: 23_000_000,
    uploaded: new Date('2026-05-01T00:00:00Z'),
    etag: '"abcd1234ef567890"',
    ...overrides,
  };
}

function s(overrides: Partial<Sha256SumsArtifact>): Sha256SumsArtifact {
  return {
    key: 'linux-6.12.91-SHA256SUMS',
    version: '6.12.91',
    size: 256,
    uploaded: new Date('2026-05-01T00:00:00Z'),
    etag: '"sumsetag"',
    ...overrides,
  };
}

describe('parseKernelKey — accepts', () => {
  it('base × x86_64 kernel', () => {
    expect(parseKernelKey('linux-6.12.91-base-x86_64.kernel')).toEqual({
      kind: 'kernel',
      version: '6.12.91',
      variant: 'base',
      arch: 'x86_64',
    });
  });
  it('base × aarch64 kernel', () => {
    const r = parseKernelKey('linux-6.12.91-base-aarch64.kernel');
    expect(r).toMatchObject({ kind: 'kernel', arch: 'aarch64' });
  });
  it('base × riscv64 kernel', () => {
    const r = parseKernelKey('linux-6.12.91-base-riscv64.kernel');
    expect(r).toMatchObject({ kind: 'kernel', arch: 'riscv64' });
  });
  it('windows × x86_64 kernel', () => {
    const r = parseKernelKey('linux-6.12.91-windows-x86_64.kernel');
    expect(r).toMatchObject({ kind: 'kernel', variant: 'windows' });
  });
  it('debug × x86_64 kernel', () => {
    const r = parseKernelKey('linux-6.12.91-debug-x86_64.kernel');
    expect(r).toMatchObject({ kind: 'kernel', variant: 'debug', arch: 'x86_64' });
  });
  it('debug × aarch64 kernel', () => {
    const r = parseKernelKey('linux-6.12.91-debug-aarch64.kernel');
    expect(r).toMatchObject({ kind: 'kernel', variant: 'debug', arch: 'aarch64' });
  });
  it('SHA256SUMS', () => {
    expect(parseKernelKey('linux-6.12.91-SHA256SUMS')).toEqual({
      kind: 'sums',
      version: '6.12.91',
    });
  });
});

describe('parseKernelKey — rejects', () => {
  it('empty key', () => expect(parseKernelKey('')).toBeNull());
  it('leading slash (that is path territory)', () =>
    expect(parseKernelKey('/linux-6.12.91-base-x86_64.kernel')).toBeNull());
  it('garbage', () => expect(parseKernelKey('not-a-kernel')).toBeNull());
  it('missing version', () =>
    expect(parseKernelKey('linux-base-x86_64.kernel')).toBeNull());
  it('uppercase variant', () =>
    expect(parseKernelKey('linux-6.12.91-Base-x86_64.kernel')).toBeNull());
  it('wrong extension', () =>
    expect(parseKernelKey('linux-6.12.91-base-x86_64.tar.gz')).toBeNull());
  it('lowercase sha256sums (case-sensitive)', () =>
    expect(parseKernelKey('linux-6.12.91-sha256sums')).toBeNull());
  it('absurdly long key', () =>
    expect(parseKernelKey('a'.repeat(500))).toBeNull());
});

describe('versionLine / channelLabel / channelDescription', () => {
  it('strips the patch component', () => {
    expect(versionLine('6.12.91')).toBe('6.12');
    expect(versionLine('5.15.165')).toBe('5.15');
  });
  it('labels known LTS lines', () => {
    expect(channelLabel('6.6')).toBe('LTS · 6.6');
    expect(channelLabel('5.15')).toBe('LTS · 5.15');
    expect(channelDescription('6.6')).toMatch(/long-term/);
  });
  it('labels unknown lines as Mainline', () => {
    expect(channelLabel('7.0')).toBe('Mainline · 7.0');
    expect(channelDescription('7.0')).toMatch(/mainline/);
  });
});

describe('compareSemver', () => {
  it('orders patches', () => {
    expect(compareSemver('6.12.91', '6.12.90')).toBe(1);
    expect(compareSemver('6.12.90', '6.12.91')).toBe(-1);
    expect(compareSemver('6.12.91', '6.12.91')).toBe(0);
  });
  it('orders minors and majors', () => {
    expect(compareSemver('6.12.0', '6.6.99')).toBe(1);
    expect(compareSemver('7.0.0', '6.99.99')).toBe(1);
  });
});

describe('humanSize', () => {
  it('B / KB / MB / GB', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(2_500_000)).toBe('2.4 MB');
    expect(humanSize(23_000_000)).toBe('21.9 MB');
    expect(humanSize(2_500_000_000)).toBe('2.3 GB');
  });
  it('returns — on garbage', () => {
    expect(humanSize(Number.NaN)).toBe('—');
    expect(humanSize(-1)).toBe('—');
  });
});

describe('humanDate', () => {
  it('formats UTC date', () => {
    expect(humanDate(new Date('2024-08-03T15:30:00Z'))).toBe('Aug 3, 2024');
    expect(humanDate(new Date('2026-01-15T00:00:00Z'))).toBe('Jan 15, 2026');
  });
  it('handles bad input', () => {
    expect(humanDate(new Date('invalid'))).toBe('—');
  });
});

describe('shortHash', () => {
  it('strips quotes and ellipsizes', () => {
    expect(shortHash('"abcd1234ef567890"')).toBe('abcd…7890');
  });
  it('passes through short values', () => {
    expect(shortHash('"abc"')).toBe('abc');
  });
});

describe('groupByVersionLine', () => {
  it('groups versions, attaches sums, sorts newest-first', () => {
    const out = groupByVersionLine(
      [
        k({ version: '6.12.90', uploaded: new Date('2026-04-01Z') }),
        k({ version: '6.12.91', uploaded: new Date('2026-05-01Z') }),
        k({
          version: '6.12.91',
          arch: 'aarch64',
          key: 'linux-6.12.91-base-aarch64.kernel',
          uploaded: new Date('2026-05-01Z'),
        }),
        k({
          version: '6.6.50',
          arch: 'x86_64',
          key: 'linux-6.6.50-base-x86_64.kernel',
          uploaded: new Date('2026-04-15Z'),
        }),
      ],
      [s({ version: '6.12.91' }), s({ version: '6.6.50', key: 'linux-6.6.50-SHA256SUMS' })],
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.line).toBe('6.12'); // newest line first
    expect(out[0]!.label).toBe('LTS · 6.12');
    expect(out[0]!.versions).toHaveLength(2);
    expect(out[0]!.versions[0]!.version).toBe('6.12.91'); // newest patch first
    expect(out[0]!.versions[0]!.isNewest).toBe(true);
    expect(out[0]!.versions[1]!.version).toBe('6.12.90');
    expect(out[0]!.versions[1]!.isNewest).toBe(false);
    expect(out[0]!.versions[0]!.artifacts.map((a) => a.arch)).toEqual([
      'x86_64',
      'aarch64', // stable arch order
    ]);
    expect(out[0]!.versions[0]!.sums?.version).toBe('6.12.91');
    expect(out[1]!.line).toBe('6.6');
  });

  it('returns [] when no kernels', () => {
    expect(groupByVersionLine([], [])).toEqual([]);
  });

  it('handles a kernel without a matching sums file', () => {
    const out = groupByVersionLine([k({})], []);
    expect(out[0]!.versions[0]!.sums).toBeNull();
  });

  it('orders base before debug for the same (version, arch)', () => {
    const out = groupByVersionLine(
      [
        k({ variant: 'debug', key: 'linux-6.12.91-debug-x86_64.kernel' }),
        k({ variant: 'base' }),
        k({
          variant: 'debug',
          arch: 'aarch64',
          key: 'linux-6.12.91-debug-aarch64.kernel',
        }),
        k({
          variant: 'base',
          arch: 'aarch64',
          key: 'linux-6.12.91-base-aarch64.kernel',
        }),
      ],
      [],
    );
    const artifacts = out[0]!.versions[0]!.artifacts;
    expect(artifacts.map((a) => `${a.variant}-${a.arch}`)).toEqual([
      'base-x86_64',
      'base-aarch64',
      'debug-x86_64',
      'debug-aarch64',
    ]);
  });
});

describe('pickFeatured', () => {
  it('returns the newest mainline version', () => {
    // 7.0 is mainline (unknown to KNOWN_LTS_LINES), 6.12 is LTS.
    const lines = groupByVersionLine(
      [
        k({ version: '7.0.0', key: 'linux-7.0.0-base-x86_64.kernel' }),
        k({ version: '6.12.91' }),
      ],
      [],
    );
    expect(pickFeatured(lines)?.version).toBe('7.0.0');
  });
  it('falls back to newest LTS if no mainline', () => {
    const lines = groupByVersionLine([k({ version: '6.12.91' })], []);
    expect(pickFeatured(lines)?.version).toBe('6.12.91');
  });
  it('returns null on empty', () => {
    expect(pickFeatured([])).toBeNull();
  });
});
