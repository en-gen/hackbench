# Cut over the session state folder

Use once, after the PR that introduces `.overwatch` (#1202) has merged and the main checkout has synced to develop. The earlier cutover, from `.claude/state/` to `.hackbench-state/` (#725), is done; `migrate-state` still exists for that history.

Until this runs, nothing changes: the shared resolver (`tools/scripts/state-dir.mjs`) answers `<main>/.overwatch` if it exists, else `<main>/.hackbench-state`, so a merged-but-not-cut-over checkout keeps using `.hackbench-state`. `HACKBENCH_STATE_DIR` overrides both.

1. Make sure no run-lock slot is held: `node <main>/tools/scripts/run-lock.mjs status`. The command checks too and refuses if one is.
2. From the MAIN checkout (not a worktree), with `HACKBENCH_STATE_DIR` unset, run `node tools/scripts/protocol.mjs cutover-state`. It renames `.hackbench-state` to `.overwatch` and leaves a directory junction (symlink off Windows) at the old name pointing to it.
3. Confirm with `node tools/scripts/protocol.mjs status`: `stateDir` must be `<main>/.overwatch`, with the same registered sessions as before.
4. Running it again prints `already cut over` and changes nothing.

What it refuses, and what it leaves behind:

- A held run-lock slot, an existing `.overwatch`, or a worktree as the working directory: nothing is moved.
- A failed rename (a process holding a file in the folder, say): the original stays in place and the message says so. A failed link after the rename undoes the rename.
- Check-then-rename is not atomic. Run it when no session is starting, as with the earlier cutover.

Sessions still on old-path code (reading `.hackbench-state`) and new code (reading `.overwatch`) see the same files through the link, including run-lock slots; `stateCutover.test.ts` proves both directions on temp folders. Keep the link until every session has synced, then delete it by hand (`rmdir .hackbench-state` removes the junction only).

`git clean -x` deletes both folders; see "Nested folders and `git clean`" in docs/testing.md.
