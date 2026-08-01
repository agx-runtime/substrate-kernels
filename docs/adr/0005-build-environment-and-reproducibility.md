# ADR 0005 — Build environment and reproducibility

- **Status:** Accepted
- **Date:** 2026-08-01
- **Context doc:** [../design/reproducibility.md](../design/reproducibility.md)
  (the mechanics + the gate); CLAUDE.md §3 (reproducibility is a law);
  [0017](0017-nix-build-and-flake-interface.md) (the build system that realizes this)

## Context

CLAUDE.md §3 makes byte-reproducibility a law: the same pinned source (ADR 0001), patch
series, and config must yield a byte-identical `.kernel` on any host. A guest kernel that two
builds disagree on cannot be attested, cached by digest, or debugged with confidence. Three
things break reproducibility if left ambient:

1. **The toolchain.** Kernel output is sensitive to the compiler, binutils, and build
   utilities; two hosts with different toolchains produce different images from identical
   source.
2. **Build metadata.** The kernel embeds `KBUILD_BUILD_TIMESTAMP`, `_USER`, `_HOST`, and
   assorted build IDs, so wall-clock time and host identity leak into the image unless they
   are fixed.
3. **The host OS.** The primary dev host is macOS on Apple Silicon, and a Linux kernel must
   be built on Linux, so the environment has to bridge that without making the result depend
   on which side built it.

The first answer was a digest-pinned Debian container. Its pin was shallower than it
claimed: the digest fixed the base image, and the Dockerfile then ran `apt-get install` with
no package versions, so rebuilding the image on two different dates installed two different
compilers. The pin held only for a machine that kept the old image cached, which means the
toolchain was pinned by accident of caching rather than by construction.

## Decision

1. **The toolchain is pinned by `flake.lock`.** Every compiler, linker, and build utility a
   derivation uses is a Nix store path fixed by the locked nixpkgs revision, so the toolchain
   is an input with a content hash rather than a package name resolved at install time.
   Bumping the lock is an explicit, reviewed change that re-runs the reproducibility gate,
   exactly like bumping the source pin (ADR 0001).

2. **The build runs in the Nix sandbox.** No ambient host state — PATH, locale, wall clock
   beyond the fixed metadata, the host's own toolchain — reaches the compile, because the
   sandbox admits only declared inputs. Cross-host identity stops being a discipline and
   becomes the construction.

3. **Each cell builds on one canonical build system** (ADR 0017): x86_64 and aarch64
   natively on their own architecture, riscv64 cross from x86_64-linux. One canonical system
   per cell means the question "which toolchain built this" has exactly one answer.

4. **On macOS the Linux build runs in the nix-darwin `linux-builder` VM**, which builds the
   same derivations from the same lock; a laptop that only consumes bundles substitutes them
   from the org cache and needs no builder at all (ADR 0017).

5. **Build metadata is fixed inside the derivation.** `KBUILD_BUILD_TIMESTAMP`,
   `KBUILD_BUILD_USER`, and `KBUILD_BUILD_HOST` are constants in `nix/kernel.nix`, and the
   config disables embedded build IDs and timestamps wherever it can
   ([design/kernel-config.md](../design/kernel-config.md)).

6. **`just repro-check` is the gate.** `nix build` realizes the cell — by substitution when
   the cache holds it — and `nix build --rebuild` then compiles it locally and fails if a
   single byte differs. On a substituted path the gate therefore also proves the cache serves
   exactly what this commit's source builds, a comparison the container gate could not make.

The switch from Debian's gcc to nixpkgs' gcc changed the bytes of every bundle. That break
was taken deliberately and once, at this landing, and `KBUILD_BUILD_HOST` was renamed from
the historical `substrate-kernel` to `substrate-kernels` at the same moment — the Makefile
had recorded that the rename should ride the next bytes-changing event rather than cause its
own.

## Consequences

- The bundle is content-addressable: a digest identifies an exact (source + patches + config
  + toolchain) tuple, and the toolchain part of that tuple is now a hash in `flake.lock`
  rather than a container image someone may or may not still have.
- A macOS developer's VM build and a Linux CI runner's build are the same derivation, so
  "works on my machine" cannot diverge the artifact.
- Docker leaves the repository: no image to build, no digest to bump, no drift between the
  image on one machine and the image on another.
- The reproducibility claim is scoped per cell to its canonical build system. The gate proves
  a rebuild on that system is byte-identical; it makes no claim about building the same cell
  on a foreign system, because no such derivation exists to build.

## Alternatives considered

- **Keep the digest-pinned container.** Rejected: the digest pins the base image while the
  package installs float with the distro archive, so the toolchain drifts on every image
  rebuild, and the drift is invisible until `repro-check` fails on a machine that rebuilt the
  image — the failure then points at the kernel rather than at apt.
- **Build on the host toolchain directly.** Rejected: a macOS host cannot build a Linux
  kernel at all, and two Linux hosts with different toolchains produce different bytes, which
  makes the gate meaningless.
- **Let timestamps and build IDs vary, compare "functionally equivalent" images.** Rejected:
  functional equivalence is unfalsifiable for a kernel image; byte-identity is the only check
  that proves reproducibility (CLAUDE.md §3).
- **Pin source but not toolchain.** Rejected: identical source through two compilers yields
  two images, so both pins are required for the gate to mean anything.
