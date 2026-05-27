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

substrate-kernel builds **a specific upstream Linux release**, not a moving
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

1. **Pin to a specific point release on a Linux LTS line.** The base is the **6.12
   LTS** line; the pin is a specific `6.12.x` tag. The choice of line is itself a
   reviewed decision revisited only when the line approaches end-of-life.

2. **The pin lives in `scripts/kernel-pin.env`: a version *and* a sha256.** The
   build fetches the tarball over HTTPS from kernel.org at the pinned tag and
   **verifies it against the checked-in sha256 before extraction.** A hash
   mismatch fails the build; the source is never trusted on the version string
   alone.

3. **A bump is an explicit, reviewed change to the pin.** Bumping `6.12.x` →
   `6.12.y` means: update the version + sha256, **re-validate the entire patch
   series applies clean at `-p1` with zero fuzz** (CLAUDE.md §6), re-run
   `olddefconfig` and the config-invariant gate, and re-run boot-smoke. A patch
   that no longer applies is **re-derived, never forced** with fuzz.

4. **A drift lane surfaces the newest point release for opt-in, never adopts it.**
   `make pin-drift` reports the newest stable `6.12.x` and whether the series still
   applies against it, so a bump is a visible decision (like substrate's
   `make uapi-drift`) — not silent staleness and not silent adoption.

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
- Pinning by line (6.12) rather than by a single frozen tag forever means we have
  a defined, low-risk path to absorb security fixes without a major rebase.

## Alternatives considered

- **Track a branch (e.g. `linux-6.12.y`) and build tip** — rejected: tip moves, so
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
