### Changed

- Tooling: task worktrees now go in `<repo>/.worktrees/<task>` and session state in `<repo>/.overwatch`, both gitignored and kept out of vitest, ESLint, Prettier, tsc, the content gate and GitNexus by a gate test (#1202). The state folder resolves `.overwatch` if present, else `.hackbench-state`, so merging moves nothing; `protocol.mjs cutover-state` does the move (refuses while a run-lock slot is held) and leaves the old name as a link. `docs/testing.md` records what `git clean -nx/-ndx/-fdx/-ffdx` does to both folders (git 2.54, Windows, scratch repo).
