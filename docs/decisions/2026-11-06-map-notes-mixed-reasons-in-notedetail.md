Proposed 2026-11-06 (Tech lead)

# Different reasons on one noun go in noteDetail

## Question

Two spawners of one noun lose children for different reasons. Does the map note join the reasons, or carry one total?

## Options considered

A. Join the reasons in the note with `; `.
B. One total in the note, with both reasons in `noteDetail`.

## Ruling

wording not recorded. 2026-11-06: night-shift call by the tech lead, awaiting the owner's ruling; option B is what [PR #1300](https://github.com/en-gen/hackbench/pull/1300) built (merged at 60409468), as [PROP]. It is not an owner ruling. [INF]

## Why

- B is the shape #1256 set: the note stays one short sentence and the detail sits under it. The note reads `N Eeries did not draw.`, and the reasons sit in `noteDetail`, joined by newline.
- A would grow the note with each new reason and put two causes in one sentence.
- If overruled for A: the join moves from `noteDetail` into the note text, and the note tests change to match.

## Applies to

Map notes where one noun has more than one reason for undrawn children ([#1281](https://github.com/en-gen/hackbench/issues/1281)). Promotion to Ruled is the owner's.
