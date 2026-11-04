# Cut over the session state folder

**Read first: `git clean -x` and this folder.** Measured on a scratch repo (Git 2.54, Windows, 2026-11-03; details in docs/testing.md, "Nested folders and `git clean`"): `git clean -fdx` in the main checkout deletes `.overwatch` (sessions, protocol state and history, handoffs, held lock slots) and skips the worktrees in `.worktrees/`. `git clean -ffdx` also deletes every worktree in `.worktrees/`, **uncommitted work included**; their branches survive. Never run either in the main checkout.

Use once, after the PR that introduces `.overwatch` (#1202) has merged and the main checkout has synced to develop. The earlier cutover, from `.claude/state/` to `.hackbench-state/` (#725), is done; `migrate-state` still exists for that history.

Until this runs nothing changes: the shared resolver (`tools/scripts/state-dir.mjs`) answers a REAL `<main>/.hackbench-state` folder first, so a merged-but-not-cut-over checkout keeps using it, even if a stray empty `.overwatch` appears. `.overwatch` is answered when the old name is a link or absent. `HACKBENCH_STATE_DIR` overrides both.

## Steps

1. Make sure no run-lock slot is held: `node <main>/tools/scripts/run-lock.mjs status`. The command checks all slots too and refuses if one is held.
2. From the MAIN checkout (not a worktree), with `HACKBENCH_STATE_DIR` unset, run `node tools/scripts/protocol.mjs cutover-state`. It renames `.hackbench-state` to `.overwatch` and leaves a directory junction (symlink off Windows) at the old name.
3. Confirm with `node tools/scripts/protocol.mjs status`: `stateDir` must be `<main>/.overwatch`, with the same registered sessions as before. Re-running `cutover-state` prints `already cut over` and changes nothing.
4. Before deleting the link, check that no worktree runs old code (code without `state-dir.mjs` reads `.hackbench-state`, which works only while the link exists). From the main checkout, in Git Bash:
   `git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r p; do [ -f "$p/tools/scripts/state-dir.mjs" ] || echo "OLD CODE: $p"; done`
   Sync or finish every worktree it names. When it prints nothing, remove the link: `cmd /c rmdir .hackbench-state` (the junction goes, the files stay; on POSIX `rm .hackbench-state`).

## What it refuses (nothing is moved)

- A held run-lock slot (slot 1, 2 or 3, any that exist).
- A non-empty `.overwatch` beside a real `.hackbench-state`: merge by hand. An EMPTY `.overwatch` counts as absent and is removed first.
- `.hackbench-state` already a link, but not to this repo's `.overwatch`.
- `HACKBENCH_STATE_DIR` set, or a worktree as the working directory.

## Failures and recovery

- Rename fails (a process holds a file in the folder): the original stays in place; the message says so. Close the holder, run again.
- Link fails after the rename: the rename is undone and the message says so. Fix the cause and run again.
- Link fails AND the undo fails: the folder is at `.overwatch` with no old name. Run `cutover-state` again: with `.overwatch` present and no `.hackbench-state` it finishes by creating the link.
- Check-then-rename is not atomic. Run it when no session is starting.

## Rollback

With no lock slot held and no session mid-command: `cmd /c rmdir .hackbench-state` (removes the link only), then `mv .overwatch .hackbench-state` (or `ren`). The resolver answers the real `.hackbench-state` again at once. Do not delete `.overwatch` first.

## Why it is safe

Sessions on old-path code (reading `.hackbench-state`) and new code (reading `.overwatch`) see the same files through the link, including run-lock slots; `stateCutover.test.ts` proves both directions on temp folders.
