#!/usr/bin/env bash
# Reads changed file paths on stdin, one per line; prints "true" when any path
# is outside the docs set (docs/** and any *.md), else "false". An empty list
# prints "true": no information must never skip the heavy jobs.
# Used by the `changes` job in .github/workflows/ci.yml.
code=false
seen=false
while IFS= read -r f || [ -n "$f" ]; do
  [ -z "$f" ] && continue
  seen=true
  case "$f" in
    docs/* | *.md) ;;
    *) code=true ;;
  esac
done
[ "$seen" = false ] && code=true
echo "$code"
