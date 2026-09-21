#!/usr/bin/env bash
#
# Refresh the GitNexus index, then repair what the refresh breaks.
#
# `gitnexus analyze` rewrites the region between the gitnexus:start and
# gitnexus:end markers in CLAUDE.md and AGENTS.md. Two things go wrong if that
# is left alone, and both actually happened on the first run:
#
#   1. Anything sitting inside the markers is destroyed. The whole "Quality
#      gates" section was inside them and vanished. The fix was to move the
#      start marker below it; the canary at the bottom of this script
#      re-checks that afterwards rather than trusting it.
#
#   2. The generated text uses em-dashes, which this repo's own pre-commit
#      gate blocks, so every refresh left an uncommittable working tree.
#      normalize-generated-docs.py settles that.
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
if ! gn analyze "$@"; then
  echo "gitnexus-refresh: incremental analyze failed, repairing the FTS index." >&2
  gn analyze --repair-fts "$@" || {
    echo "gitnexus-refresh: repair failed, forcing a full re-index." >&2
    gn analyze --force "$@"
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
