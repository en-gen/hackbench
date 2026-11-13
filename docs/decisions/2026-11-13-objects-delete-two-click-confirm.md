Proposed 2026-11-13 (Bravo)

# Deleting an Object takes two clicks, not a dialog

## Question

How does the Objects activity confirm deleting a saved Object: a dialog, or a second click on the same button? ([#1236](https://github.com/en-gen/hackbench/issues/1236))

## Options considered

A. A confirm dialog.
B. The Delete button turns into "Confirm delete" and the second click deletes.
C. Delete at once, no confirm.

## Ruling

wording not recorded. 2026-11-13: option B, built in #1236 by the Bravo team, as [PROP]. It is not an owner ruling. [INF]

## Why

- A delete removes the project's only copy of a definition, and nothing undoes it (definitions are not patch layers). One more click is cheap protection. [INF]
- A second click stays inside the panel and is a plain button for the Playwright spec to press; a dialog is a separate surface. [INF]
- If overruled for A: swap the button for the shell's confirm dialog and change the spec step.

## Applies to

The Delete button in the Objects activity (#1236).
Promotion to Ruled is the owner's.
