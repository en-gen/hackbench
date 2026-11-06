Proposed 2026-11-05 (Romeo)

# An older groups.json keeps an empty Yoshi Heaven folder

## Question

Before #1229 the vanilla seed named Yoshi Heaven as a group holding slots $0C8 and $1C8. Since [#1229](https://github.com/en-gen/hackbench/issues/1229) ([PR #1288](https://github.com/en-gen/hackbench/pull/1288)) those slots are sub areas, listed under the map that holds the Yoshi wings, and the seed no longer names them. A `groups.json` written before #1229 still does. What does the app do with that file?

## Options considered

A. Leave the file alone. The Yoshi Heaven folder loads, resolves to nothing and shows empty. No stale note.
B. Migrate the file: drop the two slots, or the whole group, on load.
C. Hide a seeded folder that is empty.

## Ruling

wording not recorded. 2026-11-05: night-shift call by Team Romeo, awaiting a ruling; option A is what #1288 built, as [PROP]. It is not ruled. [INF]

## Why

- `seedIfVanilla` (`src/project/MapGroups.ts`) seeds once and then leaves the file alone: groups belong to the user from their first write onward. A migration (B) would rewrite a file the user may have edited since.
- `staleSlots` counts a slot the wings link placed (`tree.wingsPlaced`, `src/rom/MapTree.ts`) as known, so the folder raises no "grouped slots are not maps" note. The slots are maps, only no longer top-level.
- C needs a rule for which empty folders are seeded ones, and the file does not record that.
- If overruled: B adds a one-time rewrite in the load path plus a test with a pre-#1229 file; C adds a filter in the tree view. Neither touches the tree builder.
- Evidence scope: read from the code on develop at `dab0e963`; the empty folder is not exercised by a test in this decision.

## Applies to

Old `groups.json` files only; a project with no groups file, or one written after #1229, never names the slots. Not the tree builder or the wings link. Promotion to Ruled is the owner's.
