# Protocols

A protocol is a named mode the owner enacts to change how normal operation runs. It is on or off, it changes the rules listed under its Changes heading for every session in this repository while it is on, and every change is logged. Day shift is the default mode. Procedures are runbooks, not protocols.

Activate with `/protocol <name> on` or `off` (the command lands with the protocol mechanism; see the spec in `docs/superpowers/specs/2026-10-07-agentic-protocols-design.md`). Only the owner enacts a protocol, in chat; the BA runs the command on the owner's words. `throttle` is the one that may switch itself on.

| Protocol | Group | What it is for |
| --- | --- | --- |
| [day-shift](day-shift.md) | shift (default) | normal operation, stated explicitly |
| [night-shift](night-shift.md) | shift | unattended work from the Ready column |
| [throttle](throttle.md) | none | a usage limit was hit |

A protocol whose Activation starts with `Blocked: <reason>` cannot be turned on until that line is removed. Protocols in the same group are mutually exclusive. Adding one: copy the six headings from an existing file, keep Changes under fifteen lines, and add a row here.
