# Design: reproducibility

The mechanics that make a `.kernel` byte-identical across builds and hosts, and the
gate that proves it. This realizes CLAUDE.md §3 and
[ADR 0005](../adr/0005-build-environment-and-reproducibility.md); it depends on the
source pin ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)).

## Background

We fix `KBUILD_BUILD_TIMESTAMP`/`_USER`/`_HOST` to constants in `nix/kernel.nix`, pin
the toolchain through `flake.lock`, and run every compile inside the Nix sandbox,
which admits only declared inputs. On macOS, a cell the org cache does not already
hold compiles in the nix-darwin `linux-builder` VM, so the kernel is built on Linux
regardless of host. The first pinned environment was a digest-pinned Debian
container, and its pin was shallower than it claimed: the digest fixed the base image
while `apt-get install` resolved package versions at image-build time, so the
toolchain drifted on every image rebuild
([ADR 0005](../adr/0005-build-environment-and-reproducibility.md) records the
replacement). The byte-identity discipline follows substrate's UAPI-reproducibility
model (substrate ADR 0010).

## Subtle details & gotchas

| Detail | Convention | Our handling | Gate |
|---|---|---|---|
| **Toolchain drift changes the image** — gcc/clang/binutils version affects codegen | builds on whatever the VM has | every compiler, linker, and build utility is a Nix store path fixed by the nixpkgs revision in `flake.lock`, and the compile runs in the Nix sandbox, so the host's own toolchain cannot reach it ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)) | `just repro-check` |
| **Build metadata leaks wall-clock/host** | fixes `KBUILD_BUILD_*` | the same constants, set in `nix/kernel.nix`, plus config-disabled embedded build IDs/timestamps ([kernel-config.md](kernel-config.md)) | `just repro-check` |
| **Source identity ≠ version string** | fetches by version | the fetch is a fixed-output derivation, so Nix verifies the checked-in sha256 before any build stage may touch the tarball ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)) | the fixed-output hash check |
| **Packer non-determinism** — dict/iteration order, padding bytes | (flat packer) | the packer pads with explicit zero bytes and emits fields in fixed order ([bundle-format.md](bundle-format.md)); no host-dependent input | bundle-golden |
| **Parallel BTF encoding is nondeterministic** — pahole 1.24 can assign type IDs in worker-completion order | upstream kbuild passes `-j` to pahole | carry `0003`, which omits pahole's `-j` only when fixed `KBUILD_BUILD_TIMESTAMP` metadata selects the reproducible build; compilation itself remains parallel | `just repro-check` on the debug variant |
| **"Functionally equivalent" is unfalsifiable** for a kernel image | (no byte check) | assert byte-identity: `nix build --rebuild` recompiles the cell and fails if a single byte differs (CLAUDE.md §3) | `just repro-check` |

## Our design

The reproducibility surface is four pinned inputs and one gate:

1. **Pinned source** — exact version + sha256 in `scripts/kernel-pins/<line>.env`,
   fetched by `pkgs.fetchurl` as a fixed-output derivation, so Nix itself verifies
   the hash before extraction and the fallback URL must satisfy the same hash
   ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)).
2. **Pinned toolchain** — every compiler, linker, and build utility is a store path
   fixed by the nixpkgs revision in `flake.lock`, and the compile runs in the Nix
   sandbox ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)). The
   derivation sets `hardeningDisable = [ "all" ]`, because the nixpkgs cc wrapper
   would otherwise inject hardening flags into every compile, and the produced bytes
   would then depend on nixpkgs' hardening defaults as well as on the curated config.
3. **Pinned config + patches** — the per-cell `.config`
   ([kernel-config.md](kernel-config.md)) and the ordered series
   ([patches.md](patches.md)) are checked in and applied deterministically.
4. **Fixed build metadata** — `KBUILD_BUILD_TIMESTAMP`/`_USER`/`_HOST` constants in
   `nix/kernel.nix`, plus config-disabled embedded IDs/timestamps.
   `KBUILD_BUILD_HOST` was renamed from the historical `substrate-kernel` to
   `substrate-kernels` when the Nix toolchain landed, because the host name is baked
   into every image as `LINUX_COMPILE_HOST` and the toolchain switch changed every
   bundle's bytes anyway, so the rename rode a break that was already being taken.

`just repro-check` realizes the cell with `nix build` — by substitution when the org
cache holds it — and `nix build --rebuild` then compiles it locally and fails if a
single byte differs. On a substituted path the gate therefore also proves the cache
serves exactly what this commit's source builds, a comparison the container gate
could not make, and the two builds it compares came from two different machines, so a
passing run measured cross-host identity as well. The claim is scoped per cell to its
canonical build system ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)):
a macOS developer's `linux-builder` VM and a Linux CI runner realize the same
derivation and compute the same store path, and no derivation exists that builds a
cell on a foreign system for the claim to cover. A toolchain bump — a new nixpkgs
revision in `flake.lock` — is an explicit, reviewed change that re-runs this gate,
exactly like a source-pin bump.

## Verification

`just repro-check` is the gate: one build, then `nix build --rebuild`, failing on any
byte difference. The 6.12.96 and 6.18.39 audit first ran it without `0003`: both
stock-pahole controls produced different bundle hashes. Adding only `0003` made both
pairs byte-identical, so the patch has a measured keep condition rather than a
theoretical rationale.

| Debug x86_64 input | Clean build A SHA-256 | Clean build B SHA-256 | Result |
|---|---|---|---|
| 6.12.96, stock parallel pahole 1.24 | `81a4fa3996d771ee9f2df5303dd16710e486d1c3f666a314a6b76dc652912d6c` | `fcb6cd3319efd2ee489ed026e37ab2f0e837a49a585ccbdfa255e18154406834` | different |
| 6.12.96, plus only `0003` | `14d2e67d72d98ec6d90e8b2800871b84333b1f6aba89eff783671cf4d95fad80` | `14d2e67d72d98ec6d90e8b2800871b84333b1f6aba89eff783671cf4d95fad80` | identical |
| 6.18.39, stock parallel pahole 1.24 | `87665bec439c4d07977fe6cd02cb9150af4024bb245bcf11308086a312e1a42a` | `c6705bf9be953a5128f17c50c563891e2ac29de180811fb7d971d746400d1256` | different |
| 6.18.39, plus only `0003` | `f8655ec2eb367b1cbd09814d280b906211f2482cc5398f748966112cdb0b7fb0` | `f8655ec2eb367b1cbd09814d280b906211f2482cc5398f748966112cdb0b7fb0` | identical |

The digests in this table were measured under the retired digest-pinned container
toolchain, so no current build reproduces them; the property the experiment
established — patch `0003` makes parallel-pahole BTF encoding deterministic — is what
carries, not the digests.

Bundle-golden
([testing/bundle-golden.md](../testing/bundle-golden.md)) independently locks the
header bytes so a packer change can't silently alter the format; CI runs the
repro-check lane over every CI-gated cell on pushes to main and on manual dispatch
(`ci.yml`), and `just repro-check` runs the same two commands on any machine
([testing/strategy.md](../testing/strategy.md)).
