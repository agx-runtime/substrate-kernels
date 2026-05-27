#!/usr/bin/env bash
# Fail the build unless CLAUDE.md §10 imports EXACTLY every docs/**/*.md (ADR 0010).
# A new doc is not "done" until its @-import line is added; an @-import with no file
# is equally a failure.
set -euo pipefail
cd "$(dirname "$0")/.."

# The docs that exist on disk.
on_disk="$(find docs -name '*.md' | sort)"

# The docs imported by CLAUDE.md (bare `@docs/...` lines, never fenced — ADR 0010).
imported="$(grep -oE '^@docs/[A-Za-z0-9._/-]+\.md' CLAUDE.md | sed 's/^@//' | sort)"

if [ "$on_disk" != "$imported" ]; then
	echo "doc-manifest drift: CLAUDE.md §10 imports != docs/**/*.md" >&2
	echo "--- only on disk (add an @-import) ---" >&2
	comm -23 <(echo "$on_disk") <(echo "$imported") >&2
	echo "--- only imported (no such file) ---" >&2
	comm -13 <(echo "$on_disk") <(echo "$imported") >&2
	exit 1
fi

echo "check-doc-manifest: $(echo "$on_disk" | wc -l | tr -d ' ') docs, all imported exactly once"
