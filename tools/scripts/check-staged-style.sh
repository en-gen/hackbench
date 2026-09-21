#!/usr/bin/env bash
# Lint and format gate for staged JS/TS/CSS.
#
# The CI job sweeps the whole tree; this checks only what is being committed,
# so the hook stays fast enough that nobody reaches for --no-verify out of
# impatience. Both halves have to agree with the CI scripts, which is what
# test/suite/gates/lintGate.test.ts pins.
#
# Exit 0 = clean, 1 = violation. Override is `git commit --no-verify`, which
# should be explained in the PR if used.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '\.(ts|tsx|js|mjs|cjs|css)$' || true)

[ ${#files[@]} -eq 0 ] && exit 0

fail=0

# --no-warn-ignored keeps an explicitly-passed but ignored file (spike/, say)
# from turning into a warning that --max-warnings 0 then treats as fatal.
if ! npx --no-install eslint --max-warnings 0 --no-warn-ignored "${files[@]}"; then
  echo ""
  echo "Lint failed. Fix, or run: npm run lint:fix"
  fail=1
fi

if ! npx --no-install prettier --check "${files[@]}"; then
  echo ""
  echo "Formatting differs. Run: npm run format"
  fail=1
fi

exit $fail
