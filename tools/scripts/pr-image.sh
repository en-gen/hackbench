#!/usr/bin/env bash
# Upload images to the private en-gen/hackbench-pr-assets repo and print the
# markdown that embeds them in a PR or comment. Rendered SMW graphics are
# ROM-derived, so they never go into hackbench's own history.
#
#   tools/scripts/pr-image.sh <folder> <image>...
#
# <folder> groups one PR's images, e.g. the branch name. An image already at
# that path is replaced. Pairs named <x>.before.png / <x>.after.png print as
# one side-by-side table row.
set -euo pipefail

REPO=en-gen/hackbench-pr-assets
[ $# -ge 2 ] || { echo "usage: $0 <folder> <image>..." >&2; exit 2; }
folder=${1%/}
shift

url() { echo "https://github.com/$REPO/blob/main/$folder/$1?raw=true"; }

for file in "$@"; do
  [ -f "$file" ] || { echo "not a file: $file" >&2; exit 2; }
  name=$(basename "$file")
  path="$folder/$name"
  # gh prints the 404 body to stdout, so a failed lookup must clear it
  sha=$(gh api "repos/$REPO/contents/$path" --jq .sha 2>/dev/null) || sha=
  # The body goes on stdin: as an argument, base64 past ~24 KB of image
  # exceeds the Windows command-line limit ("Argument list too long").
  msg=$(printf '%s' "$path" | sed 's/[\\"]/\\&/g')
  {
    printf '{"message":"%s",%s"content":"' "$msg" "${sha:+\"sha\":\"$sha\",}"
    base64 -w0 "$file"
    printf '"}'
  } | gh api -X PUT "repos/$REPO/contents/$path" --input - --silent
done

for file in "$@"; do
  name=$(basename "$file")
  case "$name" in
    *.after.*)
      # printed with its .before partner when that was uploaded too
      [[ " $* " == *"${name/.after./.before.}"* ]] || echo "![${name%.*}]($(url "$name"))"
      ;;
    *.before.*)
      after=${name/.before./.after.}
      stem=${name%%.before.*}
      echo "| $stem: before | after |"
      echo "| --- | --- |"
      echo "| ![before]($(url "$name")) | ![after]($(url "$after")) |"
      ;;
    *) echo "![${name%.*}]($(url "$name"))" ;;
  esac
done
