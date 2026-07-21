# ADR 0001 — Kernel source pin and update lifecycle

- **Status:** Accepted
- **Date:** 2026-05-27
- **Context doc:** [../architecture.md](../architecture.md) §2 (the build pipeline
  this pin roots); [../design/reproducibility.md](../design/reproducibility.md)
  (the verification mechanics)

> First ADR in the repo — it also establishes the `docs/adr/` convention that
> [architecture.md](../architecture.md) §8 calls for. Format: Context → Decision →
> Consequences → Alternatives.

## Context

substrate-kernels builds **a specific upstream Linux release**, not a moving
branch. Everything downstream — the patch series applying clean (CLAUDE.md §6),
the config normalizing the same way, and above all the byte-reproducibility law
(CLAUDE.md §3) — is rooted in *which exact source tree* we build. An unpinned or
loosely-pinned source defeats all of it: "linux 6.12" silently changes under us as
point releases ship, and a build nobody can reproduce is a guest kernel nobody can
attest or debug.

Two further facts shape the choice:

1. The guest kernel wants the stability and long support window of an **LTS line**,
   not a bleeding-edge release; a microVM guest gains nothing from the newest
   mainline features and loses the multi-year security-fix stream.
2. Point releases on an LTS line ship frequently (security + stability fixes). We
   want those fixes, but only via an **explicit, reviewed** bump — never silently.

## Decision

1. **Support two specific point releases on Linux LTS lines.** `6.12` is the
   compatibility/default line and `6.18` is the current line. Each selector maps
   to one exact point release; neither follows a moving branch. Supporting both
   lets consumers migrate deliberately instead of turning an LTS transition into
   a flag day.

2. **Pins live in `scripts/kernel-pins/<line>.env`: a version *and* a sha256.** The
   build fetches the tarball over HTTPS from kernel.org at the pinned tag and
   **verifies it against the checked-in sha256 before extraction.** A hash
   mismatch fails the build; the source is never trusted on the version string
   alone.

3. **A bump is an explicit, reviewed change to one pin.** Bumping `6.12.x` →
   `6.12.y` (or `6.18.x` → `6.18.y`) means: update the version + sha256,
   **re-validate that line's entire patch
   series applies clean at `-p1` with zero fuzz** (CLAUDE.md §6), re-run
   `olddefconfig` and the config-invariant gate, and re-run boot-smoke. A patch
   that no longer applies is **re-derived, never forced** with fuzz.

4. **Selection is explicit.** `KERNEL_LINE=6.12` is the default;
   `KERNEL_LINE=6.18` selects the newer line. Build directories, bundles, and CI
   artifacts include the chosen exact version so both lines coexist without
   overwriting one another. A manual release builds and publishes both selections
   atomically from one exact repository commit.

5. **The pin is the root of every reproducibility claim.** `make repro-check`
   (ADR 0005) is meaningful only because the source is pinned by hash; the two
   ADRs are co-dependent.

## Consequences

- Every build is rooted at an exact, hash-verified tree; reproducibility (ADR
  0005) and clean patch application (ADR 0007) have a stable foundation.
- The guest rides the LTS security-fix stream, but each absorption is a reviewed
  bump that re-validates patches + config + boot — no fix lands unexamined.
- A version bump carries real work (re-validate the series); this is deliberate
  friction that keeps the patch set honest and small (CLAUDE.md §6).
- Per-line patch directories make unavoidable source drift visible: a patch is
  re-derived against each exact tree instead of relying on offset application.
- Keeping 6.12 and 6.18 concurrently gives substrate a tested compatibility
  fallback while consumers qualify the newer LTS.

## Alternatives considered

- **Track a branch (e.g. `linux-6.18.y`) and build tip** — rejected: tip moves, so
  no two builds agree and reproducibility is impossible; security fixes would land
  unreviewed and could break the series silently.
- **Pin only a version string, no hash** — rejected: a version string is not a
  content identity (mirrors can differ, tarballs can be re-rolled); the sha256 is
  what makes the pin a real root of trust.
- **Vendor the kernel source in-tree** — rejected: carries hundreds of megabytes
  of source we don't own, encourages bitrot, and obscures the pin; fetch-by-hash
  pins precisely without carrying the tree.
- **Track latest mainline** — rejected: a microVM guest gains nothing from
  bleeding-edge features and loses the LTS security-fix window; mainline churn
  would break the patch series constantly.
- **Use the bleeding mainline or a non-LTS line** — same rejection; the guest
  kernel's value is stability + a long fix stream, which is exactly LTS.
- **Replace 6.12 immediately with 6.18** — rejected for this transition: keeping
  both exact pins makes compatibility measurable and rollback straightforward.
