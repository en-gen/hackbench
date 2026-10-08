# night-shift

## Purpose

Unattended work through the night from the Ready column, with every judgment call recorded for the owner's morning ruling.

## Group

shift

## Activation

The owner, in chat, naming the return time; the BA runs the command and creates the scheduled return to `day-shift`.

## Changes

1. Plan gate waived: a BA assignment is approval.
2. A non-safety question takes the recommended option, marked `[PROP]`, and is filed in `docs/decisions/` as Proposed. A safety decision (see `docs/agents/tech-lead.md`) stops the item.
3. After a merge the tech lead clears itself and asks the BA "what's next" without waiting.
4. The queue is the Ready column of the board, top down; items labelled needs-owner are skipped.
5. A scope change ends the item: the handoff records the question as a Proposed decision and the next item starts.
6. A needs-owner PR opens with its label and waits; the launched build URL goes in the handoff. Only auto-merge items complete unattended.
7. Tech leads run in auto permission mode so a self-clear does not block on a prompt.
8. An empty queue means idle: write the state file, post one line to the BA, wait for the nudge.

## Unchanged

The deliverable loop (simplify, adversarial review, verify, ship), the auto-merge and needs-owner rules, CodeRabbit handling, the content and style gates, the data and image rules, and every "never" in `CLAUDE.md`.

## Exit

`day-shift` returns by command or by the scheduled return. Every `[PROP]` made overnight stays `[PROP]` until the owner rules. The BA produces the morning brief (`docs/runbooks/morning-brief.md`). A night waiver is never precedent.
