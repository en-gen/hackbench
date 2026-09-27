#!/usr/bin/env bash
# Blocks content that project policy forbids committing (rule 1: no
# ROM-derived bytes; rule 2: no em-dashes in added lines). The repo is
# public, so a push is publication: see docs/testing.md ("The content
# gate") for the full rule list and rationale, and issue #678.
#
# Modes, all sharing the rule functions below (nothing forked per mode):
#   staged            - git diff --cached (pre-commit hook)
#   range BASE HEAD   - git diff BASE..HEAD (CI, pre-push)
#   history           - every blob reachable from every ref, whole content
#                        (the repo-migration oracle). Rule 1 only. Output:
#                        BLOCKED (<rule>): <path> (first added in <sha>)
#
# Exit 0 = clean, 1 = violation. Emergency override for staged/range is
# `git commit --no-verify`; see .githooks/pre-push for why that alone does
# not let a bad commit through.

set -uo pipefail

mode="${1:-staged}"
fail=0

# --- shared rule data --------------------------------------------------------

# ROM images, saves, savestates, patches. Never allowed, anywhere.
rom_ext='\.(smc|sfc|rom|srm|mss|ips|bps|spc|cdl|wasm)$'

# Decoded/raw image and byte-dump formats. A P3 (ASCII) .ppm is still a
# decoded GFX sheet, so this is checked independently of the binary test.
image_ext='\.(ppm|pgm|pbm|pnm|bmp|tga|gif|png|jpg|jpeg|webp|chr|bin|raw|dmp)$'

# Disassembly excerpts. ASM is reference material in SMWDisX, never this repo.
asm_ext='\.asm$'

is_allowlisted_path() {
  case "$1" in
    build/icons/* | theia/no-native/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Files whose high-entropy content is expected and not ROM-derived, so
# content sniffing (base64/hex) is skipped for them.
is_lockfile() {
  case "$1" in
    package-lock.json | */package-lock.json | yarn.lock | */yarn.lock) return 0 ;;
    *) return 1 ;;
  esac
}

# git's own binary heuristic: a NUL in the first 8000 bytes. Reads content
# from stdin. Exit 0 = binary.
is_binary_content() {
  perl -0777 -ne 'print(index($_, "\0") >= 0 ? "1" : "0")' 2>/dev/null | grep -q '^1$'
}

