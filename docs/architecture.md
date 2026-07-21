# Architecture

substrate-kernels turns exact Linux LTS source pins into pre-flattened `SUBK`
bundles consumed by substrate. The repository supports two kernel lines side by
side: 6.12.96 is the default compatibility line and 6.18.39 is the current LTS
line. Read [CLAUDE.md](../CLAUDE.md) first; it defines the binding artifact,
reproducibility, patch, and verification laws.

## 1. Artifact contract

The sole production consumer is **substrate**:

1. A fixed 96-byte, little-endian header describes format/ABI version, arch,
   variant, page size, load/entry addresses, and kernel/qboot/initrd ranges.
   Payload sections follow at 64 KiB alignment (4 KiB for the carried windows
   cell). See [ADR 0003](adr/0003-kernel-bundle-format.md).
2. The kernel is already a contiguous load image. The packer flattens x86_64
   `vmlinux` PT_LOAD segments; aarch64/riscv64 use raw `Image`. substrate does
   not parse ELF, bzImage, or Image at runtime
   ([ADR 0004](adr/0004-boot-contract-with-substrate.md)).
3. substrate still supplies architecture boot data: x86 `boot_params` and ACPI;
   aarch64 FDT; command line, initramfs, and root disk as selected by the VM.
4. The kernel is monolithic and has a fixed capability set per variant. The
   bundle header is not a device-capability protocol. substrate enforces the host
   boundary by instantiating only requested devices
   ([ADR 0008](adr/0008-kernel-capability-surface-vs-vmm-scope.md)).
5. A clean rebuild from the same pin, patches, config, toolchain, and metadata
   must be byte-identical ([ADR 0005](adr/0005-build-environment-and-reproducibility.md)).

Out of scope: GPU/DRM, virtio-CAN, virtio-RTC, virtio-fs DAX, loadable modules,
cross-architecture emulation controls, and confidential-compute variants. The
old SEV/TDX decision was superseded because substrate has no matching machine
model and the bundles lacked bootable firmware/initrd wiring
([ADR 0009](adr/0009-confidential-compute-variants.md)).

## 2. Build pipeline

`KERNEL_LINE` selects one exact pin and its independently re-derived patch series:

```text
scripts/kernel-pins/<line>.env
        │ fetch HTTPS + verify sha256 before extraction
        ▼
linux-<version>.tar.xz
        │ extract
        ▼
source tree
        │ patches/<line>/*.patch, -p1, zero fuzz and zero offset
        ▼
patched tree
        │ config-<variant>_<arch> + olddefconfig + invariant check
        ▼
configured tree
        │ pinned toolchain + fixed KBUILD_BUILD_* metadata
        ▼
vmlinux (x86_64) or Image (aarch64/riscv64)
        │ flatten/raw copy + SUBK header + alignment
        ▼
linux-<version>-<variant>-<arch>.kernel
```

Build paths contain the exact version, variant, and architecture, so both LTS
lines coexist. macOS delegates Linux-only stages to the digest-pinned build
container; Linux may run natively with that toolchain. Details live in
[design/build-pipeline.md](design/build-pipeline.md).

## 3. Components and owners

| Component | Responsibility | Primary verification |
|---|---|---|
| `scripts/kernel-pins/` | exact version, source URLs, and sha256 per line | pre-extraction hash check |
| `patches/<line>/` | ordered deltas required by current substrate | strict applies-clean + targeted live behavior |
| `config-*_<arch>` | monolithic per-cell feature set | `olddefconfig` + config invariants |
| `tools/build/Dockerfile` | pinned compiler/build environment | clean rebuild byte identity |
| `scripts/pack-kernel.py` | flatten, header, and alignment | unit tests + bundle golden |
| substrate boot fixture | consume the real bundle and build boot data | KVM boot matrix |

The patch rationale and deletion conditions are in
[design/patches.md](design/patches.md). That document is the source of truth for
why any Linux divergence exists.

## 4. Kernel and artifact matrix

Both `KERNEL_LINE=6.12` (6.12.96) and `KERNEL_LINE=6.18` (6.18.39) support the
same matrix:

| Variant | x86_64 | aarch64 | riscv64 |
|---|---|---|---|
| **base** | release/boot gated; flattened `vmlinux` | release/boot gated; raw `Image` | buildable, not release gated |
| **debug** | release build; base + tracing/BTF/DWARF5 | release build; same additions | — |
| **windows** | buildable Hyper-V/WHP cell, 4 KiB packing; not release gated | — | — |

Release CI builds both lines × `{base, debug}` × `{x86_64, aarch64}`. Runtime
validation boots base on AMD and Intel x86 hosts and an Arm host. Debug shares
the same patch/config boot contract and additionally runs the byte-reproducibility
gate ([ADR 0013](adr/0013-debug-variant.md)).

## 5. Current guest capability contract

- virtio-mmio core with block, net, console, rng, balloon, vsock, and virtio-fs;
- stock virtio-vsock streams. substrate may advertise its experimental datagram
  bit, but these kernels correctly decline it because no shipped real backend or
  guest control path consumes datagrams;
- ext4 root disks, optional initramfs, tmpfs/devtmpfs, and overlayfs;
- DAX-less virtio-fs only: substrate has no shared-memory window and rejects FUSE
  mapping requests;
- x86 ACPI and KVM clock; aarch64 FDT, architectural timer, and PL031 RTC;
- nftables/bridge/NAT and `NFT_COMPAT` xt matches for container networking, with
  the separately selectable legacy iptables evaluators disabled;
- no PCI devices. x86 ACPICA remains required to interpret substrate's AML; a
  small patch skips only its unavailable PCI_CONFIG handler when `CONFIG_PCI=n`.

The default `init.substrate` process remains PID 1, reaps the workload, reports
its status, and requests VM shutdown. Direct PID-1 mode retains stock Linux
semantics. No kernel init-death patch is part of the contract.

## 6. Verification matrix

Static and artifact gates run for every selected cell:

- source sha256 before extraction;
- zero-fuzz/zero-offset patch application;
- post-`olddefconfig` required and forbidden symbols;
- bundle layout/unit goldens;
- two clean, byte-identical debug rebuilds.

The release live gate uses the exact current substrate tree:

- both kernel lines boot on AMD and Intel x86, reach ACPICA `Interpreter enabled`,
  and probe virtio devices;
- both lines boot on Arm through the FDT path and read a post-epoch wall clock
  through PL031;
- Linux declines the experimental vsock datagram bit without failing negotiation,
  then completes a real 128 KiB stream transfer through substrate on each host;
- `init.substrate` runs and cleanly terminates an `exit 0` workload without the
  removed PID-1 patches;
- DAX-less virtio-fs and the remaining wired devices are exercised by substrate's
  KVM live-smoke suite.

See [testing/strategy.md](testing/strategy.md) and
[testing/boot-smoke.md](testing/boot-smoke.md).

## 7. Budgets

Bundle size and boot-to-userspace time are review signals. A point release,
patch, or config change that grows either must be explained. They are not hard
thresholds: correctness and an explicit capability contract come first.

## 8. Decision record

The principal ADRs cover source pins (0001), architecture/variant scope (0002),
bundle format (0003), substrate boot contract (0004), reproducibility (0005),
kernel config strategy (0006), patch policy (0007), capability surface (0008),
superseded confidential-compute variants (0009), debug variant (0013), and
container networking (0014). The index is [adr/README.md](adr/README.md).
