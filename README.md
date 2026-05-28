# Substrate Linux Kernel

**Substrate Kernel** is the build system that produces the `.kernel` artifact — the
minimal, virtio-only Linux guest kernel that
[**substrate**](https://github.com/loopholelabs/substrate) (our embedded microVM
monitor) mmaps and boots inside a guest. It pins a Linux source tree, applies a
curated patch series, builds it with a monolithic per-`(arch, variant)` config, and
packs the result into a single self-contained **kernel bundle** (`SUBK`) that
substrate loads with no kernel-image parser of its own.

The binding design of record is [`CLAUDE.md`](CLAUDE.md) and [`docs/`](docs/) — read
those before changing a patch, a config line, or the bundle format.

## What it produces

A flat, little-endian **kernel bundle** named `linux-<version>-<variant>-<arch>.kernel`:
a fixed 96-byte header (`SUBK` magic, format/abi version, arch, variant, page size,
`load_addr`, `entry_addr`, and the kernel/qboot/initrd section ranges) followed by
page-aligned payload sections. substrate reads the header, copies the kernel to
`load_addr`, and enters at `entry_addr` — the x86 path is the 64-bit `boot_params`
entry (`e_entry`); aarch64/riscv64 is the raw `Image` at `0x80000000`. See
[ADR 0003](docs/adr/0003-kernel-bundle-format.md) / [ADR 0004](docs/adr/0004-boot-contract-with-substrate.md).

## Quick start

The Linux build stages run inside a digest-pinned container
([`tools/build/Dockerfile`](tools/build/Dockerfile)). On **macOS** the `Makefile`
runs them in that container automatically (needs Docker); on **Linux** run inside
the same container (CI does this) or natively with the pinned toolchain installed.

```sh
make                      # build the base bundle for the host architecture
make ARCH=aarch64         # build base for aarch64 (cross-compiled)
make ARCH=x86_64          # build base for x86_64
make VARIANT=windows      # the windows (WHP) variant — x86_64, packed at 4 KiB
make install PREFIX=/usr/local   # stage to $(PREFIX)/lib/substrate/kernels/
make clean
```

The first build fetches the pinned tarball over HTTPS and **verifies its sha256
before extraction** (a mismatch fails the build). `JOBS=N` caps compile parallelism
where RAM, not CPU, is the constraint (e.g. `JOBS=4`).

## Architecture × variant matrix

| | x86_64 | aarch64 | riscv64 |
|---|---|---|---|
| **base** | ✅ CI-gated | ✅ CI-gated | ✅ buildable (not CI-gated) |
| **windows** (WHP, Hyper-V) | ✅ buildable (not CI-gated) | — | — |
| **sev / tdx** (TEE) | ⏳ carried; build deferred | — | — |

CI and releases cover **base × {x86_64, aarch64}** — substrate's hosts. riscv64 and
windows are carried for completeness and are buildable + golden-tested but not
boot-gated ([ADR 0002](docs/adr/0002-target-architectures.md)). The
confidential-compute variants (sev/tdx) carry their patches + configs but their
firmware/initrd blobs are not yet wired ([ADR 0009](docs/adr/0009-confidential-compute-variants.md)).

## Verification

Pick the gate for the failure class ([testing/strategy.md](docs/testing/strategy.md)):

```sh
make ci             # fast static gates: doc-manifest, bundle-golden, pack-unit
make applies-clean  # the patch series applies at -p1 with ZERO fuzz / ZERO offset
make configured     # olddefconfig + the config-invariant gate (per arch/variant)
make repro-check    # rebuild from the pin; assert byte-identical bundle
```

Boot validation: the real boot-smoke (booting under substrate) is pending substrate's
loader adopting the `SUBK` format; until then CI boots the produced kernel under
**QEMU** and checks for the kernel banner ([boot-smoke.md](docs/testing/boot-smoke.md)).

## Releases

Release artifacts are the `.kernel` bundles plus a `SHA256SUMS` file, published to
**GitHub Releases** and mirrored to **Cloudflare R2**, served publicly at
`https://kernels.substrate.loopholelabs.io/` and `https://kernels.agx.so/` via the
[`download-proxy/`](download-proxy/) Worker — a thin CF Worker that reads R2 via a
binding and emits one analytics event per full download
([ADR 0011](docs/adr/0011-download-proxy-with-analytics.md)). Same public URLs,
same paths; observability is new.

- **Version** comes from the pin (`scripts/kernel-pin.env`, e.g. `6.12.91`). The
  release tag is `v<version>` (e.g. `v6.12.91`), or `v<version>-r<N>` when
  re-releasing the same kernel after a patch/config change without a pin bump.
- **To cut a release:** bump the pin if needed (and re-validate the series + configs
  + boot), then either push a `v*` tag or run the **Release** workflow manually
  (optionally with a `revision`). The workflow builds `base × {x86_64, aarch64}`,
  writes `SHA256SUMS`, creates the GitHub Release, and uploads to R2.
- **Public URLs** (bucket root): each bundle is served at
  `https://kernels.substrate.loopholelabs.io/linux-<version>-base-<arch>.kernel`,
  with checksums at `…/linux-<version>-SHA256SUMS`. Configure the repo **secret**
  `CLOUDFLARE_API_TOKEN` and the repo **variables** `CLOUDFLARE_ACCOUNT_ID` +
  `R2_BUCKET` (R2 upload is skipped if the token is unset, so the GitHub Release
  still publishes).

Because the build is byte-reproducible (`make repro-check`), a published bundle's
sha256 is a stable content identity you can attest and cache against.

## Repository layout

```
CLAUDE.md                 # the binding constitution (read first)
docs/                     # ADRs + design + testing docs (the design of record)
Makefile                  # the pin→tarball→patch→config→compile→pack pipeline
scripts/
  kernel-pin.env          # KERNEL_VERSION + KERNEL_SHA256 + KERNEL_URL (the pin)
  pack-kernel.py          # the SUBK packer
  config-invariant.py     # required/forbidden CONFIG_* per (arch, variant)
  check-doc-manifest.sh   # CLAUDE.md §10 import-manifest gate
  boot-smoke.sh           # interim QEMU boot check
config-<variant>_<arch>   # the curated per-cell kernel .config files
patches/                  # the ordered base patch series (applied at -p1, zero fuzz)
patches-tee/              # the quarantined TEE series (sev/tdx only)
tools/build/Dockerfile    # the digest-pinned toolchain container
tests/                    # bundle-golden + pack-kernel unit checks
.github/workflows/        # ci.yml (gates) + release.yml (publish)
```
