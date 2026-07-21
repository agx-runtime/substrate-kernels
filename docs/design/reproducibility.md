# Design: reproducibility

The mechanics that make a `.kernel` byte-identical across builds and hosts, and the
gate that proves it. This realizes CLAUDE.md §3 and
[ADR 0005](../adr/0005-build-environment-and-reproducibility.md); it depends on the
source pin ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)).

## Background

We fix `KBUILD_BUILD_TIMESTAMP`/`_USER`/`_HOST` to constants and (on
macOS) builds inside a Linux VM so the kernel is built on Linux regardless of host.
The old build did not pin the toolchain by digest or assert byte-identity; this
repository adds both, following
substrate's UAPI-reproducibility model (substrate ADR 0010).

## Subtle details & gotchas

| Detail | Convention | Our handling | Gate |
|---|---|---|---|
| **Toolchain drift changes the image** — gcc/clang/binutils version affects codegen | builds on whatever the VM has | pin the toolchain in a **digest-pinned container** (`tools/build/Dockerfile`); same image on macOS and CI ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)) | `make repro-check` (cross-host byte-identity) |
| **Build metadata leaks wall-clock/host** | fixes `KBUILD_BUILD_*` | same constants + config-disabled embedded build IDs/timestamps ([kernel-config.md](kernel-config.md)) | `make repro-check` |
| **Source identity ≠ version string** | fetches by version | fetch by tag, **verify sha256** ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)) | the sha256 check |
| **Packer non-determinism** — dict/iteration order, padding bytes | (flat packer) | the packer pads with explicit zero bytes and emits fields in fixed order ([bundle-format.md](bundle-format.md)); no host-dependent input | bundle-golden |
| **Parallel BTF encoding is nondeterministic** — pahole 1.24 can assign type IDs in worker-completion order | upstream kbuild passes `-j` to pahole | carry `0003`, which omits pahole's `-j` only when fixed `KBUILD_BUILD_TIMESTAMP` metadata selects the reproducible build; compilation itself remains parallel | `make repro-check` on the debug variant |
| **"Functionally equivalent" is unfalsifiable** for a kernel image | (no byte check) | assert **byte-identity** across two clean rebuilds — the direct reproducibility check (CLAUDE.md §3) | `make repro-check` |

## Our design

The reproducibility surface is four pinned inputs and one gate:

1. **Pinned source** — exact version + sha256 in
   `scripts/kernel-pins/<line>.env`, verified before extract
   ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)).
2. **Pinned toolchain** — `tools/build/Dockerfile` at a checked-in digest;
   the same container builds on a macOS dev host and on Linux CI
   ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)).
3. **Pinned config + patches** — the per-cell `.config`
   ([kernel-config.md](kernel-config.md)) and the ordered series
   ([patches.md](patches.md)) are checked in and applied deterministically.
4. **Fixed build metadata** — `KBUILD_BUILD_TIMESTAMP`/`_USER`/`_HOST` constants
   plus config-disabled embedded IDs/timestamps.

**`make repro-check`** rebuilds the selected line/variant/architecture twice from
these inputs in the pinned container and asserts the two bundles are byte-identical;
divergence fails the build.
Because the source is hash-pinned and the toolchain digest-pinned, a macOS
developer and a Linux runner must produce the same bytes — the cross-host case is
the sharpest test of the law. A toolchain bump (new container digest) is an
explicit change that re-establishes the digest, exactly like a source-pin bump.

## Verification

`make repro-check` is the gate (two-clean-build byte-identity). The 6.12.96 and
6.18.39 audit first ran it without `0003`: both stock-pahole controls produced
different bundle hashes. Adding only `0003` made both pairs byte-identical, so the
patch has a measured keep condition rather than a theoretical rationale.

| Debug x86_64 input | Clean build A SHA-256 | Clean build B SHA-256 | Result |
|---|---|---|---|
| 6.12.96, stock parallel pahole 1.24 | `81a4fa3996d771ee9f2df5303dd16710e486d1c3f666a314a6b76dc652912d6c` | `fcb6cd3319efd2ee489ed026e37ab2f0e837a49a585ccbdfa255e18154406834` | different |
| 6.12.96, plus only `0003` | `14d2e67d72d98ec6d90e8b2800871b84333b1f6aba89eff783671cf4d95fad80` | `14d2e67d72d98ec6d90e8b2800871b84333b1f6aba89eff783671cf4d95fad80` | identical |
| 6.18.39, stock parallel pahole 1.24 | `87665bec439c4d07977fe6cd02cb9150af4024bb245bcf11308086a312e1a42a` | `c6705bf9be953a5128f17c50c563891e2ac29de180811fb7d971d746400d1256` | different |
| 6.18.39, plus only `0003` | `f8655ec2eb367b1cbd09814d280b906211f2482cc5398f748966112cdb0b7fb0` | `f8655ec2eb367b1cbd09814d280b906211f2482cc5398f748966112cdb0b7fb0` | identical |

Bundle-golden
([testing/bundle-golden.md](../testing/bundle-golden.md)) independently locks the
header bytes so a packer change can't silently alter the format; the cross-host
build (container on macOS vs native/container on Linux) is run in CI per
[testing/strategy.md](../testing/strategy.md).
