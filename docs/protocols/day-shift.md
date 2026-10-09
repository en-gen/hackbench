# day-shift

## Purpose

Normal operation, stated explicitly so night shift has something to override.

## Group

shift (default)

## Activation

The owner, in chat, with the BA running the command; or the scheduled return the BA sets when night shift begins. Active whenever no other member of the shift group is.

## Changes

1. Plan gate: a tech lead posts each item's plan (brief, agents with roles and models, expected size, merge policy) and waits for the owner's approval before implementing.
2. Questions and design calls go to the BA, which answers from the knowledge base or escalates to the owner.
3. After a merge the tech lead clears itself, then waits for the plan gate on its next item.

## Unchanged

Everything in `CLAUDE.md` and the role manuals in `docs/agents/`.

## Exit

Activating `night-shift` replaces it. Nothing made under day shift is `[PROP]` by virtue of the mode.