# Path/extension rules that do not need file content. Prints BLOCKED lines
# to stdout; returns 1 if anything was blocked.
check_path_rules() {
  local f="$1"

  if is_allowlisted_path "$f"; then
    return 0
  fi

  if printf '%s' "$f" | grep -qiE "$rom_ext"; then
    echo "BLOCKED (ROM/save/state file): $f"
    return 1
  fi

  if printf '%s' "$f" | grep -qiE "$asm_ext"; then
    echo "BLOCKED (disassembly excerpt): $f"
    return 1
  fi

  if printf '%s' "$f" | grep -qiE "$image_ext"; then
    echo "BLOCKED (decoded/raw image or byte-dump format): $f"
    return 1
  fi

  case "$f" in
    test/fixtures/README.md) ;;
    test/fixtures/*)
      echo "BLOCKED (ROM-derived fixture): $f"
      echo "  test/fixtures/ is regenerated locally from your own ROM. See docs/testing.md."
      return 1
      ;;
    tools/mesen/*.lua | tools/mesen/README.md) ;;
    tools/mesen/*)
      echo "BLOCKED (emulator binary or capture output): $f"
      echo "  Only *.lua and README.md are tracked under tools/mesen/."
      return 1
      ;;
    *.dll | *.so | *.so.* | *.dylib)
      echo "BLOCKED (native binary): $f"
      echo "  Cores are supplied by the user at runtime and belong in vendor/cores/,"
      echo "  which is gitignored. Do not vendor a core into the repository."
      return 1
      ;;
  esac

  return 0
}

# Content sniffing on a chunk of text (either added lines, joined, or a
# whole-file blob). Reads from stdin. Prints BLOCKED lines; returns 1 if
# anything was blocked.
check_text_content() {
  local f="$1"

  is_lockfile "$f" && return 0

  local hits
  hits=$(perl -0777 -ne '
    my @found;

    # data: image URI with an actual payload. A template placeholder like
    # "__B64__" is not valid base64 and will not match here.
    if (/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+\/]{40,}={0,2}/) {
      push @found, "data-uri";
    }

    # Plain base64 blob, unrelated to a data: URI. ~300+ contiguous chars.
    # A lockfile integrity hash (sha512-base64, ~88 chars) stays well under
    # this threshold too, so the caller only needs to skip lockfiles as a
    # belt-and-braces measure.
    if (/[A-Za-z0-9+\/]{300,}={0,2}/) {
      push @found, "base64";
    }

    # Hex/byte array literals: 0x.. or $.. tokens, comma-separated, spanning
    # any number of lines. Counts tokens in the run, not characters, so a
    # >256-entry array blocks while a 106..110-entry table
    # (SlopeResolver.test.ts) stays legal.
    while (/(?:0x[0-9a-fA-F]{2}\s*,\s*){1,}0x[0-9a-fA-F]{2}/g) {
      my @tok = ($& =~ /0x[0-9a-fA-F]{2}/g);
      if (@tok > 256) { push @found, "hex-array"; last; }
    }
    while (/(?:\$[0-9a-fA-F]{2}\s*,\s*){1,}\$[0-9a-fA-F]{2}/g) {
      my @tok = ($& =~ /\$[0-9a-fA-F]{2}/g);
      if (@tok > 256) { push @found, "hex-array"; last; }
    }

    print "$_\n" for @found;
  ')

  [ -z "$hits" ] && return 0

  local blocked=0
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    case "$hit" in
      data-uri) echo "BLOCKED (data: image URI with a payload): $f" ;;
      base64) echo "BLOCKED (base64 blob over ~300 chars): $f" ;;
      hex-array) echo "BLOCKED (hex/byte array over 256 bytes): $f" ;;
    esac
    blocked=1
  done <<<"$hits"
  return "$blocked"
}

# Em-dash in text. Reads from stdin. Prints a BLOCKED line; returns 1 if found.
check_emdash() {
  local f="$1"
  # Built from its UTF-8 bytes so this file contains no literal em-dash and
  # therefore does not flag itself.
  local emdash
  emdash=$(printf '\xe2\x80\x94')
  if grep -q "$emdash"; then
    echo "BLOCKED (em-dash): $f"
    echo "  Project style uses regular dashes. See CLAUDE.md."
    return 1
  fi
  return 0
}

is_style_checked_ext() {
  case "$1" in
    *.md | *.ts | *.js | *.lua | *.ps1 | *.sh | *.json | *.yml | *.yaml) return 0 ;;
    *) return 1 ;;
  esac
}

# Evaluate every rule for one path. content_file holds the text to sniff
# (added lines for staged/range, whole blob for history); empty/absent for a
# binary file. check_style is 1 for staged/range, 0 for history (rule 2 is
# a style preference, not a publication risk, and would only add migration
# noise). Prints BLOCKED lines; returns 1 if anything was blocked.
evaluate_file() {
  local f="$1" is_binary="$2" content_file="$3" check_style="$4"
  local blocked=0

  if [ "$is_binary" = "1" ] && ! is_allowlisted_path "$f"; then
    echo "BLOCKED (binary content outside the allow-list): $f"
    blocked=1
  fi

  check_path_rules "$f" || blocked=1

  if [ "$is_binary" != "1" ] && [ -s "$content_file" ]; then
    check_text_content "$f" <"$content_file" || blocked=1
    if [ "$check_style" = "1" ] && is_style_checked_ext "$f"; then
      check_emdash "$f" <"$content_file" || blocked=1
    fi
  fi

  return "$blocked"
}

# --- mode: staged / range ----------------------------------------------------

run_diff_mode() {
  local files

  if [ "$mode" = "range" ]; then
    local base="${2:?range mode needs BASE}"
    local head="${3:?range mode needs HEAD}"
    files=$(git diff --name-only --diff-filter=ACMR "$base" "$head")
    numstat() { git diff --numstat "$base" "$head" -- "$1"; }
    addedlines() { git diff "$base" "$head" -- "$1" | grep '^+' | grep -v '^+++'; }
  else
    files=$(git diff --cached --name-only --diff-filter=ACMR)
    numstat() { git diff --cached --numstat -- "$1"; }
    addedlines() { git diff --cached -- "$1" | grep '^+' | grep -v '^+++'; }
  fi

  [ -z "$files" ] && return 0

  local tmp
  tmp=$(mktemp)

  while IFS= read -r f; do
    [ -z "$f" ] && continue

    local is_binary=0
    if numstat "$f" | awk -F'\t' '$1 == "-" && $2 == "-" { found=1 } END { exit !found }'; then
      is_binary=1
    fi

    : >"$tmp"
    if [ "$is_binary" != "1" ]; then
      addedlines "$f" | sed 's/^+//' >"$tmp"
    fi

    evaluate_file "$f" "$is_binary" "$tmp" 1 || fail=1
  done <<<"$files"

  rm -f "$tmp"
}

# --- mode: history ------------------------------------------------------------

find_first_commit_added() {
  local path="$1" blobsha="$2"
  git log --all --format='%H' --reverse -- "$path" 2>/dev/null | while IFS= read -r c; do
    actual=$(git rev-parse --quiet --verify "$c:$path" 2>/dev/null) || continue
    if [ "$actual" = "$blobsha" ]; then
      echo "$c"
      break
    fi
  done | head -1
}

run_history_mode() {
  local tmp report
  tmp=$(mktemp)
  report=$(mktemp)

  git rev-list --objects --all | while IFS= read -r line; do
    local sha="${line%% *}"
    local path="${line#* }"
    [ "$sha" = "$path" ] && continue # no path attached: commit or tree, not a blob
    [ -z "$path" ] && continue

    [ "$(git cat-file -t "$sha" 2>/dev/null)" = "blob" ] || continue

    : >"$tmp"
    git cat-file -p "$sha" >"$tmp" 2>/dev/null

    local is_binary=0
    is_binary_content <"$tmp" && is_binary=1

    local out rc
    out=$(evaluate_file "$path" "$is_binary" "$tmp" 0)
    rc=$?
    [ "$rc" -eq 0 ] && continue
    [ -z "$out" ] && continue

    local commit
    commit=$(find_first_commit_added "$path" "$sha")
    while IFS= read -r bline; do
      case "$bline" in
        BLOCKED*) printf '%s (first added in %s)\n' "$bline" "${commit:-unknown}" ;;
        *) ;; # explanatory sub-line: not machine-readable, dropped from the report
      esac
    done <<<"$out"
  done >"$report"

  if [ -s "$report" ]; then
    cat "$report"
    fail=1
  fi
  rm -f "$tmp" "$report"
}

# --- dispatch -----------------------------------------------------------------

case "$mode" in
  staged | range) run_diff_mode "$@" ;;
  history) run_history_mode ;;
  *)
    echo "usage: check-staged-content.sh [staged | range BASE HEAD | history]" >&2
    exit 2
    ;;
esac

if [ "$fail" -ne 0 ]; then
  if [ "$mode" != "history" ]; then
    echo ""
    echo "Commit blocked by tools/scripts/check-staged-content.sh."
    echo "Override with 'git commit --no-verify' only with a stated reason."
    echo "Note: git push runs this again via .githooks/pre-push, so a --no-verify'd"
    echo "commit is still caught at push time unless the push itself skips hooks too."
  fi
  exit 1
fi

exit 0
