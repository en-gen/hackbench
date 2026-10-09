Ruled 2026-10-08 (Brian)

# Night shift ends on the owner's word

## Question

Does night shift need a scheduled return time?

## Options considered

1. The owner names a return time and the BA creates a scheduled trigger that enacts `day-shift`.
2. No return time: night shift ends when the owner says so.

## Ruling

Verbatim: "you don't need a scheduled return time. night shift ends when I say it ends"

## Why

The owner's call; the scheduled return was an assumption in the design, never a requirement.

## Applies to

`docs/protocols/night-shift.md` and `day-shift.md` (no scheduled return), `docs/agents/ba.md`, `.claude/skills/protocol/SKILL.md` (step 4 removed), spec section 6.7 (superseded). `--by schedule` in `tools/scripts/protocol.mjs` stays, harmless.
