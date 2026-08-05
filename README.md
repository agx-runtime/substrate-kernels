# Substrate Linux Kernels

**Substrate Kernels** is the build system that produces the `.kernel` artifact — the
minimal, virtio-only Linux guest kernel that
[**substrate**](https://github.com/agx-runtime/substrate) (our embedded microVM
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
entry (`e_entry`); aarch64 is the raw `Image` at the consumer's DRAM base
(`0x40000000` + the Image header's `text_offset`); riscv64 is the raw `Image` at
`0x80000000`. See
[ADR 0003](docs/adr/0003-kernel-bundle-format.md) / [ADR 0004](docs/adr/0004-boot-contract-with-substrate.md).

## Quick start

Host prerequisites are [Determinate Nix](https://install.determinate.systems) and `direnv`;
everything else — just, python, the kernel toolchain — comes from the flake
([ADR 0017](docs/adr/0017-nix-build-and-flake-interface.md)). Every build is a Nix
derivation, so a machine that has authenticated to the org binary cache downloads what CI
already built instead of compiling it. Authenticating is a one-time, host-level step run
from a cachet checkout — `just cache-login` there configures the nix daemon for every
project on the machine — so this repository ships no cache-login of its own.

```sh
git clone … && cd substrate-kernels && direnv allow
just build                # the base bundle for this machine's architecture → ./result
just line=6.18 build      # build 6.18.39 (default: compatibility line 6.12.96)
just build base x86_64    # any cell: just build <variant> <arch>
just build windows x86_64 # the windows (WHP) variant — x86_64, packed at 4 KiB
just install              # stage result/*.kernel to /usr/local/lib/substrate/kernels/
```

On a cache miss the kernel compiles: natively on a Linux machine, and inside the
nix-darwin `linux-builder` VM on macOS — enable it once with
`nix.linux-builder.enable = true;` in your nix-darwin configuration. A macOS machine that
only consumes bundles needs no builder at all, because substitution happens on the host
before any build is scheduled.

The pinned tarball is fetched as a fixed-output derivation, so Nix itself verifies the
checked-in sha256 before a byte of it is used (a mismatch fails the build).

## Kernel lines and architecture × variant matrix

Two exact, hash-verified LTS pins are supported side by side:

| `KERNEL_LINE` | Exact pin | Role |
|---|---|---|
| `6.12` | `6.12.96` | default compatibility line |
| `6.18` | `6.18.39` | current LTS line |

| | x86_64 | aarch64 | riscv64 |
|---|---|---|---|
| **base** | ✅ CI-gated | ✅ CI-gated | ✅ buildable (not CI-gated) |
| **windows** (WHP, Hyper-V) | ✅ buildable (not CI-gated) | — | — |

CI covers **both lines × {base, debug} × {x86_64, aarch64}** — substrate's hosts.
riscv64 and windows are carried for completeness but are not boot-gated
([ADR 0002](docs/adr/0002-target-architectures.md)). The old deferred SEV/TDX
variants were removed because substrate has no confidential-compute machine model
and the bundles never had the required firmware/initrd wiring.

## Verification

Pick the gate for the failure class ([testing/strategy.md](docs/testing/strategy.md)):

```sh
just ci                        # every gate for this system: nix flake check
just line=6.18 applies-clean   # the series applies with zero fuzz and zero offset
just line=6.18 configured      # olddefconfig + config invariants, no compile
just line=6.18 repro-check     # byte-identical rebuild of the selected cell
```

Release validation boots the produced `SUBK` bundles under **substrate** on real
KVM hosts. x86_64 is exercised on AMD and Intel; aarch64 is exercised on Arm.
The behavioral gates include clean `init.substrate` shutdown, virtio-vsock stream
transfers with the experimental DGRAM offer safely declined, DAX-less virtio-fs,
and PL031 timekeeping on arm64 ([boot-smoke.md](docs/testing/boot-smoke.md)).

## Releases

Release artifacts are the `.kernel` bundles plus a `SHA256SUMS` file, published to
**GitHub Releases** and mirrored to **Cloudflare R2**, served publicly at
`https://kernels.substrate.so/` and `https://kernels.agx.so/` via the
[`download-proxy/`](download-proxy/) Worker — a thin CF Worker that reads R2 via a
binding and emits one analytics event per full download
([ADR 0011](docs/adr/0011-download-proxy-with-analytics.md)). Same public URLs,
same paths; observability is new.

- **Release identity** is the exact substrate-kernels repository commit, not either
  upstream kernel version. The workflow creates the required implementation tag
  `build-<12-char-commit>`; artifact names retain their upstream versions from
  `scripts/kernel-pins/<line>.env`.
- **To cut a release:** land and validate the change, open **Actions → Release →
  Run workflow**, and paste the full 40-character commit SHA. There is no tag-push
  trigger. Every job checks out that exact commit, then the workflow builds both
  LTS lines as one all-or-nothing release: `{6.12, 6.18} × {base, debug} ×
  {x86_64, aarch64}` (eight bundles). It writes combined and per-version checksum
  manifests, records the pins in `RELEASE-MANIFEST.json`, attests build provenance
  ([ADR 0016](docs/adr/0016-release-provenance-attestation.md)), creates the GitHub
  Release, and uploads both lines to R2.
- **Public URLs** (bucket root): each bundle is served at
  `https://kernels.substrate.so/linux-<version>-base-<arch>.kernel`,
  with checksums at `…/linux-<version>-SHA256SUMS`. Configure the repo **secrets**
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` and the repo **variable**
  `R2_BUCKET` (R2 upload is skipped if the token is unset, so the GitHub Release
  still publishes).
- **Provenance:** every artifact carries a SLSA build-provenance attestation
  (keyless sigstore via GitHub OIDC — no signing keys). Verify any downloaded
  bundle, wherever it came from, with:

  ```sh
  gh attestation verify linux-<version>-<variant>-<arch>.kernel \
      --repo agx-runtime/substrate-kernels
  ```

  The combined sigstore bundle ships as a commit-scoped GitHub release asset and
  is mirrored to each line's version-scoped R2 object
  (`linux-<version>-attestations.sigstore.jsonl`).

Because the build is byte-reproducible (`make repro-check`), a published bundle's
sha256 is a stable content identity you can attest and cache against.

## Repository layout

```
CLAUDE.md                 # the binding constitution (read first)
docs/                     # ADRs + design + testing docs (the design of record)
flake.nix                 # every pipeline output: bundles, gates, the dev shell
flake.lock                # the toolchain pin (ADR 0005)
nix/
  kernel.nix              # the bundle, applies-clean, and configured derivations
  pins.nix                # parser for the kernel-pins .env files
Justfile                  # the verbs — thin aliases over flake outputs
scripts/
  kernel-pins/            # exact version/hash/URL pin for each supported LTS line
  pack-kernel.py          # the SUBK packer
  config-invariant.py     # required/forbidden CONFIG_* per (arch, variant)
  check-doc-manifest.sh   # CLAUDE.md §10 import-manifest gate
  boot-smoke.sh           # interim QEMU boot check
config-<variant>_<arch>   # the curated per-cell kernel .config files
patches/<line>/           # independently re-derived zero-offset series per LTS line
tests/                    # bundle-golden + pack-kernel unit checks
.github/workflows/        # ci.yml (gates + cache push) + release.yml (publish)
```
