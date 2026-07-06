# Bundle golden

Golden tests that lock the bundle's byte layout so format drift fails the build.
The bundle header is the one contract shared with substrate
([ADR 0003](../adr/0003-kernel-bundle-format.md)); an accidental field reorder,
size change, or alignment slip would silently mis-parse on the consumer. This is
substrate-kernels' analogue of substrate's `insta` golden tests.

## What it locks

- **The header bytes.** From known inputs (a fixed arch/variant, fixed
  abi_version/page_size/load/entry/offset/size values), the packed 96-byte header is
  compared to committed golden bytes. A field reorder, a width change, or a magic
  typo changes the bytes and fails the build.
- **The per-arch raw-Image load/entry addresses.** Fixtures routed through the
  packer's `pack()` itself (a synthetic arm64 Image with a valid header for
  aarch64, a raw blob for riscv64) lock the computed addresses in golden bytes —
  aarch64 = the consumer's DRAM base `0x40000000` + the header's `text_offset`,
  riscv64 = `0x80000000` ([ADR 0004](../adr/0004-boot-contract-with-substrate.md)).
  An address drift fails here, at build time, not as a guest that cannot map its
  kernel section.
- **`HEADER_SIZE == 96`.** Asserted by the packer at startup
  (`struct.calcsize(...) == HEADER_SIZE`, [bundle-format.md](../design/bundle-format.md))
  *and* pinned by the golden, so the two cannot disagree.
- **Alignment + non-overlap invariants.** For a representative bundle: every section
  offset is a multiple of the header's `page_size` (64 KiB normally, 4 KiB for
  windows); sections do not overlap; absent sections (base qboot/initrd) have
  offset/size `0`. These are checked as properties over the packer's output,
  complementing the byte golden.
- **The `page_size` recording.** The header `page_size` field matches the alignment
  actually used (4096 for windows, 65536 otherwise), so the windows-vs-default
  alignment is locked and any drift is a visible, reviewed change
  ([ADR 0003](../adr/0003-kernel-bundle-format.md)).

## How a change is handled

A *deliberate* format change bumps `format_version`, updates the packer and the
golden together in the same change, and is mirrored on substrate's consumer side —
the golden update is the reviewable record of the contract change. An *accidental*
change (the common case) fails the golden with a byte diff, which is the point.

## What it does not do

The golden locks the *layout*, not that the *payload boots* — that is boot-smoke
([boot-smoke.md](boot-smoke.md)). It runs on the packer's output without a kernel
build (synthetic payloads of known size), so it is fast and host-independent
([testing/strategy.md](strategy.md) platform matrix): it belongs to the
input/artifact gate tier, not the boundary tier.

## Determinism

The packer is deterministic given its inputs (fixed field order, explicit zero
padding, no host-dependent state — [reproducibility.md](../design/reproducibility.md)),
so the golden is stable across hosts. If a golden ever differs by host, that is a
packer-nondeterminism bug to root-cause (CLAUDE.md §9), not a golden to loosen.
