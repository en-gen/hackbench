#!/usr/bin/env bash
# Blocks content that project policy forbids committing.
#
# Rule 1 (copyright, docs/testing.md): no ROM-derived bytes, in any transform.
#   Super Mario World is (c) Nintendo. Bytes extracted from the ROM stay
#   Nintendo's property whether compressed, decompressed, whole, or sliced.
#   This is the highest-stakes rule in the repo and was previously guarded
#   only by .gitignore, which an explicit `git add -f` silently defeats.
#
# Rule 2 (style, CLAUDE.md): no em-dash characters in newly added lines.
#   Checked on added lines only, so pre-existing occurrences do not block
#   unrelated work.
#
# Runs from the pre-commit hook and from CI. Exit 0 = clean, 1 = violation.
# Emergency override is `git commit --no-verify`, which is deliberately
# awkward and should be explained in the PR if used.

set -uo pipefail

mode="${1:-staged}"   # "staged" (hook) or "range" (CI: pass BASE HEAD)
fail=0

if [ "$mode" = "range" ]; then
  base="${2:?range mode needs BASE}"
  head="${3:?range mode needs HEAD}"
  files=$(git diff --name-only --diff-filter=ACMR "$base" "$head")
  diffcmd() { git diff "$base" "$head" -- "$1"; }
else
  files=$(git diff --cached --name-only --diff-filter=ACMR)
  diffcmd() { git diff --cached -- "$1"; }
fi

[ -z "$files" ] && exit 0

# --- Rule 1: ROM-derived bytes -------------------------------------------

# Extensions that are ROM images, saves, savestates or patches. Never allowed.
rom_ext='\.(smc|sfc|rom|srm|mss|ips|bps|spc|cdl)$'

# Paths whose contents are ROM-derived by construction. Allow-list the few
# first-party files that legitimately live there.
while IFS= read -r f; do
  [ -z "$f" ] && continue

  if printf '%s' "$f" | grep -qiE "$rom_ext"; then
    echo "BLOCKED (ROM/save/state file): $f"
    fail=1
    continue
  fi

  case "$f" in
    test/fixtures/README.md) ;;
    test/fixtures/*)
      echo "BLOCKED (ROM-derived fixture): $f"
      echo "  test/fixtures/ is regenerated locally from your own ROM. See docs/testing.md."
      fail=1
      ;;
    tools/mesen/*.lua|tools/mesen/README.md) ;;
    tools/mesen/*)
      echo "BLOCKED (emulator binary or capture output): $f"
      echo "  Only *.lua and README.md are tracked under tools/mesen/."
      fail=1
      ;;
    build/icons/*) ;;
    *.png|*.bmp|*.gif|*.bin|*.dmp|*.raw)
      echo "BLOCKED (binary asset outside build/icons/): $f"
      echo "  If this is genuinely not ROM-derived, add an explicit allow-list entry."
      fail=1
      ;;
  esac
done <<< "$files"

# --- Rule 2: em-dashes in added lines ------------------------------------

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.md|*.ts|*.js|*.lua|*.ps1|*.sh|*.json|*.yml|*.yaml) ;;
    *) continue ;;
  esac
  # Built from its UTF-8 bytes so this file contains no literal em-dash and
  # therefore does not flag itself.
  emdash=$(printf '\xe2\x80\x94')
  if diffcmd "$f" | grep -n '^+' | grep -q "$emdash"; then
    echo "BLOCKED (em-dash in added lines): $f"
    echo "  Project style uses regular dashes. See CLAUDE.md."
    fail=1
  fi
done <<< "$files"

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Commit blocked by tools/scripts/check-staged-content.sh."
  echo "Override with 'git commit --no-verify' only with a stated reason."
  exit 1
fi

exit 0
