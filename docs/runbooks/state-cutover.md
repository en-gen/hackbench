# Cut over the session state folder

Use once, when the PR that moves state from `.claude/state/` to `.hackbench-state/` has merged. `[PROP]` from #725, not yet run; the first run confirms or corrects it.

1. The PR merges.
2. From the main checkout run `node tools/scripts/protocol.mjs migrate-state` once. It copies `sessions.json` (re-keyed by desktop id), `protocols.json`, `protocols.log`, `ba.md` and `teams/*.md`, never overwrites a target and never deletes the source. It prints what it copied and skipped.
3. Sync every session to develop in one pass: the main checkout first, then each team worktree.
4. Confirm each session's hook prints the new `.hackbench-state` path.
5. Only then enact any protocol.

Why: nothing may write state between step 2 and step 4. A registration, reclaim or protocol change made in that window lands in only one of the two folders, and the hook does not read the old folder as a fallback.

Delete the old `.claude/state/` only after every session has synced, and only on the owner's go.
