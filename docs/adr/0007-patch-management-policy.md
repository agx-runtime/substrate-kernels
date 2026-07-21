# ADR 0007 — Patch-management policy

- **Status:** Accepted
- **Date:** 2026-05-27
- **Context doc:** [../design/patches.md](../design/patches.md) (the carried series
  + keep/drop rationale); CLAUDE.md §6 (patch discipline)

## Context

substrate-kernels needs three source changes the kernel `.config` cannot express:
an x86 ACPICA/`CONFIG_PCI=n` fix, one virtio-fs bug fix, and reproducible BTF
generation ([design/patches.md](../design/patches.md)). The
old reference accumulated more than 30 base and TEE patches, most without a live
substrate consumer. We must decide **how** the surviving changes are
managed — because a patch series is simultaneously the highest-leverage and
highest-risk surface in the repo (CLAUDE.md §6): a bad patch is a guest that
miscomputes, a boot that hangs, or a host-inherited security regression — and
because every patch is a standing cost re-validated at each version bump (ADR
0001).

## Decision

1. **An ordered patch series against the pin, not a fork.** We check in
   `patches/<line>/NNNN-title.patch` (a numbered, ordered series per exact LTS
   tree) and the pins (ADR 0001),
   never a forked kernel tree. The build reconstructs the patched tree as
   `pin + series`; the series is the source of truth, the tree is derived.

2. **The series applies at `-p1` with zero fuzz and zero offset.** A fuzzed or
   rejected hunk means the patch and the pinned tree have drifted; the patch is
   **re-derived**, never forced. The applies-clean check is a build gate
   ([testing/strategy.md](../testing/strategy.md)).

3. **Every patch carries a why-header** (CLAUDE.md §5/§6): a one-line intent, the
   upstream provenance (the mainline commit it backports, or "original" with the
   contract it satisfies), and the spec / boot-protocol / substrate-feature
   citation. A patch whose header cannot state a contract is a patch to drop (§0).

4. **One patch, one purpose.** A patch has a single stateable change; an "and" in
   the title is two patches. This keeps review, rebase, and the keep/drop decision
   per-patch (CLAUDE.md §5).

5. **Prefer config over patch, and backport over original.** A capability a
   `CONFIG_*` can enable is configured (ADR 0006), not patched. A change available
   upstream is backported with its commit cited, not hand-written. Original patches
   — the largest maintenance cost — are minimized and written to be upstreamable in
   spirit.

6. **Substrate-native titles and provenance, re-derived not pasted** (CLAUDE.md
   §1). Patch titles are substrate-native; a backport cites its mainline
   commit; an original change is re-derived against our tree with a substrate-native
   title. Carrying a patch verbatim with a foreign-project title is a bug.

7. **A version bump re-validates that line's whole series** (ADR 0001). Bumping a pin
   re-applies every patch at `-p1`; any that no longer applies clean is re-derived.
   The series is kept small precisely so this cost stays bounded.

8. **No aspirational patch sets.** A deferred device or machine model does not
   justify carrying guest-kernel deltas. The old TEE series was removed with its
   unwired variants; it can return only with a substrate machine model and tests.

## Consequences

- The kernel "fork" is a small, legible, ordered set of justified deltas, not an
  opaque tree; a reviewer can read the whole guest-kernel divergence in one
  directory.
- Clean-apply-or-re-derive makes drift a visible failure, never a silently
  mis-applied hunk that ships a subtly wrong guest.
- Config-over-patch and backport-over-original keep the original-patch count — the
  real maintenance cost — minimal, so version bumps stay cheap.
- The keep/drop rationale per patch ([design/patches.md](../design/patches.md))
  means a patch with no live justification gets dropped, not carried by inertia.
- Version-specific directories preserve the zero-offset rule across two LTS
  trees; sharing a patch merely because the semantic change is shared is not
  allowed when its source context differs.

## Alternatives considered

- **Maintain a forked kernel git tree** — rejected: opaque (the divergence is a
  branch diff, not a readable series), hard to rebase across LTS point releases,
  and easy to accumulate unjustified changes; an ordered patch series is auditable
  and forces per-patch justification.
- **Allow fuzz on apply ("it still mostly applies")** — rejected: fuzz means the
  patch context no longer matches the tree, so the change may land in the wrong
  place; re-derive instead (CLAUDE.md §6, §9).
- **Carry patches verbatim with their original upstream titles** — rejected: violates CLAUDE.md §1
  (substrate-native naming, re-derive don't paste) and would carry GPU/CAN/etc. patches
  with no substrate consumer; we carry only justified deltas
  ([design/patches.md](../design/patches.md)).
- **Squash the series into one big patch** — rejected: destroys per-patch purpose,
  review, provenance, and the ability to drop one change without unpicking the
  rest (Decision §4).
