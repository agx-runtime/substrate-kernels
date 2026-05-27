# ADR 0010 — Auto-loaded documentation context (the CLAUDE.md import manifest)

- **Status:** Accepted
- **Date:** 2026-05-27
- **Context doc:** [../../CLAUDE.md](../../CLAUDE.md) §10 (the manifest itself);
  §7 (documentation requirements)

## Context

CLAUDE.md §0 makes acting with full understanding a gate, and §7 makes the `docs/`
tree the build's design of record. For that to hold in practice, an agent reading
the constitution must have the *whole* design in context — not be left to discover
and open docs on demand, which silently drops the ones it doesn't think to read.
substrate solves this with a flat `@`-import manifest in its CLAUDE.md (substrate
ADR 0011), guarded by a script that fails the build if the manifest is not exactly
every doc. substrate-kernel adopts the same mechanism for the same reason.

The Claude Code `@`-import has two relevant properties: imports resolve only to a
bounded depth, and an `@`-path inside a code span or fence is ignored. A naive
"import the README, which links everything" approach therefore drops docs past the
depth cap or behind ordinary Markdown links.

## Decision

1. **CLAUDE.md §10 carries a flat `@`-import manifest of every `docs/**/*.md`.**
   Every doc is imported at depth 1 directly from the constitution — not reached
   transitively through a README — so the depth cap and the
   ignored-in-code-fence rule cannot silently drop one. The human-readable prose
   links throughout the docs stay as ordinary Markdown links beside the manifest.

2. **The manifest must be exactly the set of docs — no more, no less.**
   `scripts/check-doc-manifest.sh` lists `docs/**/*.md`, compares it to the
   `@`-import lines in CLAUDE.md §10, and fails the build on any difference (a doc
   not imported, or an import with no file). A new doc is not done until its line is
   added (CLAUDE.md §10).

3. **The manifest paths are bare `@`-imports, never fenced or backticked.** Because
   an `@`-import inside a code span/fence is ignored, the manifest lines are plain
   text; the check script enforces this shape.

4. **The gate runs in `make ci`** alongside the other build gates (ADR per
   [testing/strategy.md](../testing/strategy.md)), so manifest drift is caught in
   the same place as a failed patch-apply or config-invariant.

## Consequences

- Reading CLAUDE.md loads 100% of the design of record; an agent never operates on
  a partial picture because a doc wasn't linked from the right place.
- Adding a doc has a single, enforced obligation: add its `@`-import line, or the
  build fails — documentation completeness is mechanically guaranteed, not trusted.
- The flat list is slightly verbose (every doc enumerated in §10), accepted as the
  cost of defeating the depth cap and the fenced-import pitfall.

## Alternatives considered

- **Import only the README and rely on its links** — rejected: links are not
  imports (they aren't loaded), and even nested `@`-imports hit the depth cap; docs
  would silently fall out of context.
- **No manifest; open docs on demand** — rejected: it makes "full understanding"
  (CLAUDE.md §0) depend on an agent guessing which docs exist, exactly the failure
  the manifest prevents.
- **A generated manifest (build step rewrites §10)** — rejected as unnecessary
  machinery: a check-and-fail gate is simpler than a generator and keeps CLAUDE.md
  hand-authored and reviewable; the gate gives the same guarantee.
