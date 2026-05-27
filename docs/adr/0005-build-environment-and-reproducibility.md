# ADR 0005 — Build environment and reproducibility

- **Status:** Accepted
- **Date:** 2026-05-27
- **Context doc:** [../design/reproducibility.md](../design/reproducibility.md)
  (the mechanics + the gate); CLAUDE.md §3 (reproducibility is the point)

## Context

CLAUDE.md §3 makes byte-reproducibility a law: the same pinned source (ADR 0001),
patch series, and config must yield a **byte-identical** `.kernel` on any host. A
guest kernel that two builds disagree on cannot be attested, cached by digest, or
debugged with confidence. Three things break reproducibility if left ambient:

1. **The toolchain.** Kernel output is sensitive to the compiler, binutils, and
   build utilities (gcc/clang version, `ld`, `objcopy`); two hosts with different
   toolchains produce different images from identical source.
2. **Build metadata.** The kernel embeds `KBUILD_BUILD_TIMESTAMP`, `_USER`,
   `_HOST`, and assorted build IDs — wall-clock and host identity leaking into the
   image.
3. **The host OS.** The primary dev host is **macOS** (Apple Silicon), but a Linux
   kernel must be built on Linux. The build environment must bridge that without
   making the result host-dependent.

This is the build-system analogue of the problem substrate solves for its UAPI
bindings (substrate ADR 0010): pin the whole toolchain and verify byte-identity.

## Decision

1. **The Linux-only build stages run in a digest-pinned container**
   (`tools/build/Dockerfile`) carrying a pinned gcc/clang, binutils, make,
   `python3` + the ELF library the packer needs, and the kernel build
   dependencies. The container digest is checked in; an unpinned base image or a
   floating tag is not a reproducible environment.

2. **On macOS the build runs inside that container; on Linux it runs natively
   against the same pinned toolchain.** A developer on Apple Silicon builds the
   Linux kernel in the pinned Linux container (the same image CI uses); a Linux
   host uses the pinned toolchain directly. Both paths must produce the same bytes.

3. **Build metadata is fixed.** `KBUILD_BUILD_TIMESTAMP`, `KBUILD_BUILD_USER`, and
   `KBUILD_BUILD_HOST` are fixed constants passed to the kernel build, and the
   config disables embedded build IDs / timestamps wherever it can
   ([design/kernel-config.md](../design/kernel-config.md)). Nothing wall-clock- or
   host-dependent leaks into the image.

4. **`make repro-check` is the reproducibility gate.** It rebuilds from the pin in
   the pinned container and asserts byte-identity against a committed digest of the
   produced bundle; divergence fails the build. This is the §3 law made executable —
   the build-system counterpart to substrate's `make uapi-check`.

5. **The pin and the environment are co-dependent (ADR 0001).** Reproducibility is
   only meaningful because the *source* is pinned by sha256 *and* the *toolchain* is
   pinned by digest; neither alone suffices.

## Consequences

- The bundle is content-addressable: a digest identifies an exact (source + patches
  + config + toolchain) tuple, enabling caching, attestation, and confident
  debugging.
- A macOS developer and a Linux CI runner produce identical bytes; "works on my
  machine" cannot diverge the artifact.
- Bumping the toolchain (a new container digest) is an explicit, reviewed change
  that re-runs `repro-check`, exactly like bumping the source pin (ADR 0001) — the
  reproducibility gate would otherwise flag the drift.
- The container is required only for building; reading the docs, editing patches,
  and reviewing config need no Docker.

## Alternatives considered

- **Build on the host toolchain directly** — rejected: bindgen-style sensitivity
  applies to kernel builds too; a macOS host and a Linux runner would disagree and
  `repro-check` would be meaningless (the same reason substrate ADR 0010 containers
  its bindgen).
- **A build VM instead of a container** — rejected:
  a container is the lighter, more widely-available, digest-pinnable environment; a
  bespoke microVM builder is more moving parts for the same Linux-on-macOS bridge.
- **Let timestamps/build-IDs vary and compare "functionally equivalent" images** —
  rejected: "functionally equivalent" is unfalsifiable for a kernel image;
  byte-identity is the only check that actually proves reproducibility (CLAUDE.md
  §3).
- **Pin source but not toolchain** — rejected: source identity without toolchain
  identity does not yield identical bytes; both pins are required (Decision §5).
