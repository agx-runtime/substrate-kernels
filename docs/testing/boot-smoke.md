# Boot smoke

The irreducible remainder no static check can replace: a **real guest boots from
the produced `.kernel` under substrate**, reaches userspace, and drives the wired
virtio devices. It is the boundary-tier complement to the input/artifact gates
([README.md](README.md)) and lands with substrate's KVM backend
([architecture.md](../architecture.md) §7).

## What it proves

- **The boot contract is right** ([ADR 0004](../adr/0004-boot-contract-with-substrate.md)):
  substrate reads the bundle header, copies the payload to `load_addr`, builds the
  arch's boot data (x86 `boot_params` + ACPI / aarch64 FDT + cmdline),
  enters at `entry_addr`, and the guest actually starts. A wrong `entry_addr` (e.g.
  a bad x86 `e_entry` extraction, [bundle-format.md](../design/bundle-format.md)) is
  caught here.
- **The config boots** ([kernel-config.md](../design/kernel-config.md)): the
  monolithic virtio-only kernel initializes, mounts the substrate-supplied ext4-disk
  rootfs ([initramfs.md](../design/initramfs.md)), and reaches userspace.
- **The retained patches work** ([patches.md](../design/patches.md)): x86 ACPI
  reaches `Interpreter enabled` with PCI compiled out. Reversing only the ACPICA
  guard must reproduce `AE_BAD_PARAMETER` and prevent device probing. virtio-fs
  probe error handling and debug reproducibility have their own targeted gates.
- **The dropped patches are genuinely unnecessary:** stock PID-1 semantics plus
  the default `init.substrate` supervisor produce a clean shutdown; DAX-less
  virtio-fs mounts work without the DAX/overlay exceptions; PL031 supplies an
  arm64 wall clock without virtio-RTC; and both lines' stream-vsock paths work
  without either the six DGRAM RFC patches or the four networking reverts.

## Shape

- **Loader = substrate.** boot-smoke does not reimplement loading; it uses substrate
  as the consumer, exactly as production does. The bundle is the artifact under
  test; substrate is the fixture.
- **Platforms:** the release matrix uses KVM on both AMD and Intel x86_64 hosts
  and on an Arm aarch64 host. The per-arch boot data differs (x86 `boot_params`
  + ACPI versus aarch64 FDT), and the two x86 vendors exercise different KVM CPU
  paths. HVF remains a substrate compatibility lane. riscv64 and windows are not
  release boot targets ([ADR 0002](../adr/0002-target-architectures.md)).
- **Fixtures are staged, not rebuilt per run:** a substrate build and a rootfs
  (an ext4 disk or initramfs from the OCI pipeline). A missing fixture is a
  `panic!("[fixture] … — run make <target>")`, never a `[skip]` (CLAUDE.md §9).
- **Observation, not sleeps:** boot success is a real signal — a ready marker on the
  guest console / a vsock handshake — polled with a deadline, never a fixed
  `sleep` (CLAUDE.md §9). Boot-to-userspace time is recorded here for the budget
  (architecture.md §6).

## Coverage by cell

- **Both 6.12 and 6.18 × base × x86_64** — boot, ACPI, safe decline of the
  experimental DGRAM offer, a 128 KiB stream transfer, exact workload status,
  and clean shutdown on both AMD and Intel.
- **Both 6.12 and 6.18 × base × aarch64** — boot, FDT device probe, safe DGRAM
  decline, a 128 KiB stream transfer, exact workload status, clean PSCI shutdown,
  and PL031 wall clock.
- **debug × both architectures** — full compile plus byte-for-byte
  `repro-check`; it shares the base boot contract and patch series.

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
