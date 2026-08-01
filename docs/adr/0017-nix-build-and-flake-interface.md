# ADR 0017 — Nix builds the bundles, and the flake is the interface

- **Status:** Accepted
- **Date:** 2026-08-01
- **Context doc:** [../design/build-pipeline.md](../design/build-pipeline.md) (the stages);
  [../design/reproducibility.md](../design/reproducibility.md) (the gate);
  [0005](0005-build-environment-and-reproducibility.md) (the toolchain pin this realizes)

## Context

The pipeline was a Makefile driving a digest-pinned Debian container. Three pressures broke
that shape.

The container's pin was shallower than it claimed. The Dockerfile pinned the base image by
digest and then installed the toolchain with `apt-get install` and no package versions, so
`make image` on two different dates produced two different compilers — the pin held only for a
machine that kept the old image cached, and the reproducibility gate compared builds against a
toolchain that itself drifted (ADR 0005 records the replacement).

Setup was real. A new machine needed Docker, a container build, and a Python venv for the
packer's tests before the first bundle came out, and each of those is a support conversation.
The goal is that a teammate clones the repository, runs `just build`, and has a bundle.

The org binary cache exists. cachet serves every repository in the organisation, CI
authenticates to it with a job-scoped OIDC token, and kernel bundles are exactly the
expensive, organisation-specific artifacts it was built to hold. A build system whose outputs
are Nix store paths gets that cache for free, because a store path CI has pushed is a store
path a laptop can download instead of compiling.

## Decision

1. **Every pipeline stage is a Nix derivation, declared in `flake.nix` and built by
   `nix/kernel.nix`.** The pinned tarball is a fixed-output fetch whose sha256 Nix itself
   verifies (the pin files under `scripts/kernel-pins/` stay the single source, parsed by
   `nix/pins.nix`); the patch series applies inside the sandbox under the same zero-fuzz,
   zero-offset rule the Makefile enforced; `olddefconfig` and the config-invariant gate run in
   the same derivation that compiles; the packer runs last and the derivation's output is the
   bundle, the raw kernel binary for the boot-smoke lane, and the normalized config for audit.

2. **One derivation exists per (line, variant, guest architecture) cell, on one canonical
   build system.** x86_64 and aarch64 cells compile natively on their own architecture,
   because CI has native runners for both and nixpkgs' native compilers come prebuilt from
   cache.nixos.org; the riscv64 cell cross-compiles from x86_64-linux because no riscv64
   builder exists anywhere we run. One canonical system per cell means one store path per
   cell, and one store path is what makes the cache effective — a second build system for the
   same cell would be a second store path that misses the cache the first one filled.

3. **The gates are flake checks.** `nix flake check` on a system runs the static gates
   (doc-manifest, bundle-golden, pack-unit), the applies-clean gate for both lines, and each
   configured gate whose cell builds on that system. The full compiles stay out of the checks
   and behind explicit `just build` and the CI build matrix, so the check verb stays minutes.

4. **`just` verbs are the human surface, and each is a thin alias over a flake output.** The
   Justfile holds no logic beyond translating `line=6.12` into the underscore form the
   attribute names carry (a dot in `.#kernel-6.12-…` splits the attribute path). Logic
   belongs in the flake, where CI and a laptop run the same expression.

5. **CI builds the same flake outputs and pushes them to cachet.** Every job authenticates
   with its OIDC token through the cachet-setup action — no stored cache credential exists in
   this repository — and the build matrix pushes each cell's closure. Each cell renews its own
   lease (`agx-runtime-substrate-kernels-<line>-<variant>-<arch>`), because a lease is
   replaced wholesale on renewal, so eight parallel jobs sharing one lease would each erase
   the other seven cells' protection.

6. **macOS builds through the nix-darwin `linux-builder` VM, and only on a cache miss.** The
   host daemon queries substituters before it schedules any build, so a laptop that has run
   `just cache-login` downloads CI's bundles directly and the VM sits idle. On a miss — local
   kernel hacking — the host copies the inputs it substituted into the VM over the builder's
   ssh channel and the VM compiles. The VM therefore needs no cache credential and no
   configuration beyond existing: credentials stay host-side, in the daemon netrc
   `cache-login` writes.

## Consequences

- Host prerequisites drop to Determinate Nix, direnv, and — for compiling kernels on a Mac —
  the linux-builder VM. Docker is gone: the container, its image build, and the venv are
  deleted, and the packer's Python and pyelftools come from the dev shell and the sandbox.
- A clone on a machine that ran `just cache-login` builds nothing the org has already built:
  `just build` resolves to a store path CI pushed and downloads it. The first build of a
  changed kernel still costs a compile, on the VM or on CI.
- The riscv64 cross toolchain is not prebuilt by cache.nixos.org, so the first CI build of
  the riscv64 cell compiles gcc once; cachet then serves that toolchain to every later run.
- Each stage re-extracts the tarball rather than sharing a patched-tree derivation. A patched
  tree is roughly 1.5 GB, CI pushes every store path it builds, and a shared tree derivation
  would push gigabytes per line to save a roughly thirty-second extraction. The tarball
  itself is one store object, deduplicated by hash.
- The bytes of every bundle changed at this landing, because the nixpkgs compiler replaced
  Debian's. ADR 0005 records why that break was taken deliberately and once.
- `nix build --rebuild` (the `just repro-check` verb) now also cross-checks the cache: on a
  substituted path it compiles locally and compares against what the cache served, which the
  container gate had no way to do.

## Alternatives considered

- **Nix as dev shell only, keeping the container pipeline.** Rejected: it fixes the venv and
  the tool-install friction while leaving the apt-level toolchain drift, the Docker
  requirement, and the cache-less builds — the three problems that motivated the change.
- **Nix as the toolchain inside the existing Makefile.** Rejected: it pins the compiler but
  keeps the pipeline outside the sandbox, so ambient host state can still reach the build,
  and the outputs are not store paths, so the org cache cannot serve them.
- **Keeping Docker as the macOS bridge beside a Nix build.** Rejected: two Linux execution
  environments to keep byte-identical is exactly the two-toolchains problem again; the
  linux-builder VM is Nix's own bridge and builds the same derivations.
- **One cross-toolchain for every architecture, as the container did.** The container
  cross-compiled even natively-buildable cells so the compiler would not vary with the host.
  Under Nix the derivation pins the compiler regardless, native compilers arrive prebuilt
  from cache.nixos.org, and CI has native runners for both gated architectures — so
  cross-for-everything would compile a cross gcc from source and buy nothing. Rejected for
  the gated cells, kept for riscv64 where there is no native builder.
- **A shared patched-tree derivation between the gates and the build.** Rejected for the
  push-size reason in the consequences: the cache would carry gigabytes of intermediate tree
  per line to save seconds of extraction.
