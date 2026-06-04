# ADR 0004 — The boot contract with substrate

- **Status:** Accepted
- **Date:** 2026-05-27
- **Context doc:** [../architecture.md](../architecture.md) §1 (the artifact
  contract); [ADR 0003](0003-kernel-bundle-format.md) (the bundle the contract
  rides on)

## Context

The producer (substrate-kernels) and the consumer (substrate) must agree on exactly
how the guest kernel is loaded and entered. There are two opposing models:

- **Pre-flattened bundle**: the build flattens the kernel into a raw load image and
  records `load_addr` / `entry_addr` in a header; substrate copies the payload and
  jumps, with **no kernel-image parser**.
- **Raw standard image**: substrate-kernels ships a stock bzImage / Image and
  substrate parses it at runtime (the model substrate's early `docs/design/boot.md`
  sketched, mirroring rust-vmm's `linux-loader`).

**Decision taken with the user: the pre-flattened bundle.** This ADR fixes the
semantics of that contract — what the header's addresses mean per architecture, and
the crucial point that *the bundle removes image parsing, not boot-data setup*. The
addresses and the entry path are the standard x86/64 and arm64 Linux boot
protocols; the bundle just carries them.

## Decision

1. **substrate loads by copy-and-jump, never by parsing.** It mmaps the bundle
   (ADR 0003), copies `[kernel_offset, kernel_offset+kernel_size)` to guest-physical
   `load_addr`, and sets the boot vCPU's entry to `entry_addr`. No ELF, bzImage, or
   Image header parsing happens in the hypervisor.

2. **The bundle removes image *parsing*; substrate still builds boot *data*.** The
   architecture's boot data depends on the running VM (its memory map, vCPU count,
   command line), which only substrate knows. So substrate still constructs and
   places, and points the entry registers at:
   - **x86_64:** the **`boot_params` zero-page** (the bare-metal x86/64 boot
     protocol — memory map / cmdline / initrd via `setup_header` + `e820`), per
     `Documentation/arch/x86/boot.rst`. substrate sets up the vCPU directly in
     64-bit long mode (CR0.PE|PG, CR4.PAE, EFER.LME|LMA, a flat GDT, identity page
     tables) and enters at `entry_addr` with `%rsi` pointing at the `boot_params`.
   - **aarch64:** the FDT (and ACPI tables where used) and the kernel command line,
     per the arm64 boot protocol (`Documentation/arch/arm64/booting.rst`), with the
     FDT physical address in `x0`.
   This is the same split substrate already planned: it **keeps** its
   FDT/ACPI/`boot_params`/cmdline builders and **drops** only the image parsers,
   **adding** a small bundle-header reader.

3. **`load_addr` / `entry_addr` semantics are fixed per architecture**
   ([design/bundle-format.md](../design/bundle-format.md)):
   - **x86_64:** the packer flattens the `vmlinux` PT_LOAD segments into a
     contiguous image; `load_addr` is the physical load base of that image (the
     first PT_LOAD's `p_vaddr & 0xFFFFFFF` — the low bits that recover the 16 MiB
     physical base from the kernel virtual address). `entry_addr` is the ELF
     **`e_entry`** (the 64-bit `startup_64`), because substrate enters via the
     bare-metal 64-bit boot protocol with a `boot_params` zero-page. (`CONFIG_PVH=y`
     remains in the config as a carried capability, but the boot path does **not**
     use the PVH entry — see Alternatives.)
   - **aarch64 / riscv64:** the raw `Image` is largely position-independent;
     `load_addr` = `entry_addr` = the guest-physical base the consumer uses
     (`0x80000000`). The arm64 boot protocol enters at the
     start of the image. The Image header (`magic 0x644d5241`, `text_offset`,
     `image_size`) is honored by substrate's placement.

4. **The header is authoritative; substrate trusts it, not the image.** Because the
   bundle is produced by our own pinned, reproducible build (ADR 0001/0005) and
   golden-tested (ADR 0003), substrate treats the header addresses as ground truth
   rather than re-deriving them from the payload.

5. **Cross-repo follow-up (out of scope here, recorded for the consumer side).**
   Adopting this contract means substrate's `docs/design/boot.md` and `boot` crate
   change from "parse bzImage/ELF/Image" to "read the bundle header + build boot
   data + copy + jump." That change lands in substrate's repo; this ADR is the
   producer-side record of the contract substrate implements. The 64-bit
   `boot_params` entry is the standard x86/64 Linux boot protocol — a well-trodden,
   proven model.

## Consequences

- The kernel-image parser — historically a rich source of hostile-input bugs —
  is **absent from the hypervisor**. The only guest-image input substrate parses is
  a 96-byte fixed-layout header it produced itself. This parser-removal win is
  independent of the entry protocol (it comes from pre-flattening), so it holds
  identically for the 64-bit `boot_params` path.
- substrate's boot path is a copy and a jump plus its existing boot-data builders;
  the flattening/parsing work is done once at build time.
- The contract is small and fixed, so producer and consumer can be developed and
  golden-tested independently.

## Alternatives considered

- **Raw standard image parsed by substrate** — rejected (user decision): it
  restores a full kernel-image parser on the hypervisor's untrusted surface, the
  exact thing the pre-flattened model removes.
- **Hybrid: a thin header wrapping an unmodified standard image** — rejected: keeps
  a parser in substrate (it still parses the embedded image), giving the worst of
  both — a custom header *and* a kernel-image parser.
- **x86 PVH entry (`XEN_ELFNOTE_PHYS32_ENTRY` + a `start_info` struct)** —
  rejected: the packer records the ELF `e_entry` and substrate enters in 64-bit
  long mode with a `boot_params` zero-page (the standard x86/64 Linux boot path).
  PVH offers no security benefit here — the parser-removal win comes from
  pre-flattening and is identical either way — while it would add fragile PVH-note
  extraction in the packer for nothing. `entry_addr` therefore holds the `e_entry`
  (Decision §3).
- **Bake the boot data into the bundle** — rejected: it depends on the VM's runtime
  memory map and config, which the build cannot know (Decision §2, ADR 0003).
