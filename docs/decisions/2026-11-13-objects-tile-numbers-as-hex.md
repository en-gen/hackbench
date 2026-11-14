Proposed 2026-11-13 (Bravo)

# Objects shows tile numbers as $hex, as the Map16 editor does

## Question

How does the Objects activity write a Map16 tile number in its lists and tooltips? ([#1236](https://github.com/en-gen/hackbench/issues/1236))

## Options considered

A. Plain decimal ("Tile 258").
B. `$hex` through `formatCharNum` ("Tile $102"), the same as the Map16 editor.

## Ruling

wording not recorded. 2026-11-13: option B, built in #1236 after the adversarial review, as [PROP]. It is not an owner ruling. [INF]

## Why

- The Map16 editor labels a tile "Tile $102" (`map16-tile-editor.tsx:145`), so the two views agree and a user can match a tile across them. [EST] Read in the source.
- This sits against the UI principle of approachable, not hex. The number is still a label next to the tile picture, never the only description, so it is flagged for the owner. [OPEN] Resolved when the owner rules.
- If overruled for A: switch `formatTileLabel` to decimal and change the Map16 editor too, or accept that the two disagree.

## Applies to

Tile labels and tooltips in the Objects activity (#1236).
Promotion to Ruled is the owner's.
