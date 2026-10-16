# Cut over the session state folder

Use once, when the PR that moves state from `<main>/.hackbench-state/` to `<parent of main>/.overwatch/<main name>/` (here `C:/Projects/.overwatch/hackbench/`) has merged. Owner ruling 2026-10-16. `[PROP]`, not yet run; the first run confirms or corrects it. (The earlier move from `.claude/state/` to `.hackbench-state/` is done.)

Every worktree session's hook runs from the main checkout, so the switch happens when the main checkout syncs, not when a worktree does.

1. Merge the PR. Wait until `node <main>/tools/scripts/run-lock.mjs status` prints `free`: a held run lock is copied as held, and its owner would release only the old copy.
2. If `C:/Projects/.overwatch/hackbench/` already exists and holds anything but an empty registry (`{}`), stop and ask the owner.
3. Sync the main checkout to develop and, in the same turn, with `HACKBENCH_STATE_DIR` unset (it would redirect the target), run `node <main>/tools/scripts/protocol.mjs migrate-state` from it. No session may start or clear between the two. It copies every file under `<main>/.hackbench-state/`, nested ones included (`sessions.json`, `protocols.json`, `protocols.log`, `ba.md`, `team-registry.md`, `team-protocol.md`, `teams/`, `locks/`), skips the state lock `.lock` and `*.tmp`, never overwrites a target and never deletes the source. If it reports anything under skipped, stop.
4. Confirm with `node <main>/tools/scripts/protocol.mjs status`: it prints the absolute state folder it reads, which must be `C:\Projects\.overwatch\hackbench`, and the registered sessions. `node <main>/tools/scripts/run-lock.mjs status` must print `free`. If it prints a holder, the lock was acquired mid-cutover and `migrate-state` copied its `locks/run/owner.txt` as held, while a holder on old code releases only the old copy. Remedy: wait until `HACKBENCH_STATE_DIR=<main>/.hackbench-state node <main>/tools/scripts/run-lock.mjs status` prints `free`; then the owner (never an agent) removes `C:/Projects/.overwatch/hackbench/locks/run/`, and step 4 is re-run. The new folder may hold a run lock only one acquired there after the cutover.
5. Sync the team worktrees whenever convenient. Their own copies matter only for commands run by a relative path, and the manuals use the absolute path.
6. Enact protocols only after step 4.

Why: nothing may write state between the sync and step 4. A registration or protocol change made in that window lands in only one of the two folders, and the hook does not read the old folder as a fallback.

Delete the old `<main>/.hackbench-state/` only after every session has synced, and only on the owner's go. Its `.gitignore` line goes with it.
