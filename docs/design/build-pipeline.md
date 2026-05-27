# Design: the build pipeline (pin → bundle)

The six-stage Makefile pipeline that turns a pinned Linux release into a
`.kernel` bundle ([architecture.md](../architecture.md) §2). Each stage is a target
with explicit inputs/outputs; the whole runs in the pinned container on macOS and
natively on Linux ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)).

## Background

The build pipeline (download → `tar` → `patch -p1` loop → copy
`.config` → `make olddefconfig` → `make` → packer), its build-metadata flags
(`KBUILD_BUILD_TIMESTAMP`/`_USER`/`_HOST`), its arch dispatch
(`x86_64`→`vmlinux`, `aarch64`→`arch/arm64/boot/Image`), and its on-macOS
delegation to a Linux VM builder.

## Subtle details & gotchas

| Detail | Convention | Our handling | Gate |
|---|---|---|---|
| **Source must be hash-verified, not version-trusted** — a version string is not a content identity | fetches by version only | fetch at the pinned tag, **verify sha256 before extract** ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)) | the sha256 check fails the build on mismatch |
| **Patches must apply with zero fuzz** — fuzz means context drift and a possibly-misplaced hunk | `patch -p1` in a shell loop (tolerates fuzz) | apply at `-p1`; **any fuzz/reject fails the build**, re-derive don't force ([ADR 0007](../adr/0007-patch-management-policy.md)) | the applies-clean gate |
| **`olddefconfig` can silently drop a required option** when a dependency changed across a version bump | runs `olddefconfig`, no post-check | run `olddefconfig`, then **assert required `CONFIG_*` present / forbidden absent** ([ADR 0006](../adr/0006-kernel-config-strategy.md)) | the config-invariant gate |
| **Build metadata leaks wall-clock/host into the image** | fixes `KBUILD_BUILD_*` to constants | same: fixed constants + config-disabled build IDs ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)) | `make repro-check` |
| **Per-arch kernel binary differs** — ELF (x86) vs raw Image (arm64) | dispatches on arch | explicit arch cases; the packer flattens ELF, takes Image raw ([ADR 0004](../adr/0004-boot-contract-with-substrate.md)) | bundle-golden + boot-smoke |
| **Building a Linux kernel on a macOS host** | delegates to a Linux microVM builder | run the Linux stages in the **pinned container** ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)); native on Linux | `make repro-check` (macOS vs Linux byte-identity) |
| **A clean build must be reconstructible from `pin + patches`** — no forked tree checked in | extracts into a working dir | the working tree is derived and `.gitignore`d; only the pin + series + configs are tracked ([ADR 0007](../adr/0007-patch-management-policy.md)) | repo has no kernel source tree |

## Our design

The Makefile targets, in dependency order (names indicative; the canonical roadmap
is [architecture.md](../architecture.md) §7):

- **`tarball`** — fetch `linux-<version>.tar.xz` from the pin, verify sha256.
- **`source`** — extract into a derived (ignored) working tree.
- **`patched`** — apply `patches/NNNN-*.patch` at `-p1` (zero fuzz); for sev/tdx
  also apply `patches-tee/` ([ADR 0009](../adr/0009-confidential-compute-variants.md)).
- **`configured`** — copy `config-<variant>_<arch>` → `.config`; `make olddefconfig`;
  run the config-invariant gate.
- **`compiled`** — `make` with fixed `KBUILD_BUILD_*`; output `vmlinux` (x86_64) or
  `arch/arm64/boot/Image` (aarch64).
- **`bundle`** — `pack-kernel` flattens + headers + 64 KiB-aligns into
  `<version>-<variant>-<arch>.kernel` ([bundle-format.md](bundle-format.md)).

Cross-cutting:

- **`install`** — stage the bundle to `$(PREFIX)/lib/substrate/kernels/`
  (substrate-native path).
- **Variant + arch selection** — `VARIANT` ∈ {base, sev, tdx}, `ARCH` ∈ {x86_64,
  aarch64}; sev/tdx are x86-only ([ADR 0002](../adr/0002-target-architectures.md),
  [ADR 0009](../adr/0009-confidential-compute-variants.md)).
- **Container vs native** — on macOS, the Linux stages run in
  `tools/build/Dockerfile`; on Linux, natively against the same pinned toolchain
  ([reproducibility.md](reproducibility.md)).

## Verification

The applies-clean gate (patches), the config-invariant gate (config), bundle-golden
(packer output, [bundle-format.md](bundle-format.md),
[testing/bundle-golden.md](../testing/bundle-golden.md)), `make repro-check`
(byte-identity, [reproducibility.md](reproducibility.md)), and boot-smoke (a real
guest boots under substrate, [testing/boot-smoke.md](../testing/boot-smoke.md)).
The full plan is [testing/strategy.md](../testing/strategy.md).
