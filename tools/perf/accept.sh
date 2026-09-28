#!/usr/bin/env bash
# Accepts an intended perf cost (design section 5, "Accepting an intended
# cost"): posts a perf-nightly success status on <sha>, making it the new
# base so the nightly workflow stops flagging it. Owner-only; the fixing
# agent may propose this on the issue but never run it (docs/testing.md).
#
#   tools/perf/accept.sh <sha> "<reason>"
set -euo pipefail

REPO=en-gen/hackbench
CONTEXT=perf-nightly

sha=${1:-}
reason=${2:-}
[ -n "$sha" ] && [ -n "$reason" ] || {
  echo "usage: $0 <sha> \"<reason>\"" >&2
  echo "refuses to accept a perf cost without a stated reason" >&2
  exit 2
}

gh api "repos/$REPO/statuses/$sha" \
  -f state=success \
  -f context="$CONTEXT" \
  -f description="$reason" \
  >/dev/null

echo "posted $CONTEXT success on $sha: $reason"
