# Design: the build pipeline (pin → bundle)

One Nix derivation per cell — one (line, variant, guest architecture) triple of the
build matrix — turns a pinned Linux release into a `.kernel` bundle
([architecture.md](../architecture.md) §2). The `bundle` constructor in
`nix/kernel.nix` builds each cell, `flake.nix` declares the outputs, and every stage
runs inside the Nix sandbox, which admits only declared inputs
([ADR 0017](../adr/0017-nix-build-and-flake-interface.md),
[ADR 0005](../adr/0005-build-environment-and-reproducibility.md)).

## Background

The stages run as stdenv phases inside the cell's derivation. `pkgs.fetchurl` fetches
`linux-<version>.tar.xz` as a fixed-output derivation, trying the pin's primary and
fallback URLs in order; Nix verifies the checked-in sha256 from
`scripts/kernel-pins/<line>.env`, which `nix/pins.nix` parses into the flake. The
patch phase applies the line's series with a strict loop: GNU patch exits zero after
guessing an offset, so the loop greps the patch output and fails on any fuzz or
offset report. The configure phase copies the cell's config file, runs
`make ARCH=<karch> olddefconfig`, and re-asserts the config invariants with
`config-invariant.py`. The build phase compiles the one make target the packer
consumes, with the fixed `KBUILD_BUILD_*` constants set and kbuild parallelism taken
from `$NIX_BUILD_CORES`. The install phase runs `pack-kernel.py` and stages three
files into `$out`: `linux-<version>-<variant>-<arch>.kernel` (the bundle),
`kernel-binary` (the raw kernel, which the QEMU boot-smoke lane consumes), and
`config` (the normalized config, so a released bundle can be audited without
rebuilding it).

## Subtle details & gotchas

| Detail | Convention | Our handling | Gate |
|---|---|---|---|
| **Source must be hash-verified** — a version string is not a content identity | fetches by version only | the fetch is a fixed-output derivation, so Nix itself verifies the checked-in sha256 from `scripts/kernel-pins/<line>.env`, and the fallback URL must satisfy the same hash ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)) | Nix refuses a hash mismatch before any stage runs |
| **Patches must apply with zero fuzz** — fuzz means context drift and a possibly-misplaced hunk | `patch -p1` in a shell loop (tolerates fuzz) | apply with `patch -p1 -F0 --no-backup-if-mismatch` and grep the output for any fuzz or offset report, because GNU patch exits zero after guessing an offset; any hit fails the build ([ADR 0007](../adr/0007-patch-management-policy.md)) | the `applies-clean-<line>` flake check |
| **`olddefconfig` can silently drop a required option** when a dependency changed across a version bump | runs `olddefconfig`, no post-check | run `olddefconfig`, then `config-invariant.py` re-asserts the required and forbidden sets ([ADR 0006](../adr/0006-kernel-config-strategy.md)) | the `configured-<line>-<variant>-<arch>` flake check |
| **Build metadata leaks wall-clock/host into the image** | fixes `KBUILD_BUILD_*` to constants | `KBUILD_BUILD_TIMESTAMP`, `_USER`, and `_HOST` are constants in `nix/kernel.nix`, and the config disables embedded build IDs ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)) | `just repro-check` |
| **Per-arch kernel binary differs** — flattened ELF on x86_64, raw `Image` on aarch64 and riscv64 | dispatches on arch | build only the target the packer consumes (`vmlinux` on x86_64, `Image` on aarch64 and riscv64), so the compressed images nothing reads are never built ([ADR 0004](../adr/0004-boot-contract-with-substrate.md)) | bundle-golden + boot-smoke |
| **Building a Linux kernel on a macOS host** | delegates to a Linux microVM builder | the host daemon substitutes CI-built cells from the org cache first, and only on a miss does the nix-darwin `linux-builder` VM compile the same derivation ([ADR 0017](../adr/0017-nix-build-and-flake-interface.md)) | `just repro-check` |
| **A clean build must be reconstructible from `pin + patches`** — no forked tree checked in | extracts into a working dir | the patched tree exists only inside the sandbox: each derivation re-extracts the tarball, because a shared patched-tree derivation is roughly 1.5 GB and CI pushes every store path it builds ([ADR 0017](../adr/0017-nix-build-and-flake-interface.md)) | the repository has no kernel source tree |

