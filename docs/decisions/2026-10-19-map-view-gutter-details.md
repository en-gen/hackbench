Proposed 2026-10-19 (map view, #1004, #1005)

# Map view gutter details (#1004)

## Question

PR #1032 gave the map view a canvas that extends past the map, with a gutter at each long end, and drew off-map marks and sprites where the data puts them (#1004, ghost-house sign #1016). The owner rulings left details open: how a content band looks, what the fade ends on, whether the grid and map edge show, how room for off-map content is sized, and what a mark's issue count means (#1005). What was chosen for each?

## Options considered

1. Content band on a short side (for example below a horizontal map). (a) Fade it like a gutter. (b) Keep it solid.
2. What the gutter fade ends on. (a) The hidden-layer checkerboard. (b) The panel background.
3. Grid across the gutters. (a) Stop at the map edge. (b) Continue.
4. Map edge. (a) No marker. (b) A subtle 1 px line.
5. How content growth is sized. (a) From opaque pixels. (b) From each sprite's drawn box (its parts' extent), rounded up to whole 16 px tiles.
6. Growth band while sprites are hidden. (a) Drop it. (b) Keep it.
7. Issue count on a mark (#1005). (a) A count of every change in the object. (b) The number of places in the object's drawing code that HackBench checked and found changed.

## Ruling

wording not recorded. The BA accepted these as defaults for #1032; the owner may adjust them at review. `[INF]` Not ruled as calls; owner review pending.

1. Option b: a content band on a short side stays solid, with no fade, because it is not a gutter.
2. Option b: the gutter fade ends on the panel background. The checkerboard covers only the map and its content bands.
3. Option b: the grid continues across the gutters.
4. Option b: a subtle 1 px line marks the map's edge.
5. Option b: growth is computed from each sprite's drawn box, rounded up to whole 16 px tiles, not from opaque pixels.
6. Option b: the growth band is kept while sprites are hidden.
7. Option b: a handler stops at its first failed check, so the count can be low.

## Why

1. A fade tells the user "nothing is here, extend the map". A band holding drawn content is part of the picture and must stay readable.
2. The checkerboard means "this layer is hidden". Gutters are empty canvas, not a hidden layer, so they fade to the surrounding panel.
3. The grid is the tile lattice. Continuing it shows where off-map content sits on the same tiles as the map.
4. With the grid and fade running past the map, the user needs one plain cue for where the map ends.
5. A drawn box is stable and cheap. Opaque pixels would change the layout with each animation frame.
6. Toggling sprites would otherwise resize the canvas and move everything under the cursor.
7. A count that overpromised would mislead. The wording says what was checked, so a low count reads as "at least this many".

## Applies to

`docs/architecture/theia-shell.md` (section "The map strip's pad (#1004)"). Refines owner rulings D48 part 2, D145, R24 and D76 (calls 2 and 3), cited there; their text is not repeated here. Issue count semantics apply to the refused-object marks of #1005.
