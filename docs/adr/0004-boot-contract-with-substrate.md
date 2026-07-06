# ADR 0004 — The boot contract with substrate

- **Status:** Accepted
- **Date:** 2026-07-06
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

The load-address half of the contract was originally under-enforced, and it rotted
silently. The packer pinned the aarch64 raw-Image base at `0x8000_0000` — correct
for substrate's earliest embedding, whose machine model based guest DRAM at
`0x8000_0000`, so load-at-RAM-start held by construction — but substrate's current
machine model bases guest DRAM at `0x4000_0000` (devices below 1 GiB, RAM from
1 GiB up). With RAM spanning `[0x4000_0000, 0x4000_0000 + ram_size)` and the kernel
copied to `0x8000_0000`, RAM had to cover **both**, an accidental
~1 GiB + kernel_size boot floor. Probed empirically with the published
`linux-6.12.91-base-aarch64.kernel` on both KVM (Graviton) and HVF (M4 Max):

- 256 / 512 / 1024 MiB → cold-boot error: `kernel section [0x80000000,
  0x80000000+21430272) is not in any mapped guest-memory region`
- 1100 / 1536 / 2048 MiB → boots (`Booting Linux on physical CPU ...`)

Neither repo enforced the agreement — substrate's test matrices simply rounded up
to 2 GiB. This revision of the contract closes that hole: the load base is defined
in terms of the consumer's DRAM base, and the consumer enforces it at load time.

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

3. **Raw-Image invariant: the kernel sits at the start of guest RAM.** For the
   raw-Image architectures, `load_addr == entry_addr == the consumer's DRAM base
   (+ the Image header's text_offset)` — so any VM whose RAM holds the image boots,
   and no boot floor above the DRAM base can exist. Per architecture
   ([design/bundle-format.md](../design/bundle-format.md)):
   - **x86_64:** the packer flattens the `vmlinux` PT_LOAD segments into a
     contiguous image; `load_addr` is the physical load base of that image (the
     first PT_LOAD's `p_vaddr & 0xFFFFFFF` — the low bits that recover the 16 MiB
     physical base from the kernel virtual address). `entry_addr` is the ELF
     **`e_entry`** (the 64-bit `startup_64`), because substrate enters via the
     bare-metal 64-bit boot protocol with a `boot_params` zero-page. (`CONFIG_PVH=y`
     remains in the config as a carried capability, but the boot path does **not**
     use the PVH entry — see Alternatives.)
   - **aarch64:** the canonical DRAM base is **`0x4000_0000`** — substrate's
     machine model (RAM from 1 GiB, devices below it), which gives a contiguous
     guest-physical space with no dead `[1 GiB, 2 GiB)` hole and single-region VMs
     up to 2.25 GiB below substrate's virtio-MMIO window at `0xD000_0000`. The
     packer places the image per the arm64 boot protocol's rule — a 2 MiB-aligned
     base plus `text_offset` (`Documentation/arch/arm64/booting.rst`) — reading
     `text_offset` from the Image header (bytes 8..16, little-endian; zero on
     modern kernels including the pinned 6.12, but read, never assumed), asserting
     the base's 2 MiB alignment, and validating the Image magic (`0x644d5241`) so
     packing the wrong file is a hard error. `entry_addr = load_addr`: the arm64
     protocol enters at the start of the image.
   - **riscv64:** `load_addr` = `entry_addr` = **`0x8000_0000`** — the QEMU-virt
     riscv DRAM base, the machine model a future consumer would present. riscv64 is
     carried, not a substrate boot target (ADR 0002).

4. **The header is authoritative, and the consumer enforces it at load time.**
   Because the bundle is produced by our own pinned, reproducible build (ADR
   0001/0005) and golden-tested (ADR 0003), substrate treats the header addresses
   as ground truth rather than re-deriving them from the payload — and it
   **validates `bundle.load_addr == its DRAM base` at cold_boot, rejecting a
   mismatched bundle with a typed error**. The contract is checked at runtime on
   every boot, not held by convention; a stale bundle fails loudly, never as a
   silent misload.

5. **`abi_version` stays 1.** The header format is unchanged (this revision changes
   only the *value* in an existing field), and the consumer validates `load_addr`
   directly, so a version bump would duplicate a check that already fails loudly.
   `abi_version` is reserved for semantic changes a consumer cannot detect from the
   header fields themselves.

6. **Producer/consumer sequencing for the `0x4000_0000` move.** A bundle loading at
   the DRAM base must not be consumed by a substrate that still writes its initial
   VMGENID GUID at DRAM base + 1 MiB (`0x4010_0000`): that write lands ~1 MiB
   *inside* the kernel image, corrupting 16 bytes of kernel text before the first
   instruction executes (a nondeterministic crash). substrate bumps its kernel pin
   only **after** its guest-layout change (VMGENID relocation + the cold_boot
   `load_addr` validation) has landed. The reverse direction is safe by design: an
   old `0x8000_0000` bundle under the new substrate is rejected with the typed
   cold_boot error.

## Consequences

- The kernel-image parser — historically a rich source of hostile-input bugs —
  is **absent from the hypervisor**. The only guest-image input substrate parses is
  a 96-byte fixed-layout header it produced itself. This parser-removal win is
  independent of the entry protocol (it comes from pre-flattening), so it holds
  identically for the 64-bit `boot_params` path.
- substrate's boot path is a copy and a jump plus its existing boot-data builders;
  the flattening/parsing work is done once at build time.
- **Small-RAM aarch64 VMs boot.** With the kernel at the start of RAM, the
  ~1 GiB boot floor is gone: the 256 MiB–1 GiB range that failed the probe now
  works, bounded only by the image + workload themselves.
- The contract is enforced mechanically on both sides: the packer computes the
  address from the Image header per `booting.rst` and locks it in the bundle
  goldens; substrate validates it at cold_boot. Neither side can drift silently
  again.
- Until substrate's guest-layout change lands, the new bundle must not be consumed
  by an older substrate (Decision §6) — the release notes carry this sequencing
  warning.
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
- **Keep the aarch64 base at `0x8000_0000`** — rejected: it was correct only for
  the machine model of substrate's earliest embedding (DRAM based at
  `0x8000_0000`); under substrate's current map it manufactures the ~1 GiB boot
  floor the probe demonstrated and leaves a dead `[1 GiB, 2 GiB)` hole in every
  guest's physical space.
- **Have substrate relocate the kernel to wherever its RAM is** (ignore
  `load_addr`) — rejected: the header is authoritative (Decision §4); per-boot
  address translation reintroduces exactly the consumer-side guesswork the
  pre-flattened bundle exists to remove. The producer records the true base; the
  consumer validates it.
- **Bump `abi_version` for the move** — rejected (Decision §5): the consumer
  validates `load_addr` directly, so the bump would be a second, redundant signal
  for a change the fields already expose.
