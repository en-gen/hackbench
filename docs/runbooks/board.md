# The project board and GitHub scope

Use when moving cards or querying the board. `[EST]` 2026-09-26.

1. Board: `https://github.com/orgs/en-gen/projects/1`, project id `PVT_kwDOAQyDNc4Bkx9P`, created 2026-09-26. Claiming rules are in `CLAUDE.md` "Issues".
2. Status field id `PVTSSF_lADOAQyDNc4Bkx9PzhjhS5w`. Options: Backlog=34d8e7a2, Ready=e8da921b, In progress=f71e6d84, In review=3d1ea714, Done=e87159b0.
3. Built-in workflows on: auto-add (is:issue is:open), added to Backlog, closed to Done, PR linked to In review, PR merged to Done. Auto-close issue is deliberately off. Each session moves its own cards; there is no relay session.
4. Scope (owner, 2026-09-26): touch only `en-gen` resources. Always pass `-R en-gen/<repo>` or `--owner en-gen`. The `gh` login has `project` scope and is account-wide, so it reaches other organisations; never list or edit projects or repos under other owners.
5. A fine-grained credential limited to the `en-gen` owner exists for tooling; it cannot link projects to repos (needs admin).
6. Poll and bulk-write through REST, not GraphQL; see `merge-detection.md` and the rate-limit note in `../decisions/2026-10-04-ready-column-is-the-queue.md`.
