Proposed 2026-11-05 (Romeo)

# A user group naming $0C8 loses the row with no note

## Question

Once the wings link places a slot under its holder ([#1229](https://github.com/en-gen/hackbench/issues/1229), [PR #1288](https://github.com/en-gen/hackbench/pull/1288)), that slot is no longer a top-level map. If a user group names it (for example $0C8 grouped while it was still Unassigned), what does the Maps tree show?

## Options considered

A. Show nothing for it in the group and no note. The map stays reachable under its holder.
B. Show a note that the group names a map now listed under another map.

## Ruling

wording not recorded. 2026-11-05: night-shift call by Team Romeo, awaiting a ruling; option A is what #1288 built, as [PROP]. B is not built. It is not ruled. [INF]

## Why

- `applyGroups` resolves a group slot only against top-level maps (`tree.overworld`, `tree.bonus`, non-New `tree.unassigned`). A placed slot is in none of them: `buildMapTree` marks it placed, so the Unassigned sweep skips it. The group row is skipped, not errored.
- `staleSlots` treats `tree.wingsPlaced` as known, so no "grouped slots are not maps" note is raised either. The file keeps the slot.
- The tree-view result differs from a stale slot (e.g. after a ROM swap), which does raise the note. That is the tradeoff: A is quiet and loses a row the user placed; B tells them but repeats text for a map that is not missing.
- Through the app this arises only from a slot already in the file: `admitGroups` refuses to add a slot that is not top-level, unless it was on disk already. A hand edit or a pre-#1229 file is the way in.
- If overruled for B: `staleSlots` stops counting `wingsPlaced` as known for slots a group names, with a note worded for "listed under another map"; one test for it. The folder-empty case in the other Romeo decision would then also raise the note.
- Evidence scope: read from `src/project/MapGroups.ts` and `src/rom/MapTree.ts` at `dab0e963`; no test run for this decision.

## Applies to

`applyGroups` and `staleSlots` for slots in `wingsPlaced` only. Not the wings link or the sub-area listing. Promotion to Ruled is the owner's.
