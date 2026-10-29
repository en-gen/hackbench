#!/usr/bin/env bash
# Kept for #1163; no hook or CI calls it since #1183 (owner ruling R28). [PROP]
exec node "$(dirname "$0")/check-content.mjs" "$@"
