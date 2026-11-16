Proposed 2026-11-13 (Bravo)

# The Object writer refuses reserved Windows file names

## Question

May an Object be saved under an id such as `con` or `lpt1`, which Windows cannot make a file of? ([#1236](https://github.com/en-gen/hackbench/issues/1236))

## Options considered

A. Allow it; the file system will fail the write.
B. The writer refuses ids `con`, `prn`, `aux`, `nul`, `com1` to `com9` and `lpt1` to `lpt9`, in any case; a reader still loads such a file.

## Ruling

wording not recorded. 2026-11-13: option B, added in #1236 after the adversarial review, as [PROP]. It is not an owner ruling. [INF]

## Why

- On Windows `con.json` opens the console, not a file, so a save under that id would fail or misbehave. Ids are generated (eight hex characters) so this only guards a hand-made or hostile id. [INF]
- It is a writer-only rule so the reader contract sent to #1237 stays as written. A reader never refuses a file for it, and such a file cannot exist on Windows anyway. [INF]
- If overruled for A: drop `isWritableId`, and a refused write comes back as a plain input/output error.

## Applies to

`saveObjectDefinition` and the writer rules in `docs/architecture/object-definitions.md`. Not readers.
Promotion to Ruled is the owner's.
