Proposed 2026-11-04 (tech lead, #1202)

# State-inside-repo cutover: hooks stay, a junction covers the old name

## Question

#1202 (PR #1218) moved the session state folder inside the repo. Two calls shaped the cutover and neither was ruled. Are they right?

## Options considered

1. Leave `.claude/settings.json` and `.githooks` as they are, and have `cutover-state` rename the folder and link the old name to the new one. `[PROP]`
2. Edit the hooks and settings to name the new folder, and cut over hard with no link.

## Ruling

not ruled. Option 1 is what shipped in #1218 and is filed as a proposal only. `[PROP]`

## Why

### Hooks and settings stay as they are

- #1202 left `.claude/settings.json` and `.githooks` unchanged. Nothing in them names the state folder. `protocol-inject.mjs` reaches it through `protocol.mjs`, which imports `tools/scripts/state-dir.mjs`.
- Fewer moving parts during a fleet cutover. `[INF]`
- Evidence: a grep of both for `.hackbench-state` and `.overwatch` found no match, and `git diff` of both against the pre-merge develop (e303d621^1) is empty. One checkout, 2026-11-04. `[EST]`

### Cutover leaves a junction at the old name

- `cutover-state` renames the folder and links `.hackbench-state` to `.overwatch`, instead of a hard cut.
- Worktrees on pre-#1202 code keep working and share one folder and one set of run-lock slots.
- The link stays until the runbook's check prints SAFE. Removing it early lets two sessions hold the same slot.
- Evidence: real develop code in a linked worktree, one Windows machine, one run each. See `docs/runbooks/state-cutover.md`. `[EST]`

## Applies to

`tools/scripts/state-dir.mjs`, `tools/scripts/protocol-inject.mjs`, `.claude/settings.json`, `.githooks/`, `docs/runbooks/state-cutover.md`.
