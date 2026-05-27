# Design: the kernel bundle format + `pack-kernel`

The byte-level layout of the `.kernel` bundle and the packer that produces it. The
format is the one contract shared with substrate ([ADR 0003](../adr/0003-kernel-bundle-format.md));
its semantics — what the addresses mean and how substrate enters — are the boot
contract ([ADR 0004](../adr/0004-boot-contract-with-substrate.md)). The packer is a
small, self-contained packer; the bundle's 4-byte magic is the
substrate-native `SUBK`.

## Background

The packer: its flat 96-byte header (`struct`
`<4sIIIIIQQQQQQQQQ>` — 4-byte magic, `format_version`, `abi_version`, `arch`,
`variant`, a reserved `u32`, then `load_addr`, `entry_addr`, and three
offset/size section pairs `kernel`/`qboot`/`initrd`, `header_size`), its ELF
flattening (`PT_LOAD` segments concatenated with inter-segment gap padding,
`load_addr` from the first segment's `p_vaddr & 0xFFFFFFF`, `entry_addr` from the
ELF `e_entry`), its raw-`Image` path (read + page-pad, `load_addr` = `entry_addr` =
`0x80000000`), its 64 KiB section alignment, and its build-time layout assertion
(`struct.calcsize(...) == HEADER_SIZE`). A legacy C-blob packing path (which
produced a `.c` array and used 4 KiB windows alignment) is superseded by the current
flat-file packer and not carried.

## Subtle details & gotchas

| Detail | Convention | Our handling | Gate |
|---|---|---|---|
| **Header size must be locked at compile/run time** — a field added without bumping the size mis-parses on the consumer | asserts `calcsize == 96` | same assert + a **golden test** of the packed header bytes; `header_size` field is authoritative for section skipping | [bundle-golden.md](../testing/bundle-golden.md) |
| **x86 entry = ELF `e_entry`** — `e_entry` is `startup_64`, the 64-bit boot_params entry; substrate enters there in 64-bit long mode (no PVH) | records `e_entry` | **same: `entry_addr` = `e_entry`** ([ADR 0004](../adr/0004-boot-contract-with-substrate.md)); no PVH note extraction | boot-smoke + an e_entry-extraction unit check |
| **x86 `load_addr`** — recover the physical load base from the kernel virtual address | `p_vaddr & 0xFFFFFFF` (first PT_LOAD) | **same** `p_vaddr & 0xFFFFFFF`; cross-checked against `p_paddr` via the layout assert | bundle-golden + boot-smoke |
| **PT_LOAD gap/overlap** — segments may have padding gaps; an overlap is corruption | pads gaps, errors on overlap | same: pad inter-segment gaps with zeros, **hard-error on overlap** (no silent truncation, CLAUDE.md §5) | packer self-assert + golden |
| **aarch64 / riscv64 raw Image** | takes Image raw, hardcodes `load_addr` = `entry_addr` = `0x80000000` | **same** hardcoded `0x80000000` ([ADR 0004](../adr/0004-boot-contract-with-substrate.md)) | boot-smoke |
| **Section alignment vs host page size** | 64 KiB (current packer); 4 KiB windows lived in the legacy C-blob packer | **64 KiB normally; 4 KiB for the windows variant**, recorded in the header `page_size` field so it is self-describing ([ADR 0003](../adr/0003-kernel-bundle-format.md)) | bundle-golden (offsets % `page_size` == 0) |
| **Absent sections** — qboot/initrd are TEE-only | offset/size = 0 when absent | base/windows bundles set qboot/initrd offset+size to 0; substrate treats 0 as absent | bundle-golden |

## Our design

**Header (96 bytes, little-endian)** — the field table is canonical in
[ADR 0003](../adr/0003-kernel-bundle-format.md) §Decision-2. Packed form
(`struct` notation): `<4sIIIIIQQQQQQQQQ` — `4s` magic, five `u32`
(`format_version`, `abi_version`, `arch`, `variant`, `page_size`), then nine `u64`
(`load_addr`, `entry_addr`, `kernel_offset`, `kernel_size`, `qboot_offset`,
`qboot_size`, `initrd_offset`, `initrd_size`, `header_size`). The 4 + 20 bytes
before the `u64` block align every address/offset to 8 bytes;
`assert struct.calcsize(...) == 96` at packer startup. Magic is `SUBK`; the offset-20 `reserved` u32 carries `page_size`.

**File layout** (alignment = `page_size`: 64 KiB normally, 4 KiB for windows)

```
0      header (96 B)
       pad to page_size
       kernel section (page-aligned size)
       pad to page_size
       qboot section  (TEE only; absent ⇒ offset/size = 0)
       pad to page_size
       initrd section (TEE only; absent ⇒ offset/size = 0)
```

**`pack-kernel` (the packer)** — `scripts/pack-kernel.py`, a faithful
self-contained packer:

- `--arch {x86_64,aarch64,riscv64} --variant {base,sev,tdx,windows}
  --abi-version N --kernel <vmlinux|Image> [--qboot F] [--initrd I] --output <file>`.
- **x86_64:** parse the ELF, flatten PT_LOAD into a contiguous page-padded image
  (pad gaps, error on overlap), set `load_addr` = first PT_LOAD `p_vaddr & 0xFFFFFFF`
  and `entry_addr` = ELF `e_entry`.
- **aarch64 / riscv64:** read the Image, page-pad; `load_addr` = `entry_addr` =
  `0x80000000`.
- `page_size` = `4096` for the windows variant, else `65536`; sections are aligned
  to `page_size` and the value is written into the header.
- Assemble header + `page_size`-aligned sections; assert layout (header size,
  alignment, non-overlap) before writing.

## Verification

bundle-golden ([testing/bundle-golden.md](../testing/bundle-golden.md)) locks the
header bytes and the alignment/offset invariants (offsets % `page_size`, non-overlap,
`header_size == 96`); the packer's self-asserts catch layout errors at build time;
boot-smoke ([testing/boot-smoke.md](../testing/boot-smoke.md)) proves the addresses
are right by booting a real guest. The `e_entry` extraction and the Image-header
handling have focused unit checks so the x86 `entry_addr` and the raw-Image path
cannot regress silently.
