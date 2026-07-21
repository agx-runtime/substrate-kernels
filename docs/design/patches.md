# Design: the patch series

Linux is patched only where the current substrate VMM contract requires behavior
that the pinned upstream kernel does not provide. Each supported LTS line has an
independently re-derived series in `patches/<line>/`; sharing patches between
different source trees would hide drift as offsets or fuzz.

The 6.12.96/6.18.39 audit reduced the inherited stack from 30 base patches plus
4 deferred TEE patches to **3 patches per line**. The two directories contain the
same logical changes, but each patch applies at zero fuzz and zero offset to its
own pin.

## Current series

| Patch | Keep reason | Removal condition |
|---|---|---|
| `0001` virtio-fs queue cleanup | Backport of upstream Linux commit [`6af3330ec5d5`](https://github.com/torvalds/linux/commit/6af3330ec5d5fb8c06c04eb520a71cf73ea5a765): a failed virtqueue setup otherwise leaves freed pointers live and can double-free them during final release. substrate exposes virtio-fs, so the probe path is reachable. | Drop from a line once its pin contains the upstream fix. |
| `0002` ACPICA without PCI | x86 substrate supplies ACPI tables while the deliberately small guest config has `CONFIG_PCI=n`. ACPICA otherwise attempts to install its compiled-out PCI configuration-space handler, returns `AE_BAD_PARAMETER`, and aborts the default ACPI handler setup. | Prefer an upstream fix. Replacing it with `CONFIG_PCI=y` is acceptable only after substrate boot tests on AMD and Intel show equivalent behavior and the added kernel surface/size is accepted. |
| `0003` deterministic pahole | Pinned pahole 1.24 assigns BTF type IDs nondeterministically with parallel encoding, making debug bundles differ between identical builds. The patch serializes only BTF generation when reproducible build metadata is in use. | Drop when the pinned kernel/toolchain has an equivalent deterministic implementation and the stock A/B reproducibility gate passes. |

### Why ACPICA is required

ACPICA is the kernel's implementation of ACPI: it parses and executes the AML in
firmware-provided tables such as the DSDT. On substrate's x86 machine it is not a
PCI dependency. It is how Linux discovers the VMM's ACPI-described virtio-mmio
devices and VM generation ID and applies the rest of the x86 firmware contract.

The retained patch does **not** remove or bypass ACPICA. It only omits ACPICA's
default `PCI_CONFIG` address-space handler when Linux was built without PCI. The
System Memory, System I/O, and Data Table handlers remain. arm64 discovers devices
through its flattened device tree and does not exercise this x86-only path.

A same-tree A/B boot on AMD proves the guard is behavioral, not cosmetic. With
only this six-line patch reversed, Linux reports `AE_BAD_PARAMETER` during ACPI
region initialization, substrate observes zero virtio-vsock MMIO accesses, and
the driver never reaches `DRIVER_OK`. Restoring it enables the ACPI interpreter
and the DSDT-enumerated virtio devices probe on both AMD and Intel.

### Why the datagram RFC was dropped

The six inherited datagram patches came from the unmerged
[`[PATCH RFC net-next v4 0/8] virtio/vsock: support datagrams`](https://lore.kernel.org/netdev/20230413-b4-vsock-dgram-v4-0-0cebbb2ae899@bytedance.com/)
series. substrate still exposes a public datagram seam and advertises feature bit
3, but its shipped real backends and guest control paths use streams; only the
simulator and tests implement a datagram backend. QEMU has no matching
virtio-vsock feature, while Firecracker explicitly resets datagram packets.
That is not a production consumer and does not justify six downstream RFC patches.

Stock 6.12.96 and 6.18.39 correctly ignore the unknown offered bit: the live
probe recorded `offered=0x920000008` and `acked=0x120000000`, so bit 3 was not
acknowledged. On AMD, Intel, and Arm, the resulting device still reached
`DRIVER_OK` and a real guest-to-host `SOCK_STREAM` connection transferred 128 KiB
past its credit window. Datagram support can return when it is upstream and has a
real backend/guest consumer; it is not carried speculatively here.

The four inherited reverts of later vsock SKB/credit changes are **not** part of
the retained series either. They rolled back iterator correctness and nonlinear
SKB allocation fixes, and one would remove the local credit cap for
[CVE-2026-23086](https://nvd.nist.gov/vuln/detail/CVE-2026-23086), allowing a peer
to drive excessive kernel memory allocation. Real stream tests pass with all four
upstream fixes intact.

## Removed in the 6.12.96/6.18.39 audit

| Old patch area | Decision and evidence |
|---|---|
| `0001`–`0002`: do not panic when PID 1 exits / alter orderly reboot | **Dropped.** The first replaced the global-init panic with `orderly_reboot()` and suppressed normal restart messages; the second forced `orderly_reboot()` to skip its userspace helper and take the emergency restart path. They worked around an old direct-workload-as-PID-1 design. Current `init.substrate` is the default PID 1 supervisor: it forks/reaps the workload, reports its exact status, and invokes an architecture-aware reboot itself. Live tests report `exit 7` exactly and require an `exit 0` guest to self-terminate as `StopReason::Shutdown`. Direct PID-1 mode deliberately retains normal Linux semantics. |
| `0011`–`0015`: arm64 memory-model and Apple TSO controls | **Dropped.** These exist for running x86 binaries through a userspace emulator on Apple arm64. Current substrate explicitly has no cross-architecture emulation contract, and the AWS arm host does not need Apple IMPDEF controls. `CONFIG_ARM64_ACTLR_STATE` is now forbidden. |
| `0017`: compat input ioctls from 64-bit processes | **Dropped.** This supports userspace emulation/input translation. substrate exposes no input device and has no cross-architecture emulator consumer. |
| `0018`, `0019`, `0022`: DAX and remote-mm fixes | **Dropped.** substrate's virtio-fs implementation has no shared-memory DAX window and rejects FUSE `SETUPMAPPING`/`REMOVEMAPPING`; `CONFIG_FUSE_DAX` is disabled. The remote-mm fix was carried solely for that obsolete DAX/debugger path. |
| `0028`: overlayfs fileattr copy-up over virtio-fs | **Dropped.** The old rationale claimed a virtio-fs root filesystem. substrate boots an ext4 disk or initramfs and uses virtio-fs only for optional DAX-less volume mounts. Overlayfs itself remains configured; this downstream exception is not required by the current boot contract. |
| `0023`–`0026`: four vsock networking reverts | **Dropped.** Stock stream vsock passes connect, control-response, 128 KiB credit-window, and retry tests with the upstream iterator/nonlinear-SKB fixes intact. The fourth revert would specifically undo the CVE-2026-23086 memory bound. |
| `0028`–`0032`: virtio-RTC | **Dropped.** substrate implements PL031 RTC on arm64 and x86 KVM clock/ACPI timekeeping; it has no virtio-RTC device. `CONFIG_VIRTIO_RTC` is disabled. |
| four `patches-tee/` changes plus SEV/TDX configs | **Dropped.** substrate has no SEV-SNP or TDX machine model, and the variants lacked the qboot/initrd assets needed to produce bootable bundles. Carrying compile-only confidential-compute code was not a supported feature. [ADR 0009](../adr/0009-confidential-compute-variants.md) records the supersession. |
| TSI, x86 ACPI `legacy_pic`, virtio-GPU, and virtio-CAN from older audits | **Remain dropped.** No current substrate consumer justifies restoring them; see [ADR 0015](../adr/0015-drop-tsi-and-x86-acpi-legacy-pic.md). |

## Policy and verification

- Patch order is dependency order. Every file has its provenance and downstream
  rationale in the commit message.
- `make applies-clean KERNEL_LINE=<line>` rejects any fuzz or offset. A patch that
  needs either is re-derived, never forced.
- `make configured` checks the matching normalized config. Unimplemented device
  families such as virtio-RTC and virtio-fs DAX are explicitly forbidden.
- Both LTS lines build base and debug bundles for x86_64 and aarch64. The release
  gate then boots them with substrate on the matching architecture; x86 is tested
  on both AMD and Intel because the ACPICA/KVM boot path is hardware-sensitive.
- The vsock gate records offered and acknowledged bits, proves an unknown DGRAM
  offer is declined safely, and completes a real 128 KiB stream transfer. Clean
  workload shutdown and DAX-less virtio-fs are separate checks.
- `make repro-check` must produce byte-identical debug bundles, which exercises
  the pahole patch rather than assuming it works. In the controlled audit, stock
  pahole produced different bundles on both lines; adding only `0003` made both
  two-clean-build checks byte-identical.

Any future patch must name a live substrate consumer, cite its origin, include a
targeted failure-mode test, and state when it can be deleted. Build success by
itself is not evidence that a behavioral kernel patch is needed.
