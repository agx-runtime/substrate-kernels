# Boot smoke

The irreducible remainder no static check can replace: a **real guest boots from
the produced `.kernel` under substrate**, reaches userspace, and drives the wired
virtio devices. It is the boundary-tier complement to the input/artifact gates
([README.md](README.md)) and lands with substrate's KVM backend
([architecture.md](../architecture.md) §7).

## What it proves

- **The boot contract is right** ([ADR 0004](../adr/0004-boot-contract-with-substrate.md)):
  substrate reads the bundle header, copies the payload to `load_addr`, builds the
  arch's boot data (x86 `boot_params` zero-page / aarch64 FDT + ACPI + cmdline),
  enters at `entry_addr`, and the guest actually starts. A wrong `entry_addr` (e.g.
  a bad x86 `e_entry` extraction, [bundle-format.md](../design/bundle-format.md)) is
  caught here.
- **The config boots** ([kernel-config.md](../design/kernel-config.md)): the
  monolithic virtio-only kernel initializes, mounts the substrate-supplied ext4-disk
  rootfs ([initramfs.md](../design/initramfs.md)), and reaches userspace.
- **The patches work** ([patches.md](../design/patches.md)): orderly init-death
  (the guest entrypoint exiting yields a clean VM shutdown, not a panic); the x86
  ACPI fixes (x86 boots with PCI off); and each wired capability (vsock, TSI,
  virtio-fs, rng, console, rtc) functions as substrate exercises it.

## Shape

- **Loader = substrate.** boot-smoke does not reimplement loading; it uses substrate
  as the consumer, exactly as production does. The bundle is the artifact under
  test; substrate is the fixture.
- **Platforms:** KVM on Linux (x86_64 + aarch64) and HVF on macOS (aarch64). The
  per-arch boot data differs (x86 `boot_params` vs aarch64 FDT/ACPI), so each arch
  is a distinct case. riscv64 and windows are not boot-smoke targets (no substrate
  consumer — [ADR 0002](../adr/0002-target-architectures.md)).
- **Fixtures are staged, not rebuilt per run:** a substrate build and a rootfs
  (an ext4 disk or initramfs from the OCI pipeline). A missing fixture is a
  `panic!("[fixture] … — run make <target>")`, never a `[skip]` (CLAUDE.md §9).
- **Observation, not sleeps:** boot success is a real signal — a ready marker on the
  guest console / a vsock handshake — polled with a deadline, never a fixed
  `sleep` (CLAUDE.md §9). Boot-to-userspace time is recorded here for the budget
  (architecture.md §6).

## Coverage by cell

- **base × {x86_64, aarch64}** — the core boot path, on every PR touching patches,
  config, the packer, or the pin.
- **sev/tdx × x86_64** — the TEE variants boot + complete their early
  secret-retrieval/measurement init ([ADR 0009](../adr/0009-confidential-compute-variants.md));
  verified on the TEE lane, separate from base.

## What it does not cover

boot-smoke proves the kernel *runs*; it does not re-test substrate's own device
correctness (that is substrate's DST/fuzz/live-smoke suite) or the static
properties the input/artifact gates already prove (a patch applying, a config
invariant, the header bytes). It is scoped to "this bundle boots and its
capabilities function under the real hypervisor."

## Relationship to substrate's live-smoke

substrate has its own live-smoke lane that boots a real guest under KVM/HVF. The
two meet at the artifact: substrate's lane needs *a* kernel; substrate-kernels'
boot-smoke proves *this* kernel boots. In practice the substrate-kernels artifact is
the kernel substrate's live-smoke consumes, so the fixture pipelines are shared
([testing/strategy.md](strategy.md) platform matrix).
