# Design: the patch series

The ordered, justified source deltas applied to the pinned tree
([ADR 0007](../adr/0007-patch-management-policy.md)). This is the highest-leverage
and highest-risk surface in the repo (CLAUDE.md §6): each patch is a guest-kernel
divergence that must earn its place against a substrate feature, a boot/hardware
contract, or a guest-correctness bug. This doc groups the carried series by theme
with the *why* for each, and records the explicit keep/drop decisions.

> **Provenance note.** Exact upstream commit hashes are pinned when each patch is
> re-derived against our tree (CLAUDE.md §6 — re-derive, don't paste). Below,
> "backport" means the change exists upstream and we cite the mainline commit at
> re-derivation; "original" means a downstream change we author against a cited
> contract and write to be upstreamable in spirit.

## Background

The carried series, by theme: orderly
init-death; the vsock datagram series + its nonlinear-SKB reverts; TSI
(transparent socket interception); the arm64 memory-model/TSO series; virtio-GPU
(cut); input-compat; DAX/FUSE/overlayfs; virtio-CAN (flagged); virtio-RTC; the x86
ACPI hypervisor fixes; and the SEV/TDX series (quarantined,
[ADR 0009](../adr/0009-confidential-compute-variants.md)).

## Carried themes

### Orderly shutdown when the guest entrypoint exits
- **What:** when PID 1 (the guest entrypoint) exits, trigger an orderly reboot
  instead of a kernel panic; suppress the custom-reboot-command path that a microVM
  cannot service.
- **Why (contract):** in a substrate microVM the guest entrypoint runs as PID 1;
  its exit should cleanly shut the VM down, not panic the kernel (which a VMM then
  has to detect as a crash). Touches `kernel/exit.c`, `kernel/reboot.c`
  (`orderly_reboot` semantics).
- **Provenance:** original (downstream microVM behavior); cite the reboot/exit
  contract.

### vsock datagrams (+ nonlinear-SKB reverts)
- **What:** multi-transport datagram support over vsock — the
  `VIRTIO_VSOCK_F_DGRAM` feature bit and the generalized recv/transport-lookup
  paths — plus reverts of recent nonlinear-SKB-allocation changes that regress in
  this environment.
- **Why (contract):** broadens what substrate's vsock muxer (substrate ADR 0015)
  can carry beyond streams. Touches `net/vmw_vsock/af_vsock.c`,
  `virtio_transport_common.c`, `include/uapi/linux/virtio_vsock.h`. Spec:
  virtio-vsock (Virtio 1.2 §5.10) + the `F_DGRAM` extension.
- **Provenance:** backport (the upstream datagram series + the specific reverts);
  cite each at re-derivation. **Audit obligation:** confirm the reverts are still
  needed against our pin (a revert that the pin already lacks is dropped).

### TSI (transparent socket interception)
- **What:** address families that route guest `AF_INET`/`AF_INET6`/`AF_UNIX`
  sockets transparently over vsock to a host proxy, plus the opt-in hijack path.
  New `net/tsi/` source + a `CONFIG_TSI` symbol.
- **Why (contract):** substrate's net feature contract explicitly includes "TSI …
  coexisting with virtio-net, and a per-connect JSON egress policy" (substrate
  architecture.md §1.3). The kernel-side driver is required for that feature.
- **Provenance:** original (downstream); the largest single source addition, so
  re-derived carefully with a substrate-native name and
  written for review.

### arm64 memory model / TSO control
- **What:** `prctl(PR_{SET,GET}_MEM_MODEL)` with a TSO mode, the `ACTLR_EL1`
  thread-state scaffolding, and the Apple-IMPDEF TSO control.
- **Why (contract):** lets guest userspace that emulates x86 (which assumes Total
  Store Order) request TSO on a weakly-ordered aarch64 guest — relevant when the
  substrate guest runs x86 binaries under emulation on Apple Silicon. Guest-internal
  (a `prctl` + register state); **no host device**, so it is inert if unused
  ([ADR 0008](../adr/0008-kernel-capability-surface-vs-vmm-scope.md)). Touches
  `arch/arm64/`, `kernel/sys.c`, `include/uapi/linux/prctl.h`. Spec: the ARM ARM
  (memory ordering) + Apple IMPDEF.
- **Provenance:** backport (the upstream/Asahi memory-model series); aarch64-only.

### virtio-fs / DAX + overlayfs robustness
- **What:** allow DAX block size ≥ `PAGE_SIZE`; mark FUSE DAX inode releases as
  blocking; handle `EOPNOTSUPP` in overlayfs fileattr copy-up; fix a virtio-fs
  use-after-free on a setup-failure path.
- **Why (contract):** substrate keeps virtio-fs for **optional `--volume` bind
  mounts** (never rootfs — substrate architecture.md §1; CLAUDE.md §5b). These
  patches make virtio-fs/DAX correct and stable under mixed page sizes and error
  paths. Touches `fs/dax.c`, `fs/fuse/`, `fs/overlayfs/`. Spec: the FUSE/DAX and
  overlayfs semantics.
