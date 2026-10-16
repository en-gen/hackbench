### Changed

- Agents: the shared session state folder (registrations, handoffs, protocols, the run lock) moves out of the repo, from `<main checkout>/.hackbench-state/` to `<parent>/.overwatch/<main checkout name>/` (`C:/Projects/.overwatch/hackbench/`), beside `.worktrees/` (owner ruling 2026-10-16). `HACKBENCH_STATE_DIR` still overrides it. `protocol.mjs migrate-state` now copies every file of the old folder, nested ones included, and never deletes it; see `docs/runbooks/state-cutover.md`.
