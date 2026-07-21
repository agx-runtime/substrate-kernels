# ADR 0006 — Kernel config strategy

- **Status:** Accepted
- **Date:** 2026-05-27
- **Context doc:** [../design/kernel-config.md](../design/kernel-config.md) (the
  enabled/disabled set + the per-(arch, variant) deltas)

## Context

The guest kernel's `.config` determines what the image *is*: its size (it is
injected into guest RAM — architecture.md §6 budget), its boot speed (the microVM
value proposition), its driver surface, and which substrate features it can
support. A distro `defconfig` is the wrong starting point — it enables hundreds of
drivers and subsystems a microVM never touches, bloating the image and the attack
surface. We need a curated, minimal, **monolithic** config, and a clear policy for
how config relates to the patch series (CLAUDE.md §1: prefer config over patch).

## Decision

1. **Curated and minimal, not distro-derived.** The config starts from the smallest
   kernel that boots under substrate and adds only what substrate's feature
   contract requires. Every non-default `CONFIG_*` is deliberate and carries a
   stated rationale ([design/kernel-config.md](../design/kernel-config.md));
   `make olddefconfig` normalizes it against the pinned source.

2. **Monolithic — no loadable modules (`CONFIG_MODULES=n`).** A microVM image is
   self-contained; module loading adds boot-time, an initramfs dependency, and a
   surface we don't want. Every needed driver is built in (`=y`).

3. **Virtio-mmio device model.** The enabled device drivers match substrate's set:
   virtio block, net, vsock, console, rng, balloon, and non-DAX virtio-fs for
   optional `--volume` mounts. arm64 also carries PL031; x86 carries ACPICA for the
   AML-described virtio-mmio devices. DAX, virtio-RTC, TSI, PCI, and TEE support are
   disabled because substrate does not expose those contracts.
   Non-virtio device classes a microVM never sees — USB, sound, most of PCI, framebuffer/DRM —
   are disabled. (GPU/DRM is cut outright, CLAUDE.md §1.)

4. **Bounded resources are set to substrate's actual limits.** `CONFIG_NR_CPUS` is
   set to substrate's maximum vCPU count, not a distro maximum; other capacity
   knobs follow. A bound left at a distro default is image bloat with no benefit
   (CLAUDE.md §5).

5. **One full `.config` per (arch, variant).** `config-<variant>_<arch>` for each
   supported cell of the matrix (ADR 0002). They are full configs (not fragments
   layered at build time) so the build is a simple copy + `olddefconfig`, and the
   **deltas between them are documented** in
   [design/kernel-config.md](../design/kernel-config.md) so a reader sees exactly
   what debug/windows or an architecture adds.

6. **Reproducibility-hostile options are disabled.** Embedded build IDs and
   timestamps are turned off in config wherever possible, complementing the fixed
   `KBUILD_BUILD_*` metadata (ADR 0005).

7. **A config-invariant gate.** After `olddefconfig`, a gate asserts the required
   `CONFIG_*` are present and forbidden ones absent, per (arch, variant)
   ([testing/strategy.md](../testing/strategy.md)). `olddefconfig` can silently
   drop an option whose dependency changed across a version bump; the gate catches
   that at build time, not at guest boot.

## Consequences

- The image is small and boots fast — the size and boot-time budgets
  (architecture.md §6) are held by construction, not by after-the-fact trimming.
- The driver surface inside the guest is exactly substrate's device set plus the
  documented extras; nothing a microVM never uses is present to attack or to slow
  boot.
- "Prefer config over patch" (CLAUDE.md §1) has teeth: a capability a toggle can
  enable is enabled here, keeping the patch series (ADR 0007) to changes the config
  cannot express.
- Full-config-per-cell keeps the build trivial and the diffs auditable, at the cost
  of some duplication between cells — accepted, because the documented deltas make
  the duplication legible and `olddefconfig` keeps them consistent with the source.
- The config-invariant gate makes a silent `olddefconfig` drop a build failure.

## Alternatives considered

- **Start from `defconfig` / a distro config and trim** — rejected: it inverts the
  default (enabled-unless-removed), so the image carries whatever nobody got around
  to cutting; curated-minimal makes every inclusion deliberate.
- **Allow modules + an initramfs of `.ko`s** — rejected: modules add boot latency
  and an initramfs dependency for no microVM benefit; monolithic is simpler and
  faster.
- **Config fragments layered at build time (`merge_config.sh`)** — rejected for the
  cross-cell case: full configs make the build a copy + `olddefconfig` and make the
  per-cell deltas reviewable as plain diffs; fragments hide the resulting config
  until build time and complicate the invariant gate. (Documented deltas give the
  legibility fragments would, without the build-time indirection.)
- **Trust `olddefconfig` without an invariant gate** — rejected: `olddefconfig`
  silently resolves changed dependencies, which can drop a required option across a
  version bump; the gate turns that into a visible failure.
