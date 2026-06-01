# Architecture

How substrate-kernel is structured: the build pipeline that turns a pinned Linux
source tree into a `.kernel` bundle, the components of that pipeline, the
architecture × variant matrix, the boot contract with substrate, and the build
roadmap. Read [CLAUDE.md](../CLAUDE.md) first; it is the binding law (the artifact
contract, reproducibility, the patch discipline, substrate-native naming).

## 1. The artifact contract — what we must produce

The sole consumer is **substrate**. substrate
depends on the artifact being a **kernel bundle** it can map and enter with no
kernel-image parser of its own:

1. **A flat, header-described file.** A fixed-size header (magic, format version,
   abi version, arch, variant, page size, `load_addr`, `entry_addr`, and the byte
   ranges of the kernel / optional qboot / optional initrd) followed by
   page-aligned payload sections (64 KiB normally, 4 KiB for windows —
   [ADR 0003](adr/0003-kernel-bundle-format.md)).
2. **Pre-flattened.** The kernel is already a contiguous raw load image — x86_64
   `vmlinux` PT_LOAD segments flattened at build time, aarch64/riscv64 the raw
   `Image`. substrate copies it to `load_addr` and jumps to `entry_addr`; it does
   **not** parse ELF/bzImage/Image at runtime ([ADR 0004](adr/0004-boot-contract-with-substrate.md)).
3. **Fixed feature set per variant.** The header carries no capability
   advertisement; the kernel carries a fixed per-variant
   driver set (TSI, vsock-datagram, virtio-fs/DAX, virtio-rtc, …) and substrate
   wires what it instantiates ([ADR 0008](adr/0008-kernel-capability-surface-vs-vmm-scope.md)).
4. **Boots fast to the substrate guest model.** Monolithic, virtio-only, no module
   loading; reaches userspace quickly; reboots cleanly when the guest entrypoint
   (PID 1) exits rather than panicking ([design/patches.md](design/patches.md)).
5. **Byte-reproducible.** The same pin + patches + config yield a byte-identical
   bundle on any host ([ADR 0005](adr/0005-build-environment-and-reproducibility.md)).

These are **requirements on the artifact**, not on the build's internal mechanics.
The boot data the kernel needs at entry (x86 `boot_params` zero-page / aarch64 FDT
+ ACPI + the command line) is built and placed by **substrate**, not baked into the
bundle: the bundle removes image *parsing* from the hypervisor, not boot-data
*setup* ([ADR 0004](adr/0004-boot-contract-with-substrate.md)).

**Out of scope (cut):** GPU / virtio-gpu / DRM, virtio-CAN, loadable modules, and
every microVM-irrelevant driver class. (riscv64 and the windows variant are carried
as buildable, non-gated targets but are not substrate boot targets — [ADR 0002](adr/0002-target-architectures.md).)
TEE / SEV / TDX is out of the base kernel and lives only behind opt-in variants
([ADR 0009](adr/0009-confidential-compute-variants.md)).

## 2. The build pipeline

Six stages turn a pinned source release into a bundle. Each is a Makefile target
with explicit inputs and outputs ([design/build-pipeline.md](design/build-pipeline.md)):

```
  pin (version + sha256)
        │  fetch over HTTPS, verify sha256
        ▼
  ① tarball ──tar──▶ ② source tree
                          │  apply the ordered patch series at -p1 (zero fuzz)
                          ▼
                     ③ patched tree
                          │  copy config-<variant>_<arch>, make olddefconfig
                          ▼
                     ④ configured tree
                          │  make (fixed KBUILD_BUILD_* metadata)
                          ▼
                     ⑤ kernel binary   (x86_64: vmlinux ELF │ aarch64/riscv64: Image)
                          │  pack-kernel: flatten + header + page-align
                          ▼
                     ⑥ linux-<version>-<variant>-<arch>.kernel   (the bundle)
```

- **① Pin → tarball.** `scripts/kernel-pin.env` holds the version and sha256; the
  fetch verifies the hash before extraction. The pin is the root of every
  reproducibility claim ([ADR 0001](adr/0001-kernel-source-pin-and-update-lifecycle.md)).
- **② → ③ Patch.** The ordered series in `patches/` is applied at `-p1`. Any fuzz
  or rejected hunk fails the build; it is never forced
  ([ADR 0007](adr/0007-patch-management-policy.md), [design/patches.md](design/patches.md)).
- **③ → ④ Configure.** The per-(arch, variant) `.config` is copied in and
  normalized by `make olddefconfig`; the config-invariant gate then asserts the
  required options survived ([ADR 0006](adr/0006-kernel-config-strategy.md)).
- **④ → ⑤ Compile.** `KBUILD_BUILD_TIMESTAMP` / `_USER` / `_HOST` are fixed
  constants for reproducibility ([ADR 0005](adr/0005-build-environment-and-reproducibility.md)).
