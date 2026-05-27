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
| ② → ③ patch | **applies-clean** | a patch fuzzed/rejected against the pin | every build; full series on a version bump |
| ③ → ④ configure | **config-invariant** | `olddefconfig` dropping a required option / admitting a forbidden one | every build, per (arch, variant) |
| ⑤ compile | **fixed-metadata** | wall-clock/host leakage | folded into repro-check |
| ⑥ pack | **bundle-golden** | header-layout / alignment drift | on packer or format change |
| whole build | **`make repro-check`** | non-byte-identical rebuild (toolchain/source/metadata drift) | periodic + on toolchain/pin bump |
| artifact | **boot-smoke** | a kernel that builds but doesn't boot/run under substrate | per PR (changed cells); full matrix periodic |
| artifact | **budgets** | image-size / boot-time regression | review signal (per PR), trend (periodic) |

## Per-component verification

- **Source pin** ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)) —
  the sha256 check is the gate; the pin-drift lane surfaces newer point releases
  for opt-in. *How:* fetch, hash, compare to `scripts/kernel-pin.env`. *Why:* the
  root of reproducibility. *What if it fails:* hard stop before extract.
- **Patch series** ([patches.md](../design/patches.md),
  [ADR 0007](../adr/0007-patch-management-policy.md)) — applies-clean. *How:* apply
  `patches/` (and `patches-tee/` for sev/tdx) at `-p1`, fail on any fuzz/offset.
  *Why:* fuzz means a possibly-misplaced hunk → a subtly wrong guest. *What if it
  fails:* re-derive the patch, never force.
- **Kernel config** ([kernel-config.md](../design/kernel-config.md),
  [ADR 0006](../adr/0006-kernel-config-strategy.md)) — config-invariant. *How:* after
  `olddefconfig`, assert a required-present set and a forbidden-absent set per
  (arch, variant), including the exact `NR_CPUS` and "base forbids TEE"
  ([ADR 0009](../adr/0009-confidential-compute-variants.md)). *Why:* `olddefconfig`
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
  [ADR 0005](../adr/0005-build-environment-and-reproducibility.md)) — `make
  repro-check`. *How:* rebuild in the pinned container, compare to a committed
  digest; run cross-host (macOS container vs Linux). *Why:* CLAUDE.md §3. *What if
  it fails:* a toolchain/source/metadata input drifted — root-cause it.
- **Boot contract / runtime** ([ADR 0004](../adr/0004-boot-contract-with-substrate.md))
  — boot-smoke ([boot-smoke.md](boot-smoke.md)). *How:* substrate loads the bundle
  and boots a guest on KVM + HVF. *Why:* the only proof the addresses, config, and
  patches actually run. *What if it fails:* the boot contract, the config, or a
  patch is wrong — read the guest console, root-cause.

## Budgets (review signals, not hard gates)

- **Image size** — the bundle is injected into guest RAM; track the kernel-section
  size per (arch, variant). A jump at a version bump or a new `CONFIG_*` is
  surfaced for review (architecture.md §6).
- **Boot-to-userspace time** — measured in boot-smoke; the no-modules/virtio-only
  config and orderly-init patches serve it. A regression is a review signal.

## Platform matrix

- **Input + artifact gates** (sha256, applies-clean, config-invariant,
  bundle-golden, repro-check) are **host-independent** — they run in the pinned
  Linux container on any dev host or CI runner.
- **boot-smoke** needs a real hypervisor: KVM (Linux, x86_64 + aarch64) and HVF
  (macOS, aarch64). It uses substrate as the loader and consumes the produced
  `.kernel`. Fixtures (a substrate build + a rootfs disk/initramfs) are staged, not
  rebuilt per run; a missing fixture is a `panic!("[fixture] … — run make …")`,
  never a skip (CLAUDE.md §9).

## No silent skips, no flakes

A missing pin/toolchain/fixture is a hard failure with a remediation hint. A
boot-smoke that fails under load but passes alone is a bug to root-cause (a shared
fixture, a hardcoded timeout), not a flake to retry. No `#[ignore]`-equivalent, no
retry loops (CLAUDE.md §9).
