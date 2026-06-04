# Verification toolkit

How substrate-kernels proves a build is correct. A kernel *build* fails differently
from a Rust library — there are no unit tests of pure functions to run — so the
gates are build-shaped: they check that the inputs assemble correctly and that the
output actually boots. But the philosophy is substrate's (CLAUDE.md §3, §8):
deterministic, no silent skips, root-cause over retry.

**Start here:**
- [`strategy.md`](strategy.md) — the verification plan: every gate, what failure
  class it catches, and where it runs. The doc that ties these to the pipeline.
- [`../architecture.md`](../architecture.md) — the build pipeline and components the
  gates map onto.

## Pick the gate by the failure class

| The question | Gate | One line |
|---|---|---|
| Does the patch series still apply to the pin? | **applies-clean** | `patch -p1` with zero fuzz; a fuzzed/rejected hunk fails the build ([patches.md](../design/patches.md)) |
| Did `olddefconfig` drop a required option (or admit a forbidden one)? | **config-invariant** | assert required-present / forbidden-absent per (arch, variant) ([kernel-config.md](../design/kernel-config.md)) |
| Did the bundle header layout drift? | **bundle-golden** | golden bytes of the header + the alignment/offset invariants ([bundle-golden.md](bundle-golden.md)) |
| Is the build byte-reproducible across hosts? | **`make repro-check`** | rebuild from the pin in the pinned container; assert byte-identity ([reproducibility.md](../design/reproducibility.md)) |
| Does a real guest actually boot from the bundle? | **boot-smoke** | a guest boots under substrate on KVM + HVF, reaches userspace, drives the wired devices ([boot-smoke.md](boot-smoke.md)) |
| Did the image grow / boot slow down? | **budgets** | image size + boot-to-userspace tracked as review signals ([strategy.md](strategy.md)) |

## How they layer

- **The input gates** (applies-clean, config-invariant) prove the build's *inputs*
  assemble as intended — caught at build time, not at guest boot.
- **The artifact gates** (bundle-golden, repro-check) prove the *output* has the
  right shape and is reproducible — the producer↔consumer contract (ADR 0003) and
  the determinism law (CLAUDE.md §3).
- **The irreducible remainder** (boot-smoke) proves what no static check can: that
  the patched, configured, packed kernel *runs* under the real hypervisor. It is
  the boundary-tier complement to the input/artifact gates, and it lands with
  substrate's KVM backend ([architecture.md](../architecture.md) §7).
- **Budgets** track size/boot-time trends as review signals, not hard failures
  (architecture.md §6).

## Cadence

- **Per change:** the gates for what you touched — applies-clean + config-invariant
  on a patch/config change; bundle-golden on a packer change.
- **Per PR:** the full input + artifact gates and boot-smoke on the changed cells.
- **Periodic / out of band:** the full (arch, variant) matrix, `make repro-check`
  cross-host, the pin-drift lane ([ADR 0001](../adr/0001-kernel-source-pin-and-update-lifecycle.md)),
  and the budget trend.

Always run via `make`/CI with `tee`, read the log, and treat a retry as a flake
*signal* to root-cause — never a crutch (CLAUDE.md §9). **Tests panic on missing
resources** (a missing pin, toolchain image, or substrate fixture is a hard failure
with a remediation hint, never a `[skip]`).