- **⑤ → ⑥ Pack.** `pack-kernel` flattens the kernel binary into a raw load image,
  computes `load_addr` / `entry_addr`, prepends the header, and page-aligns each
  section (64 KiB, or 4 KiB for windows — [design/bundle-format.md](design/bundle-format.md)).

On a macOS dev host the Linux-only stages run inside the pinned build container;
on Linux they run natively ([ADR 0005](adr/0005-build-environment-and-reproducibility.md)).

## 3. Component decomposition

Each build component, its responsibility, and where its design and verification
live.

| Component | Responsibility | Design | Verification owner |
|---|---|---|---|
| **Source pin** | the version + sha256 the build is rooted at; the upgrade lane | [ADR 0001](adr/0001-kernel-source-pin-and-update-lifecycle.md) | the sha256 check; the drift lane |
| **Patch series** | the ordered, justified deltas against the pin | [design/patches.md](design/patches.md), [ADR 0007](adr/0007-patch-management-policy.md) | applies-clean gate; boot-smoke |
| **Kernel config** | per-(arch, variant) `.config`, monolithic + virtio-only | [design/kernel-config.md](design/kernel-config.md), [ADR 0006](adr/0006-kernel-config-strategy.md) | config-invariant gate; boot-smoke |
| **Build environment** | pinned toolchain container; fixed build metadata | [design/reproducibility.md](design/reproducibility.md), [ADR 0005](adr/0005-build-environment-and-reproducibility.md) | `make repro-check` |
| **Packer (`pack-kernel`)** | flatten + header + alignment → the bundle | [design/bundle-format.md](design/bundle-format.md), [ADR 0003](adr/0003-kernel-bundle-format.md) | bundle-golden |
| **Boot contract** | `load_addr` / `entry_addr` semantics; what substrate still builds | [ADR 0004](adr/0004-boot-contract-with-substrate.md) | boot-smoke |
| **Initramfs** | substrate-supplied ext4 disk (base); vendored prebuilt initrd blob (TEE, deferred) | [design/initramfs.md](design/initramfs.md) | boot-smoke; TEE attestation |
| **Confidential-compute variants** | the quarantined TEE patches + sev/tdx configs; vendored firmware/initrd blobs (deferred) | [ADR 0009](adr/0009-confidential-compute-variants.md) | variant-specific |

## 4. The architecture × variant matrix

The artifact name is `linux-<version>-<variant>-<arch>.kernel` (e.g.
`linux-6.12.91-base-aarch64.kernel`).

| | x86_64 | aarch64 | riscv64 |
|---|---|---|---|
| **base** | ✅ kernel binary = `vmlinux` (ELF); packer flattens PT_LOAD | ✅ kernel binary = `Image`; packer takes it raw | ✅ `Image`; raw (carried, not CI-gated) |
| **debug** | ✅ base + ftrace/kprobes/PERF/BPF_EVENTS/BTF/DWARF5/KGDB ([ADR 0013](adr/0013-debug-variant.md)) | ✅ same set of additions | — (no substrate consumer) |
| **sev** (AMD SEV-SNP) | ✅ opt-in, deferred ([ADR 0009](adr/0009-confidential-compute-variants.md)); adds the TEE series + vendored qboot + initrd blobs | — (TEE is x86-only) | — |
| **tdx** (Intel TDX) | ✅ opt-in, deferred ([ADR 0009](adr/0009-confidential-compute-variants.md)) | — | — |
| **windows** (WHP) | ✅ Hyper-V config; packed at 4 KiB (carried, not CI-gated) | — | — |

**CI / boot-smoke scope:** x86_64 + aarch64 for both **base** and **debug**
([ADR 0013](adr/0013-debug-variant.md)). riscv64 and the windows variant are
carried for completeness and are buildable + golden-tested, but are not
substrate boot targets ([ADR 0002](adr/0002-target-architectures.md)).

## 5. Capability surface vs substrate's device scope

The kernel carries the drivers for substrate's full feature contract — virtio
block, net (incl. TSI), vsock (incl. datagrams), console, rng, and virtio-fs/DAX
for optional `--volume` mounts — plus a few that substrate may not instantiate in
every configuration (e.g. virtio-rtc). A driver with no host-side device is inert;
the guest→host security boundary is enforced by **substrate not creating the
device**, never by the kernel lacking the driver. The header carries no capability
advertisement; the carried set is fixed per variant and
substrate wires what it instantiates. The boundary, and the specific TEE exception
(out of base, opt-in only), are
[ADR 0008](adr/0008-kernel-capability-surface-vs-vmm-scope.md) and
[ADR 0009](adr/0009-confidential-compute-variants.md).

## 6. Budgets

Two artifact budgets are tracked, both as review signals rather than hard gates:

- **Image size** — the bundle is injected into guest RAM; a smaller monolithic
  kernel means less reserved memory and faster mapping. The config strategy
  ([design/kernel-config.md](design/kernel-config.md)) keeps the driver set
  minimal precisely to hold this budget. A size regression at a version bump or a
  new `CONFIG_*` is surfaced for review.
