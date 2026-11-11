Proposed 2026-11-11 (charlie, #1370)

# The capture harness clears its recording on the first reload only

## Question

The capture harness (`headless_capture.lua`, `en-gen/hackbench-validation` `bc8d1a3`, PR #47) clears its recording when the room reloads during the wait. It does this on the first reload only. If a second reload happens, the recording from the middle load is kept. Do we fix that or document it?

## Options considered

1. (A) Document the limit in `headless_capture.lua` and leave the behavior as it is.
2. (B) Clear the recording on every reload during the wait.
3. (C) Refuse a capture that sees a second reload.

## Ruling

wording not recorded. Option A was taken for the PR #47 captures; this file is [PROP] until the owner rules.

## Why

The limit is documented in `headless_capture.lua` on PR #47 (a comment at the reload branch, around line 1971; verified by the reviewer). A second reload has not been seen in any vanilla capture (the four re-captured maps 101, 1d4, 109 and 11b, one machine, 2026-11). A hack that reloads a room twice during the wait would give a capture whose recording belongs to the middle load. The limit is written in the harness header. It is not fixed because no capture needs it. `[EST]` for the comment's location (reviewer-verified); `[INF]` for the no-need claim, from the four re-captures.

## Applies to

`capture/headless_capture.lua` in `en-gen/hackbench-validation`; the `layers_v5` set.
