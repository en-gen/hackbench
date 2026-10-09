# Cut over the session state folder

Use once, when the PR that moves state from `.claude/state/` to `.hackbench-state/` has merged. `[PROP]` from #725, not yet run; the first run confirms or corrects it.

Every worktree session's hook runs from the main checkout, so the switch happens when the main checkout syncs, not when a worktree does.

1. Merge the PR.
2. Delete the stray `<main>/.hackbench-state/` if it holds only an empty registry (`{}`) and no team files. Otherwise stop and ask the owner.
3. Sync the main checkout to develop and, in the same turn, run `node <main>/tools/scripts/protocol.mjs migrate-state` from it. No session may start or clear between the two. It copies `sessions.json` (re-keyed by desktop id), `protocols.json`, `protocols.log`, `ba.md` and `teams/*.md`; it never deletes the source. If it reports `sessions.json` under skipped, stop.
4. Confirm with `node <main>/tools/scripts/protocol.mjs status`: it prints the absolute state folder it reads and the registered sessions.
5. Sync the team worktrees whenever convenient. Their own copies matter only for commands run by a relative path, and the manuals use the absolute path.
6. Enact protocols only after step 4.

Why: nothing may write state between the sync and step 4. A registration or protocol change made in that window lands in only one of the two folders, and the hook does not read the old folder as a fallback.

Delete the old `.claude/state/` only after every session has synced, and only on the owner's go.
