# ADR 0002 — Target architectures

- **Status:** Accepted
- **Date:** 2026-05-27
- **Context doc:** [../architecture.md](../architecture.md) §4 (the architecture ×
  variant matrix)

## Context

substrate runs on **KVM (Linux) and HVF (macOS), on x86_64 and aarch64** (substrate
CLAUDE.md §1). Those two architectures are the live boot targets the kernel must
support. We also carry **riscv64** and a **windows** (Hyper-V-enlightened, for the
Windows Hypervisor Platform) config as buildable, non-gated targets for
completeness, so the build matrix is ready if a consumer ever appears — but they are
not part of the substrate boot contract.

## Decision

1. **Carry x86_64, aarch64, and riscv64 base configs.** x86_64 and aarch64 are
   substrate's live targets; riscv64 is carried as a buildable, non-gated target.

2. **Carry the windows variant** (Hyper-V-enlightened x86_64 config). The windows
   bundle is aligned to 4 KiB to match the Windows Hypervisor Platform page
   granularity (recorded in the header `page_size`, ADR 0003); non-windows bundles
   use 64 KiB.

3. **CI / boot-smoke cover x86_64 + aarch64 only.** These are substrate's hosts.
   riscv64 and windows are buildable but not CI-gated and not part of the substrate
   boot contract (there is no substrate consumer for them yet).

4. **The matrix is (x86_64, aarch64, riscv64) × base, plus (x86_64) × {sev, tdx,
   windows}.** sev/tdx are x86-only confidential-compute variants (ADR 0009);
   windows is an x86-only host variant. Each cell is a full `.config` (ADR 0006) and
   a named artifact `linux-<version>-<variant>-<arch>.kernel`.

5. **Per-architecture kernel-binary handling is explicit.** x86_64 builds a
   `vmlinux` ELF that the packer flattens; aarch64 and riscv64 build a raw `Image`
   the packer takes as-is (ADR 0003, ADR 0004). The paths are documented, not
   implicit.

## Consequences

- The build supports x86_64 / aarch64 / riscv64 base plus the x86-only sev / tdx /
  windows variants — substrate's hosts are first-class, the rest stay buildable.
- CI stays focused on substrate's real hosts (x86_64 + aarch64) without forcing
  riscv64 / windows emulators into the gate, while still keeping their configs
  buildable and golden-tested.
- The header records the per-variant `page_size`, so the windows 4 KiB alignment
  and the default 64 KiB alignment coexist in one format (ADR 0003).

## Alternatives considered

- **Carry x86_64 + aarch64 only (a substrate-hosts-only matrix)** — rejected:
  riscv64 and a windows config cost almost nothing to keep buildable and leave the
  matrix ready for a future consumer; CI is simply scoped to substrate's live hosts
  so the extra cells impose no per-PR cost.
- **CI-gate riscv64 and windows too** — rejected for now: substrate does not run
  them, so a boot-smoke has no real consumer and the emulator/firmware cost is not
  justified; they remain buildable + golden-tested.
- **Build a single "fat" multi-arch artifact** — rejected: the bundle is a
  pre-flattened, arch-specific load image with arch-specific `load_addr`/
  `entry_addr` (ADR 0003/0004); one artifact per (arch, variant) is the natural and
  simplest shape.
