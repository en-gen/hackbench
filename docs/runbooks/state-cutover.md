# Cut over the session state folder

**Read first: `git clean -x` and this folder.** Measured on a scratch repo (Git 2.54, Windows, 2026-11-03; details in docs/testing.md, "Nested folders and `git clean`"): `git clean -fdx` in the main checkout deletes `.overwatch` (sessions, protocol state and history, handoffs, held lock slots) and skips the worktrees in `.worktrees/`. `git clean -ffdx` also deletes every worktree in `.worktrees/`, **uncommitted work included**; their branches survive. Never run either in the main checkout.

Use once, after the PR that introduces `.overwatch` (#1202) has merged and the main checkout has synced to develop. The earlier cutover, from `.claude/state/` to `.hackbench-state/` (#725), is done; `migrate-state` still exists for that history.

Until this runs nothing changes. The shared resolver (`tools/scripts/state-dir.mjs`) answers, in order: `HACKBENCH_STATE_DIR`; `.overwatch` when it holds the marker `.cutover-complete` (which `cutover-state` writes into the folder before renaming it, so the rename makes it take effect), even if a real `.hackbench-state` exists beside it; a REAL `.hackbench-state`; else `.overwatch`. So a merged-but-not-cut-over checkout keeps using the old folder, a stray empty or unmarked `.overwatch` cannot take over, and after cutover code that predates #1202 and recreates a real `.hackbench-state` cannot pull new-code sessions onto it.

## Steps

1. Make sure no run-lock slot is held: `node <main>/tools/scripts/run-lock.mjs status`. The command checks all slots too and refuses if one is held.
2. From the MAIN checkout (not a worktree), with `HACKBENCH_STATE_DIR` unset, run `node tools/scripts/protocol.mjs cutover-state`. It renames `.hackbench-state` to `.overwatch` and leaves a directory junction (symlink off Windows) at the old name.
3. Confirm with `node tools/scripts/protocol.mjs status`: `stateDir` must be `<main>/.overwatch`, with the same registered sessions as before. Re-running `cutover-state` prints `already cut over` and changes nothing.
4. Keep the old-name link until no pre-#1202 code can run: no worktree AND no open PR branch without #1202 merged. Old code on a removed link writes a separate real folder, and two sessions can then hold the same run-lock slot. Checks, from the main checkout in Git Bash:
   - Worktrees: `git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r p; do [ -f "$p/tools/scripts/state-dir.mjs" ] || echo "OLD CODE: $p"; done`
   - Open PR branches (`git fetch origin` first; a head git cannot find also prints, which errs safe): `M=$(git log --first-parent --grep='#1202' -1 --format=%H origin/develop); gh pr list --state open --json number,headRefOid --jq '.[]|"\(.number) \(.headRefOid)"' | while read -r n sha; do git merge-base --is-ancestor "$M" "$sha" 2>/dev/null || echo "OLD CODE: PR $n"; done`. Sync or finish every worktree and PR it names.
   When both print nothing, remove the link: `cmd /c rmdir .hackbench-state` (the junction goes, the files stay; on POSIX `rm .hackbench-state`).

## What it refuses (nothing is moved)

- A held run-lock slot (slot 1, 2 or 3, any that exist).
- A non-empty `.overwatch` beside a real `.hackbench-state`: reconcile by hand (see Recovery). An EMPTY `.overwatch` counts as absent and is removed first.
- `.hackbench-state` already a link, but not to this repo's `.overwatch`.
- `HACKBENCH_STATE_DIR` set, or a worktree as the working directory.

## Failures and recovery

- Rename fails (a process holds a file in the folder): the original stays in place; the message says so. Close the holder, run again.
- Link fails after the rename: the rename is undone and the message says so. Fix the cause and run again.
- Link fails AND the undo fails: the folder is at `.overwatch` with no old name. Run `cutover-state` again: with `.overwatch` present and no `.hackbench-state` it finishes by creating the link.
- Crash between the rename and the link, then a real `.hackbench-state` appears (old code recreated it): new code stays on `.overwatch` (it holds the marker), and re-running `cutover-state` refuses (non-empty `.overwatch` beside a real old folder). Reconcile by hand with no session mid-command: copy anything wanted from the new real `.hackbench-state` into `.overwatch` (it is usually a few fresh registrations and no history), `cmd /c rmdir /s /q .hackbench-state` on that real folder only (never `.overwatch`), then run `cutover-state` to create the link.
- Check-then-rename is not atomic. Run it when no session is starting.

## Rollback

With no lock slot held and no session mid-command (a hook-driven session registration counts as a command, so no session may be starting): `cmd /c rmdir .hackbench-state` (removes the link only), `del .overwatch\.cutover-complete` (without this the resolver keeps answering `.overwatch`), then `mv .overwatch .hackbench-state` (or `ren`). The resolver answers the real `.hackbench-state` again at once. Do not delete `.overwatch` first.

## Why it is safe

Sessions on old-path code (reading `.hackbench-state`) and new code (reading `.overwatch`) see the same files through the link, including run-lock slots; `stateCutover.test.ts` proves both directions on temp folders.
