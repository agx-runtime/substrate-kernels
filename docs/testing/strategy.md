# Verification strategy

The test-driven plan for the build: every gate, the failure class it catches, the
component it guards, and where it runs. This ties the gates ([README.md](README.md))
to the pipeline ([architecture.md](../architecture.md) §2) and the build-order
roadmap (§7). The governing law is [CLAUDE.md](../../CLAUDE.md) §3 (reproducibility)
and §8 (verification).

## The gates, by pipeline stage

| Stage (architecture.md §2) | Gate | Catches | Where |
|---|---|---|---|
| ① pin → tarball | **sha256 check** | a tampered/wrong-version tarball | every build (pre-extract) |
| ② → ③ patch | **applies-clean** | a patch fuzzed/rejected against the pin | every build and every `nix flake check`; the full series re-validated on a version bump |
| ③ → ④ configure | **config-invariant** | `olddefconfig` dropping a required option / admitting a forbidden one | every build, per (arch, variant); also the `configured` flake check, without a compile |
| ⑤ compile | **fixed-metadata** | wall-clock/host leakage | folded into repro-check |
| ⑥ pack | **bundle-golden** | header-layout / alignment drift | every `nix flake check` (per PR) |
| whole build | **`just repro-check`** | non-byte-identical rebuild (toolchain/source/metadata drift) | CI on main + manual dispatch; re-run on a toolchain/pin bump |
| artifact | **boot-smoke** | a kernel that builds but doesn't boot/run under substrate | per PR (QEMU on every CI-gated cell); the substrate loader lane cross-repo |
| artifact | **budgets** | image-size / boot-time regression | review signal (per PR), trend (periodic) |

## Per-component verification

- **Source pin** ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)) —
  the sha256 check is the gate; the pin-drift lane surfaces newer point releases
  for opt-in. *How:* the fixed-output fetch verifies the tarball against the sha256
  in the selected `scripts/kernel-pins/<line>.env` (parsed by `nix/pins.nix`).
  *Why:* the
  root of reproducibility. *What if it fails:* hard stop before extract.
- **Patch series** ([patches.md](../design/patches.md),
  [ADR 0007](../adr/0007-patch-management-policy.md)) — applies-clean. *How:* apply
  `patches/<line>/` at `-p1`, fail on any fuzz or offset.
  *Why:* fuzz means a possibly-misplaced hunk → a subtly wrong guest. *What if it
  fails:* re-derive the patch, never force.
- **Kernel config** ([kernel-config.md](../design/kernel-config.md),
  [ADR 0006](../adr/0006-kernel-config-strategy.md)) — config-invariant. *How:* after
  `olddefconfig`, assert a required-present set and a forbidden-absent set per
  (line, arch, variant), including exact `NR_CPUS` and the forbidden unsupported
  devices/TEE surface. *Why:* `olddefconfig`
  silently resolves changed deps. *What if it fails:* the config or a dependency
  changed — fix the config, don't relax the gate.
- **Packer / bundle** ([bundle-format.md](../design/bundle-format.md),
  [ADR 0003](../adr/0003-kernel-bundle-format.md)) — bundle-golden
  ([bundle-golden.md](bundle-golden.md)) + the packer's own layout self-asserts.
  *How:* golden bytes of the header from known inputs + invariant checks (offsets %
  64 KiB, non-overlap, `header_size == 96`). *Why:* the producer↔consumer contract.
  *What if it fails:* a format change must bump `format_version` and update both
  sides + the golden.
- **Reproducibility** ([reproducibility.md](../design/reproducibility.md),
  [ADR 0005](../adr/0005-build-environment-and-reproducibility.md)) — `just
  repro-check`. *How:* `nix build` realizes the cell (by substitution when the org
  cache holds it), then `nix build --rebuild` compiles it locally and fails if a
  single byte differs — so on a substituted path the gate also proves the cache
  serves what this commit's source builds. *Why:* CLAUDE.md
  §3. *What if
  it fails:* a toolchain/source/metadata input drifted — root-cause it.
- **Boot contract / runtime** ([ADR 0004](../adr/0004-boot-contract-with-substrate.md))
  — boot-smoke ([boot-smoke.md](boot-smoke.md)). *How:* substrate loads each bundle
  on real KVM hosts (AMD and Intel x86 plus Arm), checks ACPI/FDT device probe,
  records the declined experimental DGRAM bit, performs a 128 KiB stream-vsock
  transfer, reaches userspace, validates exact workload status and clean supervisor
  shutdown, and reads the PL031 clock on arm64. *Why:* a compile
  cannot prove that a behavioral patch or VMM contract works. *What if it fails:*
  read the guest console and device observations and root-cause it.

## Budgets (review signals, not hard gates)

- **Image size** — the bundle is injected into guest RAM; track the kernel-section
  size per (arch, variant). A jump at a version bump or a new `CONFIG_*` is
  surfaced for review (architecture.md §6).
- **Boot-to-userspace time** — measured in boot-smoke; the no-modules/virtio-only
  config and the `init.substrate` supervisor serve it. A regression is a review
  signal.

## Platform matrix

- **The input and artifact gates** (sha256, applies-clean, config-invariant,
  bundle-golden, repro-check) run as Nix derivations, so any machine with Nix runs
  the same gate the same way. `nix flake check` (the `just ci` verb) runs the
  static gates and applies-clean on every system, macOS included; each configured
  gate, each compile, and repro-check run on the cell's one canonical Linux build
  system ([ADR 0017](../adr/0017-nix-build-and-flake-interface.md)). On a macOS
  host the nix-darwin linux-builder VM compiles on a cache miss, and the org
  binary cache supplies the cell otherwise.
- **boot-smoke** needs a real hypervisor: the release gate uses KVM on AMD and
  Intel x86_64 and on aarch64; HVF remains a substrate compatibility lane. It
  uses substrate as the loader and consumes the produced
  `.kernel`. CI's per-PR boot-smoke job is the interim stand-in: it boots each
  built cell's raw `kernel-binary` under QEMU installed from apt on the runner —
  harness tooling, never an input to the artifact — and `scripts/boot-smoke.sh`
  records what that lane does and does not prove. Fixtures for the substrate lane
  (a substrate build + a rootfs disk/initramfs) are staged, not
  rebuilt per run; a missing fixture is a `panic!` naming the command that stages
  it, never a skip (CLAUDE.md §9).

## No silent skips, no flakes

A missing pin/toolchain/fixture is a hard failure with a remediation hint. A
boot-smoke that fails under load but passes alone is a bug to root-cause (a shared
fixture, a hardcoded timeout), not a flake to retry. No `#[ignore]`-equivalent, no
retry loops (CLAUDE.md §9).
