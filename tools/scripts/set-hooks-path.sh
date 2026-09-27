#!/usr/bin/env bash
# Run by the npm `prepare` lifecycle script so the content gate and style
# gate are wired up automatically, without relying on someone running
# `git config core.hooksPath .githooks` by hand (issue #678 - that manual
# step was one of the reasons the gate had holes).
#
# Guarded so `npm ci`/`npm install` never fails because of this: it must
# also succeed when unpacked from a tarball with no .git directory at all
# (npm re-runs `prepare` on install from a package tarball).

set -u

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git config core.hooksPath .githooks
fi

exit 0
