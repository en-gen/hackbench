#!/usr/bin/env bash
#
# Refresh the GitNexus index, then repair what the refresh breaks.
#
# `gitnexus analyze` would rewrite the region between the gitnexus:start and
# gitnexus:end markers in CLAUDE.md and AGENTS.md, with live counts that differ
# per worktree and conflict on merge (#644). It is told not to, twice:
# `.gitnexusrc` (skipAgentsMd, read by a bare analyze too) and the
# --skip-agents-md flag on every call below. The normalizer and canary stay as
# a net for a generator that ignores both: it also writes em-dashes, which this
# repo's pre-commit gate blocks, and an old generator once ate the Quality
# gates section when the start marker sat above it.
#
# Run this whenever the index is reported stale.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

gn() {
  if [ -f .gitnexus/run.cjs ]; then
    node .gitnexus/run.cjs "$@"
  else
    npx --yes gitnexus "$@"
  fi
}

# Incremental indexing can leave the full-text index inconsistent, and it then
# fails every subsequent run with "FTS index is inconsistent". Observed once on
# this repo. The tool ships a targeted repair for it, so try that before paying
# for a full re-index.
# --skip-agents-md: the generated region carries live counts, so two worktrees
# analyzing at once wrote different numbers and conflicted on merge (#644).
if ! gn analyze --skip-agents-md "$@"; then
  echo "gitnexus-refresh: incremental analyze failed, repairing the FTS index." >&2
  gn analyze --skip-agents-md --repair-fts "$@" || {
    echo "gitnexus-refresh: repair failed, forcing a full re-index." >&2
    gn analyze --skip-agents-md --force "$@"
  }
fi

python tools/scripts/normalize-generated-docs.py CLAUDE.md AGENTS.md

# The canary. If a future generator version moves the markers back up, this
# catches it on the run that does the damage instead of at review time.
if [ -f CLAUDE.md ] && ! grep -q '^# Quality gates' CLAUDE.md; then
  echo "gitnexus-refresh: CLAUDE.md lost its Quality gates section." >&2
  echo "  The gitnexus:start marker has moved above it again; restore the" >&2
  echo "  section from git and put the marker back below it." >&2
  exit 1
fi

echo "gitnexus-refresh: index rebuilt, generated docs normalised."
