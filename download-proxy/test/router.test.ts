/**
 * Pure-function tests for the pathname parser. Covers every accepted
 * pattern (each currently-shipping (arch × variant) cell plus SHA256SUMS)
 * and a representative set of rejections.
 */

import { describe, expect, it } from 'vitest';
import { parsePath } from '../src/router.ts';

describe('parsePath — accepted', () => {
  it('base × x86_64 kernel bundle', () => {
    const r = parsePath('/linux-6.12.91-base-x86_64.kernel');
    expect(r).not.toBeNull();
    expect(r!.r2_key).toBe('linux-6.12.91-base-x86_64.kernel');
    expect(r!.package).toBe('linux-base-x86_64');
    expect(r!.version).toBe('6.12.91');
    expect(r!.content_type).toBe('application/octet-stream');
  });

  it('base × aarch64 kernel bundle', () => {
    const r = parsePath('/linux-6.12.91-base-aarch64.kernel');
    expect(r!.package).toBe('linux-base-aarch64');
    expect(r!.version).toBe('6.12.91');
  });

  it('base × riscv64 kernel bundle (carried but not CI-gated)', () => {
    const r = parsePath('/linux-6.12.91-base-riscv64.kernel');
    expect(r!.package).toBe('linux-base-riscv64');
  });

  it('windows × x86_64 kernel bundle', () => {
    const r = parsePath('/linux-6.12.91-windows-x86_64.kernel');
    expect(r!.package).toBe('linux-windows-x86_64');
  });

  it('sev × x86_64 kernel bundle (TEE variant, carried)', () => {
    const r = parsePath('/linux-6.12.91-sev-x86_64.kernel');
    expect(r!.package).toBe('linux-sev-x86_64');
  });

  it('tdx × x86_64 kernel bundle (TEE variant, carried)', () => {
    const r = parsePath('/linux-6.12.91-tdx-x86_64.kernel');
    expect(r!.package).toBe('linux-tdx-x86_64');
  });

  it('SHA256SUMS for a version', () => {
    const r = parsePath('/linux-6.12.91-SHA256SUMS');
    expect(r!.r2_key).toBe('linux-6.12.91-SHA256SUMS');
    expect(r!.package).toBe('linux-SHA256SUMS');
    expect(r!.version).toBe('6.12.91');
    expect(r!.content_type).toBe('text/plain; charset=utf-8');
  });
});

describe('parsePath — rejected', () => {
  it('root', () => {
    expect(parsePath('/')).toBeNull();
  });
  it('unrelated path', () => {
    expect(parsePath('/foo')).toBeNull();
  });
  it('missing version', () => {
    expect(parsePath('/linux-base-x86_64.kernel')).toBeNull();
  });
  it('non-numeric version', () => {
    expect(parsePath('/linux-six.twelve.ninetyone-base-x86_64.kernel')).toBeNull();
  });
  it('missing variant or arch', () => {
    expect(parsePath('/linux-6.12.91-.kernel')).toBeNull();
    expect(parsePath('/linux-6.12.91-base-.kernel')).toBeNull();
  });
  it('wrong extension', () => {
    expect(parsePath('/linux-6.12.91-base-x86_64.tar.gz')).toBeNull();
  });
  it('uppercase variant (reserved for matching repo conventions)', () => {
    expect(parsePath('/linux-6.12.91-Base-x86_64.kernel')).toBeNull();
  });
  it('path traversal sequence', () => {
    expect(parsePath('/../etc/passwd')).toBeNull();
    expect(parsePath('/linux-6.12.91-base-x86_64.kernel/../secret')).toBeNull();
  });
  it('query-string in path (parser only sees pathname; this is defense in depth)', () => {
    expect(parsePath('/linux-6.12.91-base-x86_64.kernel?evil=1')).toBeNull();
  });
  it('absurdly long path (bounded)', () => {
    const longPath = `/${'a'.repeat(500)}`;
    expect(parsePath(longPath)).toBeNull();
  });
  it('SHA256SUMS with wrong suffix', () => {
    expect(parsePath('/linux-6.12.91-SHA256')).toBeNull();
    expect(parsePath('/linux-6.12.91-sha256sums')).toBeNull();
  });
});