- **Boot-to-userspace time** — the microVM value proposition is fast boot. The
  no-modules, virtio-only config and the orderly-init patches serve this. Measured
  in the boot-smoke lane ([testing/boot-smoke.md](testing/boot-smoke.md)).

(These replace what a Rust VMM would track as data-plane performance;
substrate-kernel produces a static artifact, so the budgets are about the artifact,
not a running hot path. This is why this repo has no `performance/` or
`instrumentation/` tree — those describe a running monitor, not a build output.)

## 7. Build-order roadmap

Build incrementally; each step is fully verified by its gate (§8 of
[CLAUDE.md](../CLAUDE.md), [testing/strategy.md](testing/strategy.md)) before the
next. Steps are named by deliverable, never numbered in source or other docs.

1. **The pin and the bare build** — `scripts/kernel-pin.env`, the fetch + sha256
   verify, the pinned build container, and an unpatched stock-config build that
   compiles for both architectures. Proves the toolchain and the pipeline skeleton.
2. **The packer and the bundle format** — `pack-kernel` and the header; produce a
   bundle from a stock kernel and lock the layout with the bundle-golden gate.
   This is the contract substrate codes against, so it lands early.
3. **The minimal base config** — the curated monolithic, virtio-only `.config` per
   architecture, with the config-invariant gate. First image that is *ours*.
4. **The core patch series** — orderly init-death shutdown plus any boot-protocol
   patches the base config needs (x86 ACPI hypervisor fixes). First guest that
   boots under substrate (boot-smoke lands here, with substrate's KVM backend).
5. **The device-enabling patches** — vsock datagrams, TSI, virtio-fs/DAX,
   virtio-rtc, and the supporting fixes, each justified in
   [design/patches.md](design/patches.md), each part of the fixed feature set,
   each exercised by boot-smoke as substrate wires the matching device.
6. **Reproducibility hardening** — fixed build metadata, the `make repro-check`
   byte-identity gate, and the drift lane for pin bumps.
7. **The debug variant** — a second cell per (x86_64, aarch64) that ships the
   base kernel + ftrace, kprobes, BPF tracing, DWARF5/BTF debug info, and kgdb,
   so debugging the substrate guest does not require a custom build. CI gates
   the variant the same way base is gated; release.yml publishes the debug
   bundles alongside base ([ADR 0013](adr/0013-debug-variant.md)).
8. **The confidential-compute variants (deferred)** — the quarantined TEE patches +
   sev/tdx configs for x86_64, opt-in and never in a base build; the vendored
   firmware/initrd blobs are wired later
   ([ADR 0009](adr/0009-confidential-compute-variants.md)).

## 8. Decisions (recorded as ADRs)

Each significant decision is an ADR ([adr/](adr/), format per CLAUDE.md §7). Read
the ADR for the *why*.

- The kernel source pin and how/when it is bumped — [ADR 0001](adr/0001-kernel-source-pin-and-update-lifecycle.md).
- The target architectures (x86_64 / aarch64 / riscv64 + the windows variant carried for completeness; CI gates x86_64 + aarch64) — [ADR 0002](adr/0002-target-architectures.md).
- The kernel bundle format (a fixed header (magic `SUBK`), pre-flattened, page-aligned) — [ADR 0003](adr/0003-kernel-bundle-format.md).
- The boot contract with substrate (`load_addr`/`entry_addr`; the x86 64-bit `boot_params` entry; what substrate still builds) — [ADR 0004](adr/0004-boot-contract-with-substrate.md).
- The build environment and reproducibility (pinned container, fixed metadata, byte-identity gate) — [ADR 0005](adr/0005-build-environment-and-reproducibility.md).
- The kernel config strategy (monolithic, no modules, virtio-only, per-(arch, variant)) — [ADR 0006](adr/0006-kernel-config-strategy.md).
- The patch-management policy (ordered series, why-headers, config-over-patch, clean rebase) — [ADR 0007](adr/0007-patch-management-policy.md).
- The capability-surface vs VMM-device-scope boundary — [ADR 0008](adr/0008-kernel-capability-surface-vs-vmm-scope.md).
- The confidential-compute variants (TEE/SEV/TDX, opt-in, quarantined) — [ADR 0009](adr/0009-confidential-compute-variants.md).
- The auto-loaded documentation manifest — [ADR 0010](adr/0010-auto-loaded-doc-context.md).
- The download proxy (CF Worker over R2, one analytics event per download) — [ADR 0011](adr/0011-download-proxy-with-analytics.md).
- Listing-page web analytics + download correlation — [ADR 0012](adr/0012-listing-page-web-analytics-and-correlation.md).
- The debug variant (base + ftrace + kprobes + BPF tracing + BTF + DWARF5 + kgdb) — [ADR 0013](adr/0013-debug-variant.md).

**The design-doc discipline (§7 / CLAUDE.md §1):** every build component carries a
design document under [`docs/design/`](design/) that records
the subtle/security-critical details, and states our design — written *before* the
build code. The discipline and the component map are in
[`docs/design/README.md`](design/README.md).