- **Provenance:** mix of backports (DAX/overlayfs fixes) and a downstream bug fix
  (the virtio-fs UAF); cite each.

### virtio-rtc (timekeeping)
- **What:** the virtio-rtc driver core, its PTP clock, the arm Generic-Timer
  cross-timestamping, and the RTC-class exposure.
- **Why (contract):** accurate guest timekeeping / host clock sync; part of the
  kernel's fixed feature set so substrate may wire it
  ([ADR 0008](../adr/0008-kernel-capability-surface-vs-vmm-scope.md)). Touches
  `drivers/virtio/virtio_rtc_*`. Spec: the virtio-rtc device spec + PTP.
- **Provenance:** backport (the upstream virtio-rtc series).

### x86 ACPI hypervisor fixes
- **What:** skip the ACPICA PCI_CONFIG address-space handler when `CONFIG_PCI=n`;
  keep `legacy_pic` populated under HW_REDUCED ACPI.
- **Why (contract):** the minimal config disables PCI
  ([kernel-config.md](kernel-config.md)), but x86 ACPI init assumes a PCI_CONFIG
  handler and a `legacy_pic`; without these fixes ACPI init fails or null-derefs on
  the 64-bit direct-boot x86 path ([ADR 0004](../adr/0004-boot-contract-with-substrate.md)).
  Touches `drivers/acpi/acpica/evhandler.c`, `arch/x86/kernel/acpi/boot.c`. Spec:
  ACPI (HW_REDUCED) + the x86 boot path.
- **Provenance:** original (downstream hypervisor-boot fixes); x86-only.

### General syscall / mm fixes
- **What:** allow 64-bit processes to use compat input syscalls; fix the
  `__wp_page_copy_user` fallback for a remote `mm_struct`.
- **Why (contract):** general guest-correctness fixes we carry that
  apply regardless of device wiring (the mm fix also matters under large pages).
  Touches `drivers/input/input-compat.c`, `mm/memory.c`.
- **Provenance:** backport; cite each. **Keep only if still needed** against the
  pin (a fix already upstream in our pin is dropped).

## Keep / drop / flag decisions

| Area | Decision | Rationale |
|---|---|---|
| Orderly init-death | **keep** | core microVM behavior (substrate guest entrypoint = PID 1) |
| vsock datagrams + SKB reverts | **keep** | broadens substrate's vsock muxer; reverts re-validated against the pin |
| TSI | **keep** | in substrate's net feature contract (architecture.md §1.3) |
| arm64 TSO / memory model | **keep** | x86-emulation guests on Apple Silicon; inert if unused (ADR 0008) |
| virtio-fs / DAX + overlayfs | **keep** | substrate's optional `--volume` mounts (architecture.md §1) |
| virtio-rtc | **keep** | guest timekeeping; part of the fixed feature set |
| x86 ACPI hypervisor fixes | **keep** | required for the 64-bit direct-boot x86 path with PCI off |
| general syscall/mm fixes | **keep** (conditional) | guest-correctness; drop any already in the pin |
| **virtio-GPU / virtgpu** | **drop** | GPU is cut (CLAUDE.md §1; user: "just not GPUs") |
| **virtio-CAN** | **drop** | outside substrate's device set and not requested; carried only if a concrete substrate consumer appears (would need an ADR) |
| **TEE / SEV / TDX series** | **quarantine** | out of base; opt-in variant only ([ADR 0009](../adr/0009-confidential-compute-variants.md)) |

The one **open decision** is virtio-CAN: it is neither GPU (so not explicitly cut)
nor in substrate's device set (so not justified). Default is drop; revisit only
with a named substrate consumer.

## Our design

- `patches/NNNN-title.patch` — the ordered base series, grouped by the themes
  above, each with a why-header (intent + provenance + citation) and applying at
  `-p1` with zero fuzz ([ADR 0007](../adr/0007-patch-management-policy.md)).
- `patches-tee/NNNN-title.patch` — the quarantined TEE series, applied only for
  sev/tdx ([ADR 0009](../adr/0009-confidential-compute-variants.md)).
- Carried capabilities are part of the kernel's fixed per-variant feature set; the
  bundle header carries no capability advertisement ([ADR 0008](../adr/0008-kernel-capability-surface-vs-vmm-scope.md)).
- Numbering leaves gaps between themes so a backport can slot in without renumbering
  the world; order within a theme respects dependencies (e.g. the vsock feature bit
  before its implementation).

## Verification

The applies-clean gate (zero fuzz against the pin); the config-invariant gate
(each patch's `CONFIG_*` present); boot-smoke
([testing/boot-smoke.md](../testing/boot-smoke.md)) exercises each kept capability
as substrate wires the matching device (orderly-shutdown observed as a clean VM
exit; vsock/TSI/virtio-fs/rtc as working devices; the x86 ACPI fixes as a
successful x86 boot). A version bump re-runs the whole series through applies-clean
and re-validates the conditional keeps ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)).
