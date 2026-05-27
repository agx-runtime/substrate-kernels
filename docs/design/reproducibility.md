# Design: reproducibility

The mechanics that make a `.kernel` byte-identical across builds and hosts, and the
gate that proves it. This realizes CLAUDE.md §3 and
[ADR 0005](../adr/0005-build-environment-and-reproducibility.md); it depends on the
source pin ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)).

## Background

We fix `KBUILD_BUILD_TIMESTAMP`/`_USER`/`_HOST` to constants and (on
macOS) builds inside a Linux VM so the kernel is built on Linux regardless of host.
It does not pin the toolchain by digest or assert byte-identity; we add both, after
substrate's UAPI-reproducibility model (substrate ADR 0010).

## Subtle details & gotchas

| Detail | Convention | Our handling | Gate |
|---|---|---|---|
| **Toolchain drift changes the image** — gcc/clang/binutils version affects codegen | builds on whatever the VM has | pin the toolchain in a **digest-pinned container** (`tools/build/Dockerfile`); same image on macOS and CI ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)) | `make repro-check` (cross-host byte-identity) |
| **Build metadata leaks wall-clock/host** | fixes `KBUILD_BUILD_*` | same constants + config-disabled embedded build IDs/timestamps ([kernel-config.md](kernel-config.md)) | `make repro-check` |
| **Source identity ≠ version string** | fetches by version | fetch by tag, **verify sha256** ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)) | the sha256 check |
| **Packer non-determinism** — dict/iteration order, padding bytes | (flat packer) | the packer pads with explicit zero bytes and emits fields in fixed order ([bundle-format.md](bundle-format.md)); no host-dependent input | bundle-golden |
| **Parallel-build nondeterminism** — `make -jN` ordering affecting output | (n/a stated) | rely on kbuild's reproducible-build support; if any `-j` nondeterminism appears, it is root-caused, not tolerated (CLAUDE.md §9) | `make repro-check` |
| **"Functionally equivalent" is unfalsifiable** for a kernel image | (no byte check) | assert **byte-identity** against a committed digest — the only check that proves reproducibility (CLAUDE.md §3) | `make repro-check` |

## Our design

The reproducibility surface is four pinned inputs and one gate:

1. **Pinned source** — version + sha256 in `scripts/kernel-pin.env`, verified
   before extract ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)).
2. **Pinned toolchain** — `tools/build/Dockerfile` at a checked-in digest;
   the same container builds on a macOS dev host and on Linux CI
   ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)).
3. **Pinned config + patches** — the per-cell `.config`
   ([kernel-config.md](kernel-config.md)) and the ordered series
   ([patches.md](patches.md)) are checked in and applied deterministically.
4. **Fixed build metadata** — `KBUILD_BUILD_TIMESTAMP`/`_USER`/`_HOST` constants
   plus config-disabled embedded IDs/timestamps.

**`make repro-check`** rebuilds from these inputs in the pinned container and
asserts the produced bundle matches a committed digest; divergence fails the build.
Because the source is hash-pinned and the toolchain digest-pinned, a macOS
developer and a Linux runner must produce the same bytes — the cross-host case is
the sharpest test of the law. A toolchain bump (new container digest) is an
explicit change that re-establishes the digest, exactly like a source-pin bump.

## Verification

`make repro-check` is the gate (committed-digest byte-identity); bundle-golden
([testing/bundle-golden.md](../testing/bundle-golden.md)) independently locks the
header bytes so a packer change can't silently alter the format; the cross-host
build (container on macOS vs native/container on Linux) is run in CI per
[testing/strategy.md](../testing/strategy.md).
