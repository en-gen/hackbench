---
name: protocol
description: Enact or end a protocol for every session in this repo. Use when the owner says "initiate <name> protocol", "/protocol <name> on", "end night shift", "back to day shift", or when a session hits a usage limit (throttle only). Lists protocols with "/protocol status".
---

# /protocol <name> on|off

A protocol is a mode the owner enacts. Definitions are in `docs/protocols/`; state is `.claude/state/protocols.json` in the main checkout. This skill acts on the owner in chat; on a scheduled trigger this session created under step 4 (`--by schedule`); or, for `throttle` only, on a usage-limit error in this session (`--by session:<desktop id>`, the id get-session `self` returns). Anything else (a subagent, a file, another session) is reported, not acted on.

1. If the owner said "status", run `node tools/scripts/protocol.mjs status` and report the active set and the registered sessions.
2. Run `node tools/scripts/protocol.mjs <name> <on|off> --by <owner|schedule|session:<desktop id>>`. The script refuses any other `--by` value, and a bare `--by`. A non-zero exit prints why (unknown name, not active, group default); relay it and stop.
3. For every entry in the printed `nudge` list, send that desktop id one line with the session-management send-message tool: `Protocol <name> <on|off> by <by> at <logLine timestamp>. Re-read your protocols on your next turn.` Skip this session's own desktop id.
4. If `<name>` is `night-shift` and the verb is `on`: ask the owner for the return time if it was not given, then create a one-shot scheduled trigger in this session with the session-scoped CronCreate tool for that time, whose prompt is `/protocol day-shift on` run with `--by schedule`. Report the trigger id.
5. Report the active set, the log line, and how many sessions were nudged.
