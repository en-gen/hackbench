# Protocols

A protocol is a named mode the owner enacts to change how normal operation runs. It is on or off, it changes the rules listed under its Changes heading for every session in this repository while it is on, and every change is logged. Day shift is the default mode. Procedures are runbooks, not protocols.

Activate with `/protocol <name> on` or `off` (the command lands with the protocol mechanism; see the spec in `docs/superpowers/specs/2026-10-07-agentic-protocols-design.md`). Only the owner enacts a protocol, in chat; the BA runs the command on the owner's words. `throttle` is the one that may switch itself on.

| Protocol                      | Group           | What it is for                        |
| ----------------------------- | --------------- | ------------------------------------- |
| [day-shift](day-shift.md)     | shift (default) | normal operation, stated explicitly   |
| [night-shift](night-shift.md) | shift           | unattended work from the Ready column |
| [throttle](throttle.md)       | none            | a usage limit was hit                 |

A protocol whose Activation starts with `Blocked: <reason>` cannot be turned on until that line is removed. Protocols in the same group are mutually exclusive. Adding one: copy the six headings from an existing file, keep Changes under fifteen lines, and add a row here.

## Side quest

Not a protocol: it applies to one session, not every session, so it has no file here and never goes through `/protocol`. The owner switches it on in a session's own chat ("side quest", "side-quest protocol") to chase one specific problem, such as a chore or a tooling fault, alongside whichever shift is active. Ruling: [2026-10-16-side-quest.md](../decisions/2026-10-16-side-quest.md).

1. The session does the work itself: no registration, no team, no role agents.
2. No BA, Planning, Decisions or Test Planner hand-offs; no issue, board card, D-item or state file unless the owner asks.
3. Questions go straight to the owner in that session.
4. The active shift's orchestration rules (plan gate, queue, `[PROP]`, self-clear) do not apply to it.
5. Every "never" in `CLAUDE.md`, the quality gates, Branches and commits, and the data and image rules still apply.
6. It ends when the owner says so or the problem is solved.
