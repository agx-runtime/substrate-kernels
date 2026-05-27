# ADR 0003 — The kernel bundle format

- **Status:** Accepted
- **Date:** 2026-05-27
- **Context doc:** [../design/bundle-format.md](../design/bundle-format.md) (the
  byte-level layout + the packer); [ADR 0004](0004-boot-contract-with-substrate.md)
  (how substrate consumes it)

## Context

substrate must load the guest kernel and enter it. We avoid a runtime kernel-image
parser by **pre-flattening** the kernel at build time and shipping a small header
that tells the consumer where to load and where to enter — so the hypervisor mmaps
the file, copies the payload, and jumps, with **no ELF/bzImage/Image parser at
runtime**. The boot-contract decision (ADR 0004, chosen with the user) adopts this
model. This ADR fixes the **byte format** of that artifact — the kernel bundle.

The format is a **fixed, versioned struct** — the same fields at the same offsets on
every build. The magic is substrate-native (`SUBK`); the rest of the layout is the
producer↔consumer contract and is not redesigned casually.

Constraints that shape the format:

- It is the one contract shared between substrate-kernel (producer) and substrate
  (consumer); it must be **versioned, fixed-size-header, and golden-tested**
  (CLAUDE.md §4, [testing/bundle-golden.md](../testing/bundle-golden.md)).
- It must carry **everything substrate needs without parsing the kernel**:
  architecture, load + entry addresses, the section alignment, and the byte ranges
  of the kernel and the optional qboot / initrd sections.
- Sections must map cleanly under the host page size (64 KiB normally; 4 KiB for the
  windows variant, recorded in the header).
- **Substrate-native magic** (CLAUDE.md §1): the magic is `SUBK`.

## Decision

1. **A flat little-endian file: a fixed 96-byte header, then `page_size`-aligned
   payload sections** (kernel, then optional qboot, then optional initrd). The
   alignment is 64 KiB for all variants except windows, which uses 4 KiB to match
   the Windows Hypervisor Platform page granularity; the alignment used is recorded
   in the header so the consumer maps sections correctly.

2. **The header layout is fixed; only the magic is substrate-native.**
   Magic `SUBK` (ASCII, "**SU****B**strate **K**ernel"). Field order and offsets
   ([design/bundle-format.md](../design/bundle-format.md)):

   | Off | Size | Field | Notes |
   |---|---|---|---|
   | 0 | 4 | `magic` | `SUBK` |
   | 4 | 4 | `format_version` | u32, currently `1` |
   | 8 | 4 | `abi_version` | u32, the bundle ABI version |
   | 12 | 4 | `arch` | u32: `1`=x86_64, `2`=aarch64, `3`=riscv64 |
   | 16 | 4 | `variant` | u32: `0`=base, `1`=sev, `2`=tdx, `3`=windows |
   | 20 | 4 | `page_size` | u32: section alignment in bytes (`65536`, or `4096` for windows) |
   | 24 | 8 | `load_addr` | u64, guest-physical load base of the kernel payload |
   | 32 | 8 | `entry_addr` | u64, guest-physical entry (ADR 0004) |
   | 40 | 8 | `kernel_offset` | u64, file offset of the kernel section |
   | 48 | 8 | `kernel_size` | u64, page-aligned byte length |
   | 56 | 8 | `qboot_offset` | u64, `0` if absent (TEE only, ADR 0009) |
   | 64 | 8 | `qboot_size` | u64 |
   | 72 | 8 | `initrd_offset` | u64, `0` if absent |
   | 80 | 8 | `initrd_size` | u64 |
   | 88 | 8 | `header_size` | u64, `96` for v1 |

   Packed form: `<4sIIIIIQQQQQQQQQ` — `4s` magic, five `u32` (`format_version`,
   `abi_version`, `arch`, `variant`, `page_size`), then nine `u64`. The 4 + 20 bytes
   before the `u64` block align every address/offset to 8 bytes; `header_size` lets a
   consumer skip forward-compatibly to the first section.

   The offset-20 `reserved` u32 carries the `page_size` here — the one
   substantive use of an otherwise-reserved field, so the windows 4 KiB alignment is
   self-describing. This is offset-preserving: a consumer that
   ignores offset 20 is unaffected.

3. **The `qboot` and `initrd` sections are TEE-only.** For base/windows builds their
   offset/size are `0` (absent). The TEE variants (ADR 0009) carry them. The section
   name `qboot` is kept as-is (it names a minimal firmware stage).

4. **The packer flattens per architecture and asserts its own layout.** x86_64:
   flatten the `vmlinux` PT_LOAD segments into one contiguous, page-padded image
   (padding inter-segment gaps), recording `load_addr` and `entry_addr` per ADR
   0004. aarch64 / riscv64: take the raw `Image` as-is. The packer asserts the
   packed header matches `HEADER_SIZE`, that each section offset is `page_size`-
   aligned, and that sections do not overlap — a payload that would overlap the next
   section is a hard error (CLAUDE.md §5).

5. **The format is versioned and golden-tested.** `format_version` starts at `1`;
   the header layout is locked by a golden test
   ([testing/bundle-golden.md](../testing/bundle-golden.md)) so accidental drift
   fails the build. A real format change bumps `format_version` and both sides
   agree explicitly.

## Consequences

- substrate needs **no kernel-image parser**: it reads a fixed 96-byte header and
  copies + jumps. The ELF/bzImage/Image parser leaves the hypervisor's attack
  surface entirely (ADR 0004) — the parsing is done once, at build time, by the
  packer.
- The producer↔consumer contract is one small, versioned, golden-tested struct;
  drift on either side is a build failure, not a boot-time mystery.
- `page_size` in the header makes the windows 4 KiB / default 64 KiB alignment
  explicit, so the consumer maps sections without hard-coding an assumption.
- The format is substrate-native in name (`SUBK`) and a fixed, versioned struct, so
  substrate's loader is a thin, stable contract (CLAUDE.md §1).

## Alternatives considered

- **Ship a raw standard image (bzImage / Image) and parse it in substrate** —
  rejected at the boot-contract decision (ADR 0004): it puts a full kernel-image
  parser on the hypervisor's untrusted-input surface, the opposite of the
  pre-flattened model the user chose.
- **Redesign the header (e.g. a `capability_flags` bitset replacing `abi_version`)**
  — rejected: the layout is a fixed, versioned producer↔consumer contract, and
  substrate reads specific field offsets (`abi_version`@8, `arch`@12, `variant`@16),
  so a reshuffle would break the consumer for no gain. We keep the layout stable.
- **Embed the boot data (`boot_params` / FDT / ACPI) in the bundle** — rejected:
  that boot data depends on the *VM's* memory map, vCPU count, and command line,
  which only substrate knows at run time; the bundle carries the kernel, substrate
  builds the boot data (ADR 0004).
- **A self-describing/extensible (TLV) header** — rejected as over-engineering: a
  fixed-size, versioned struct is simpler and golden-testable; `header_size` gives
  forward-compatible section skipping, and a real format change can bump
  `format_version`.
