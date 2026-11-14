Proposed 2026-11-13 (Bravo)

# Object readers take sets, cap files at 64 KiB and limit ids

## Question

What may a reader of an Object definition file be strict about: list order and repeats, file size, id characters? ([#1236](https://github.com/en-gen/hackbench/issues/1236))

## Options considered

A. Strict: edge and fill must be sorted with no repeats, no size cap, any id the file name allows.
B. Lenient on order and repeats (edge and fill are read as sets), skip a file over 64 KiB, and limit ids to lowercase letters, digits and hyphens, 64 characters at most.

## Ruling

wording not recorded. 2026-11-13: option B, kept by the coordinator when the saved format went to the #1237 team, and built in #1236, as [PROP]. It is not an owner ruling. [INF]

## Why

- Order and repeats in a list are not defects: the meaning is a set. Writers still write them sorted and unique, so a skip for order would reject a hand edit that means the same thing. [INF]
- A real definition holds at most a few hundred tile numbers, so 64 KiB is far above any honest file; the cap stops a huge or hostile file from being read whole. [INF] Tested at exactly 64 KiB (loads) and one byte over (skipped), synthetic files.
- The id is the file name, so it is limited to characters safe on Windows and on case-insensitive file systems (`^[a-z0-9]+(-[a-z0-9]+)*$`, 64 at most). [INF]
- If overruled for A: a reader would skip hand-edited files for order, and the size and id limits would need other guards.

## Applies to

Readers of `meta/objects/<id>.json` (`docs/architecture/object-definitions.md`, reader rules 1 and 4). Writers are unchanged.
Promotion to Ruled is the owner's.
