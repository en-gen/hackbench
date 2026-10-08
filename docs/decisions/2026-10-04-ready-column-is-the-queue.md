Ruled 2026-10-04 (Brian)

## Question

How does the owner hand over autonomous, unattended development from a groomed backlog?

## Options considered

Workflow scripts, cost-cap tooling or a dedicated runner; the orchestrator's normal loop.

## Ruling

Owner goal 2026-10-04, wording not recorded. Backlog instructions such as "work the next top 10 priority items while I sleep" run on the normal loop. No special scripts, cost caps or runner. `[INF]`

## Why

- The owner wants to spend their time planning with Claude, not driving each issue. `[EST]`
- The Ready column order on the board is the priority queue; the owner declined custom Priority/Size fields. `[EST]`
- Ready means: testable acceptance criteria, a size, no `needs-design` label, no open blocker, not L. The keyword "has acceptance criteria" overstated readiness about 3x in the 2026-10-04 audit (8 of 25 truly ready). `[EST]`
- 2026-10-05 run terms: sweep Ready for owner questions first; plan gate pre-approved with the standard roster; every PR auto-merges regardless of scope; Opus escalation for one round; 2-3 issues in parallel; a shelved issue gets a "shelved: reason" comment and returns to Ready. `[EST]`
- Grooming shape that worked (2026-10-06): board pull, owner picks a milestone theme, full issue bodies, one "Grooming <date>" comment per issue, one owner yes, REST posting with read-back. `[EST]`
- About 40 GraphQL project mutations in a row hit the GraphQL burst limit with REST untouched; reset took about 40 minutes. Post comments through REST. `[EST]`
- Milestones: 0.1 Vanilla levels incl. sprite viewing, 0.2 Hack compatibility, 0.3 Overworld and ROM browsing, 0.4 Tile editing and working-copy integrity, 0.5 Level editing, 0.6-0.9, 1.0, plus Infrastructure and Icebox. `[EST]`

## Applies to

Superseded in part by protocol `night-shift` (`../protocols/night-shift.md`), change 4: the queue is the Ready column, top down. Direction rulings go on the design issue (interpreter first, 2026-10-06, #655).