## Our design

`flake.nix` declares the derivations, and every `just` verb is a thin alias over a
flake output; the Justfile holds no logic beyond translating `line=6.12` into the
underscore form the attribute names carry
([ADR 0017](../adr/0017-nix-build-and-flake-interface.md)).

- **Pin selection** — `line` (default `6.12`) selects `scripts/kernel-pins/<line>.env`,
  so `just line=6.18 build` builds the 6.18 cell. Each pin file supplies its exact
  version, primary and fallback tarball URLs, and sha256; the flake (through
  `nix/pins.nix`) and `release.yml` read the same file, so the pin has one source
  ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)).
- **Attribute names** — flake attributes carry the line with an underscore
  (`kernel-6_12-base-x86_64`), because a dot in a `.#` fragment splits the attribute
  path and nix reports the attribute as missing; the Justfile performs that
  translation.
- **One canonical build system per cell** — x86_64 cells compile natively on
  x86_64-linux and aarch64 cells on aarch64-linux; the riscv64 cell cross-compiles
  from x86_64-linux through `pkgsCross`, because no riscv64 builder exists in CI or on
  a laptop. Exactly one derivation, and therefore one store path, exists per cell, and
  one store path per cell is what lets the org cache serve every machine that asks for
  that cell.
- **The compile** — `make vmlinux` on x86_64 and `make Image` on aarch64 and riscv64,
  under `hardeningDisable = [ "all" ]`, because kbuild owns its own hardening flags
  and a flag injected by the nixpkgs cc wrapper would both conflict with kbuild's and
  tie the produced bytes to nixpkgs' hardening defaults.
- **The cache** — every CI job authenticates to the org binary cache (cachet, at
  `pkg-cache.loopholelabs.io`) with its job-scoped OIDC token through the
  `agx-runtime/cachet/action@main` composite; the build lane pushes each cell's
  closure and renews the cell's lease,
  `agx-runtime-substrate-kernels-<line>-<variant>-<arch>`. A laptop authenticates
  to the cache once (with `cache-login`, run from a cachet checkout), and `just build` on
  that machine downloads a CI-built cell instead of compiling it.
- **`just install`** — stages `result/*.kernel` into
  `<prefix>/lib/substrate/kernels/`, the path substrate reads.
- **The carried cells** — riscv64-base and x86_64-windows remain buildable flake
  outputs outside the release boot matrix
  ([ADR 0002](../adr/0002-target-architectures.md)).

## Verification

`nix flake check` — the `just ci` verb — runs a system's whole gate set. The static
gates (`doc-manifest`, `bundle-golden`, `pack-unit`) are pure Python and shell over
the repository tree, so they run on every system, macOS included. The
`applies-clean-6_12` and `applies-clean-6_18` gates extract the tarball and apply the
patch series, which also runs on every system. Each
`configured-<line>-<variant>-<arch>` gate runs `olddefconfig` plus the
config-invariant check on its cell's canonical Linux system. Full compiles stay out
of the checks and behind explicit `just build` and the CI build matrix, so the check
verb finishes in minutes ([ADR 0017](../adr/0017-nix-build-and-flake-interface.md)).
`just repro-check` proves byte-identity ([reproducibility.md](reproducibility.md)),
and the boot-smoke lane boots the produced `kernel-binary` under QEMU
(`just boot-smoke`; in CI the lane consumes the build job's artifact), while the real
guest boot under substrate is the cross-repo lane
([testing/boot-smoke.md](../testing/boot-smoke.md)). The full plan is
[testing/strategy.md](../testing/strategy.md).
