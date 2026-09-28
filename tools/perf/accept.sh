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
# GitHub truncates a commit status description past this length; refusing
# up front avoids silently posting a cut-off reason.
MAX_DESCRIPTION=140

sha=${1:-}
reason=${2:-}

[ -n "$sha" ] && [ -n "$reason" ] || {
  echo "usage: $0 <sha> \"<reason>\"" >&2
  echo "refuses to accept a perf cost without a stated reason" >&2
  exit 2
}

# A reason that is only whitespace is the same as no reason.
trimmed=$(printf '%s' "$reason" | tr -d '[:space:]')
[ -n "$trimmed" ] || {
  echo "refuses a whitespace-only reason" >&2
  exit 2
}

if [ ${#reason} -gt $MAX_DESCRIPTION ]; then
  echo "reason is ${#reason} chars, must be <= $MAX_DESCRIPTION (GitHub's status description limit)" >&2
  exit 2
fi

# Resolves and validates the sha as a real, existing commit before it goes
# anywhere near the GitHub API - a typo'd sha must fail loudly, not post a
# status onto whatever `gh api` happens to interpret it as.
resolved_sha=$(git rev-parse --verify "${sha}^{commit}") || {
  echo "not a commit in this repository: $sha" >&2
  exit 2
}

gh api "repos/$REPO/statuses/$resolved_sha" \
  -f state=success \
  -f context="$CONTEXT" \
  -f description="$reason" \
  >/dev/null

echo "posted $CONTEXT success on $resolved_sha: $reason"
