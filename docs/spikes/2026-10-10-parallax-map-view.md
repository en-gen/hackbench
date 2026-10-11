# Parallax in the map view: spike findings

Issue #848, owner decision D32 (2026-10-10): "explore if there's a logical way
to do the parallax". An exploration, not a build. No production code changed;
the two probes behind the numbers were throwaway scripts, not committed.

Expected size: 150 to 250 lines (issue #848), raised by the owner's gutter addendum (D32) and the D48 ruling; this doc is 422 lines.

## Ruled 2026-10-10 (Brian), D48

The owner ruled on the three open questions. The recommendations below are
kept as history and marked superseded.

- Parallax: option **C**. Whole-map, scroll-anchored. #503 stands as written;
  #521 stays a separate issue. This overrules the [PROP] B below.
- Editing, verbatim: "There will be no live editing of backgrounds in the map
  editor". In plain words: layer 2 is never clicked or edited in the map
  editor, so no hit-test inversion is needed for it (Q4 and C's "editing must
  invert the shift" no longer apply).
- Gutter, new option **H**, verbatim: "I want half a screen width of gutter on
  each end with ui to add a screen. The background should fade in a gradient to
  the edges". In plain words:
  - 128 map pixels on each end, scaling with zoom.
  - Add-after ships first; add-before is a separate issue.
  - The add control is hidden at 32 screens.
- Prerequisite: C missed the 5 ms budget in Q5 (12 to 16 ms per screen), so C
  carries a renderer-speed prerequisite; #503 is blocked on that work.

## Bottom line

**Superseded by D48 (above): C for parallax, no layer 2 editing, gutter H.**
The text below is the spike's original conclusion, kept as history.

There is a logical way, and it is a **preview camera, not a change to the map
picture**. The map view stays what ruling 5 made it (load-time data, layer 2
at x = 0, tiles 1:1, `docs/decisions/2026-09-24-map-view-rulings.md`). A
draggable 256x224 camera (#521) shows the composed screen for that camera with
layer 2 and layer 3 placed by the game's own rules.

- The rules are small and exact: horizontal layer 2 is locked, 1:1 or 1/2 of
  the camera; vertical is locked, 1:1, 1/2 or 1/32, plus a load-time offset.
  439 of the 488 readable vanilla maps use horizontal 1/2.
- Redrawing the map on every scroll is **not affordable** in the current
  renderer: one 256x224 screen composes in 12 to 16 ms against a 5 ms budget.
  So scroll-anchored parallax (#503) cannot be the first step.
- A one-screen preview on camera drag costs one compose, which is workable.
- Addendum (D32, gutter): under the traced camera clamp the game does not draw
  layer 2 past the foreground, and the layer 3 bound is unmeasured, so a gutter
  holds actions, not background; see the last section.
- Two open items could change numbers, not the shape: the game's vertical
  calibration disagrees with its per-frame rule for rate 1/32 (Q2), and layer 3
  drifts with time, so a still picture needs a stated phase (Q2, Q3).

## Provenance

- Tags: `[EST]` read or measured, `[INF]` inferred (from what is said),
  `[OPEN]` not established, `[PROP]` a proposal for the owner.
- ROM and tables: `Super Mario World (USA).vanilla.sfc`, 524288 bytes, read
  through `SmwRom`, `buildL1Inputs` and `buildL2Inputs` at `origin/develop`
  9f5956e8. Tallies cover the 488 of 512 slots whose layer 1 builds (24 are
  refused: empty or filler). Header-time settings only. Hacks not read.
- Disassembly: SMWDisX, read through `smw-mcp` (`grep_asm`, `get_ram_map`,
  `get_pointer_table`, `get_memo_for_address`) before any raw read. The bank_00
  MEMO for `CODE_00F79D` was read and agrees except at one point (Q2).
- `smw-mcp/docs/query-log.md` does not exist here; nothing was answered by hand.

## Q1. Which camera is the picture drawn for?

A map is wider than one screen, so a parallax picture needs one camera.

- View centre: moves with scroll, so the picture changes while the user only
  looks. At fit zoom nothing scrolls (#521 says the same), so there is no
  camera at all. Rejected. `[INF]`
- Player's start: already the load-time truth. The map view draws the
  level-start relation (`dy`, `L2Model.ts`) and the start is read for every map
  (`readMarioStartPos`, #781). Stable.
- Draggable camera (#521): an explicit camera at any zoom; defaults to the
  start, clamped to the camera's ROM-read range. The only one that answers
  "what does the player see here".

Answer: **default to the start, let the user drag it.** The start camera is
exactly the picture ruling 5 already draws, so the preview opens equal to the
map and diverges only as the camera moves. `[INF]` from ruling 1, the `dy`
comment in `L2Model.ts` and #781. Caveat from the rulings file: force-load
starts are suspect where a map's entrance differs from its main one. `[OPEN]`

## Q2. How the layer 2 and layer 3 scroll rates apply

### Layer 2: the rate rule

Each frame `UpdateScreenPosition` derives layer 2 from layer 1 (SMWDisX
`bank_00.asm:13727-13733` horizontal, `13735-13749` vertical). `[EST]`

| Setting | Horizontal `Layer2XPos`  | Vertical `Layer2YPos`                         |
| ------- | ------------------------ | --------------------------------------------- |
| 0       | unchanged (locked)       | unchanged (locked)                            |
| 1       | `Layer1XPos` (1:1)       | `Layer1YPos` + `BackgroundVertOffset`         |
| 2       | `Layer1XPos` >> 1        | (`Layer1YPos` >> 1) + `BackgroundVertOffset`  |
| 3 or up | same as 2                | (`Layer1YPos` >> 5) + `BackgroundVertOffset`  |

Setting 0 does not pin layer 2 to the screen: the position stays at its seed
and the camera moves over it. Horizontal 1/2 is `L2X = camX / 2`, so at camera
X layer 2 sits `camX / 2` pixels left of where the map view draws it. That
holds for any viewport width. `[INF]` from the table.

### Where the settings come from

Per map, the high nibble of the primary-entrance byte `DATA_05F000[map]`
indexes two tables (`bank_05.asm:7274-7276`): `DATA_05D720` (horizontal,
`:7041`) and `DATA_05D710` (vertical, `:7038`). Only nibbles 0 to 7 carry
non-zero values. No vanilla fallback is needed: read the two bytes. `[EST]`

Vanilla tally, 488 maps, one ROM, header settings only `[EST]`:

- Horizontal: 0 on 3 maps, 1 (1:1) on 46, 2 (1/2) on 439.
- Vertical: 0 on 12 maps, 1 on 93, 2 (1/2) on 88, 3 (1/32) on 295.
- The commonest pair is horizontal 1/2 with vertical 1/32 (295 maps).

### Maps where layer 2 is an object layer

Layer 2 is a foreground there ("layer 2 interactive", `VerticalTable` bit 7,
`bank_00.asm:11736-11738`). Vanilla has 14 such maps, plus 12 non-interactive
maps whose layer 2 is an object stream; the other 462 use a preset image.
All 26 object-layer maps have horizontal 0 or 1 and vertical 0 or 1, so
**the header gives them no parallax**: layer 2 moves with layer 1 or stays put.
The interactive ones are the maps where showing layer 2 offset would be wrong,
because the player collides with it. `[EST]` (tally). Whether scroll commands
move them is `[OPEN]` (next).

### Overrides the header cannot show

Sprite-driven scroll commands zero the header rate at runtime: command 3
clears the vertical setting (`bank_05.asm:4846-4847`), the fast-background
command clears the horizontal one (`:4980-4981`). Such a map shows the header
rate with a note that it is unverified, as #503 already says. Which vanilla
maps run which command is `[OPEN]`; it needs a scroll-sprite scan, and ruling 1
keeps screen behaviour out of the map view anyway.

### Layer 3

Layer 3 has no single rule (`bank_05.asm:5504-5571`, `CODE_05C40C`). `[EST]`

- Tilesets 1 (castle) and 3 (underground), no tide: `L3X = L1X / 2`
  (`:5515-5518`). A parallax rule, like layer 2.
- Other tilesets: `L3X` accumulates a time-driven drift plus layer 1's
  per-frame camera delta 1:1 (`:5556-5568`), and `L3Y = L1Y` (`:5571`). Y is 1:1
  with the camera; X depends on elapsed frames, not only on the camera. A
  non-zero `SpriteLock` skips the drift (`:5522-5523`, branch to `CODE_05C48D`).
- Tide layers (`Layer3TideSetting` non-zero) take a separate path at the top
  of the routine. Not read in detail. `[OPEN]`

So a still picture of layer 3 needs a stated drift phase, and the honest one is
the load-time seed (ruling 1). Layer 3 stays 1:1 in the map, as the issue says.

### The calibration discrepancy

Level entry calibrates `BackgroundVertOffset` so the per-frame vertical rule
reproduces the seeded `Layer2YPos` (`CODE_00A796`, `bank_00.asm:5089-5112`).
Reading that routine, setting 3 or up shifts layer 1's Y by 3 bits there but by
5 bits per frame (`:13735-13749`). The bank_00 MEMO states 5 for both. If the
code reading is right, the 295 rate-3 maps move layer 2 on the first frame by
(camera Y at load) x (1/8 - 1/32) relative to the seed. `[OPEN]` Code reading
only, not run. Settle it with a core trace before #521 draws vertical layer 2
for rate 3.

Citations: `check_citations` on 20, 19 matched, 1 two lines off (the layer 3
`L3Y = L1Y` store, now `:5571`); the corrected set was re-run before commit. `[EST]`

## Q3. The #105 scroll-range indicator

#105 asks for a translucent box showing the range layer 3 will scroll, so the
designer sees what the background does in play. Parallax does not replace it.

- Parallax answers "where is it at this camera"; the indicator answers "how
  far can it go". Layer 3's drift is time-driven (Q2), which a camera cannot
  express, so the box stays the only honest statement of it. `[INF]`
- They do not collide. The box lives in the 1:1 map view, in map pixels, beside
  the other indicators. Parallax lives in the preview.
- Layer 2 object streams already have bounds (`computeL2ScrollRange`, `src/rom/L2Loader.ts`); animated ranges are undecoded (#246).

Answer: **alongside, with parallax only in the preview.** In the preview,
layer 3 is drawn at its load-time phase with the box over it, so the drift is
visible against the camera. `[INF]`

## Q4. Editing: where does a click on layer 2 land

Today nothing in the map view places tiles. The toolbar toggles layers, and the
pointer only feeds hover indicators for block items (`map-view-widget.tsx`,
`updateHover`, `onMouseMove`). `[EST]` (read of the file's pointer handlers.)
So the question is about the future.
If layer 2 is drawn offset, a point in the picture is not the layer 2 cell
under it. With camera `c` and rate `r` the cell is the picture point plus
`c * (1 - r)` horizontally, plus the vertical equivalent. Every hit test, the
hover indicators (placed in map pixels per plane) and any drag handle would
need that inverse. `[INF]`

That is where the 1:1 map earns its keep: one coordinate system. #503 already
says parallax should force off while editing. Answer: **editing stays in the
1:1 view; the preview is read-only**, so the layer 2 cell under a click is never
ambiguous. The recommended option needs no change to the hover code.

## Q5. Redraw cost against the budget

The server sends six planes per screen (`l2Low, l1Low, l2High, l1High, l3Low,
l3High`, `MAP_PLANE_KEYS`). Those canvases are hidden sources (opacity 0). What
the user sees is **one CPU-composited canvas per screen**: `paintComposite` in
`map-view-widget.tsx` calls `composeScreen` (`src/rom/model/ColorMath.ts`),
which walks every pixel, resolves priority between planes, applies color math,
then `putImageData`. `[EST]` (read.) So layer 2 cannot be moved by a CSS transform, as #503 assumed: it is baked into
the screen composite with layer 1's priority and the sub screen math. A shift
means recomposing every visible screen. `[INF]` from that structure.

`composeScreen` alone, one 256x224 screen, synthetic opaque planes (layer 2
full, layer 1 at 40%, the rest sparse), 40 warm iterations after one dropped,
Node v26.3.1 (V8), one machine, 2026-10-10. Not measured: a browser, the
`putImageData` upload, GPU, several screens. `[EST]`

| Case                           | Median  | p90     |
| ------------------------------ | ------- | ------- |
| Main list only, no color math  | 11.8 ms | 13.7 ms |
| Main and sub lists, color math | 16.1 ms | 18.2 ms |

Against the budget (`2026-09-20-theia-idioms-only.md`: 60 fps, 5 ms median input
latency; per-frame repaint of every cell measured 30 fps and 66 ms there) one
screen is 2.4 to 3.2 times the latency figure. A zoomed-out view shows many
screens, so scroll-anchored parallax costs N times that per scroll event. It
misses the budget by roughly an order of magnitude. `[INF]`

`top()` allocates arrays per pixel and `composeScreen` spreads into
`out.set([...])`; a typed-array rewrite with the opaque case first could
plausibly cut the cost severalfold (`[INF]` from the code shape; not tried). The other route is the per-pass canvas spike
(`docs/spikes/per-pass-canvas-spike.md`): GPU-stacked planes make a shift a CSS
change, but base render got 0.92x to 1.81x slower, memory multiplies by pass
count, and CSS stacking does not do CGADSUB color math. `[INF]`

What fits: one preview on camera drag: one compose of a 256x224 window, 12 to 16 ms, run on
pointer-up or throttled while dragging. Over the 5 ms figure, but one-shot, not
per scroll event.

## Options

### A. Keep ruling 5; no parallax

- Pros: nothing to build; one coordinate system. Cons: the player's view stays implicit.
- #503: closed, not done. #521: closed. #105: unaffected.

### B. Preview camera only (#521 rewritten)

A draggable 256x224 camera, default at the start, with an inset or overlay
preview: layer 1, layer 2 by the rate rule, layer 3 at load-time phase, color
math, composed on demand. The map picture is unchanged.

- Pros: honours rulings 1, 2 and 5; one compose per drag; no coordinate
  inverse; works at fit zoom; reuses `composeScreen`.
- Cons: new UI (camera, inset); the preview is read-only; vertical rate 3 waits
  on the calibration item; scroll-command maps carry an unverified note.
- #503: absorbed into #521 and closed (its toggle is dropped). #521: rewritten
  to this scope, with the rate rules in its acceptance. #105: kept, box shown in
  the preview.

### C. Scroll-anchored parallax toggle (#503 as written)

- Pros: smallest UI; no new widget.
- Cons: no camera at fit zoom; recompose per scroll event misses the budget by
  about 10x on many visible screens, so it needs the typed-array rewrite first;
  editing must invert the shift.
- #503: kept, blocked on a renderer-speed issue. #521: kept apart, narrower.

### D. Both, preview first

B now, C later if a faster compose lands and the owner still wants it. Pro: no
dead end. Con: two surfaces that must agree on one rule. #503: open, blocked on
the speed work. #521: built as B.

### Recommendation

**[PROP] B (superseded by D48: the owner chose C).** It is the only option that meets the budget today, keeps ruling 5
intact, and gives "a logical way" a concrete shape: a camera, with every rate
read from the ROM. File a follow-up to settle the vertical calibration with a
core trace before the rate 3 case ships.

## Addendum: a gutter beyond the foreground, and add-screen room

Owner note, D32: the background can extend beyond the foreground; a "gutter"
around the drawn map would leave room to append or prepend a screen.

### G1. Is there layer 2 or layer 3 past the foreground?

The game's camera is clamped to the level, so it never shows any. Horizontal
camera X is clamped to 0 at the left, and at the right to `(LastScreenHoriz - 1)
<< 8`, the left edge of the last screen (SMWDisX `bank_00.asm:13679-13691`).
`[EST]` (code reading, not run.) At horizontal rate 1/2 layer 2 only ever shows
camera X / 2 up to that plus 256, which is inside the map; at 1:1 it ends at the
last screen's edge. Layer 2 is not drawn past either end under the traced
camera clamp. `[INF]` Layer 3 adds a time-driven drift on other tilesets when
SpriteLock is clear, so its bound with a nonzero drift phase is unmeasured.
`[OPEN]`

What the data holds, per kind of layer 2 `[EST]` (code reading, vanilla, one ROM):

- Preset image (462 of 488 maps): a 32-column Map16 grid, 512 px wide
  (`L2_TILEMAP_COLS`, `L2Loader.ts`), tiled across the map by
  `tilePresetGrid` (`c % 32`). BG2 is a 64x64 tilemap, so it wraps every 512 px
  (`bank_00.asm:1270-1271`; "Layer 2 stride and wrap" in
  `docs/rom/map-data-mechanics.md`). More columns would be
  the same 512 px repeating: the wrap, shown where the game never looks.
- Object stream (26 maps): a grid exactly as wide as layer 1, from layer 1's
  screen count (`loadL2Objects`; the game reuses `LevelScrLength`). Past the
  last screen there is no data; a picture there is invented (ruling 1).
- Layer 3: not read per map for this addendum. `[OPEN]` Same 64x64 wrap
  assumed, extent per map unmeasured.

So drawing past the bounds is a repeat of the wrap (never seen in the game) or
nothing; ruling 2 forbids padding an object grid with guessed tiles. `[INF]`

### G2. What a gutter is, and how it meets zoom

Fit mode fills the cross axis only: `measureFit` divides the view height (width,
for a vertical map) by the map's height (`map-view-widget.tsx`). `ZoomController`
holds the zoom and anchors on the centre or cursor (`zoom-controller.ts`,
`enterFit`, `refit`). So padding on the long axis leaves the fit zoom unchanged;
padding on the cross axis would lower it. `[EST]` (read.) Two shapes:

- Zoom-scaled (map-pixel padding) shrinks to a few pixels at fit and offsets
  every hit test and anchor.
- Fixed: a strip of constant screen pixels (a CSS width) on each end of the
  scroller, outside `.hb-map-view-strip`. Map coordinates stay exact; hover code
  reads the strip's rect (`updateHover`), so it does not move. `[INF]` from the
  code shape, not built.

It shows empty checkerboard (`hb-checkerboard`) with the actions on it, not
layer 2 or 3 (G1).

### G3. Add a screen before or after

What the ROM allows `[EST]` (SMWDisX, header read, vanilla layout):

- The count is the low 5 bits of the first layer 1 header byte, plus one:
  1 to 32 screens (`bank_05.asm:524-529`). Layer 2 object streams use layer 1's
  count, not their own.
- The same count serves both orientations. An even level mode stores it as
  `LastScreenHoriz` (and 1 as `LastScreenVert`); an odd mode swaps them
  (`bank_05.asm:554-561`). So the maximum is 32 for a horizontal map and 32 for
  a vertical one; `!LevelMaxScreens` is 32 too (`bank_00.asm:2652-2653`). The
  gutter hides its add action at 32.
- Whether all 32 are addressable by objects in a vertical map, and whether the
  level data still fits its ROM space, is `[OPEN]`; not read here.

Appending is cheap: raise the count by one; nothing else moves. `[INF]`

Prepending is a rewrite. A new first screen pushes every screen number up by
one: all layer 1 objects, the layer 2 object stream when present, all sprites
(`parseLevelSprites`), the screen exit table
(`parseLevelScreenExits`), and the header count. Pointers in other levels that
land here by screen (entrances, secondary exits) are `[OPEN]`: not traced. A
preset image also slides 256 px against the foreground, half its 512 px period,
so it would no longer match the author's alignment. `[INF]`

An existing issue for adding or removing screens: one `gh search issues` call
returned none, so none is named. `[OPEN]`

### Options

#### E. No gutter; add-screen as commands only

- Pros: no layout cost. Cons: the owner asked for room; the action hides in a
  menu. #503, #521: unchanged by this (fate as in A to D).

#### F. Fixed empty gutter hosting add-screen actions

A constant-width strip at each end of the scroller, outside the strip, empty,
holding "add screen before" and "add screen after". Hidden at 32 screens.
Width: 64 screen pixels per end, constant at every zoom, enough for one button
and a label without covering map content. `[INF]` (a design size, not measured.)

- Pros: honours rulings 1 and 2; no coordinate change; fit zoom unaffected;
  works with B. Cons: the action is an edit and needs its own issue; prepend is
  large; an empty gutter is not the background the owner pictured.
- #503, #521: unaffected; they follow A to D.

#### G. Gutter that draws layer 2 and 3 past the bounds

- Pros: matches the owner's picture literally. Cons: nothing to draw for
  object-stream layer 2 (G1); for a preset it draws a repeat the game never
  shows; recompose per scroll, the cost of C. Breaks ruling 1.
- #503: revived as its prerequisite, blocked on the speed work. #521: unaffected.

#### H. Half-screen zoom-scaled gutter with a fading background (ruled, D48)

The owner's option: 128 map pixels (half a screen) on each end, add-screen UI
in it, and the background fading out in a gradient toward the edges.

- Differs from F: F is 64 constant screen pixels and empty; H is 128 map pixels
  and shows background. Differs from G2's fixed shape: H is the zoom-scaled
  shape, so it is a few pixels at fit zoom and shifts hit tests and anchors by
  128 map pixels.
- Differs from G: G draws layer 2 and 3 past the bounds without limit; H draws
  only 128 px, faded, so the repeat or missing data (G1) is mostly masked.
- Pros: matches the owner's picture. Cons: needs C's scroll-anchored drawing
  and its speed prerequisite; for an object-stream layer 2 there is still no
  data past the end, so the fade must go to empty, not to guessed tiles
  (ruling 2).
- Add-after ships first; add-before is separate (G3). Control hidden at 32.

How they combine with A to D: the gutter is orthogonal. E and F work with any of
A, B, C or D, because neither draws layer 2 or 3. G only makes sense with C or D
(scroll-anchored drawing) and inherits their budget miss (Q5).

### Recommendation

**[PROP] F, with B (superseded by D48: the owner chose H, with C).** Fixed empty gutter, actions only, hidden at 32 screens;
append ships first, prepend as a later issue because it rewrites every screen
reference. The background is not extended: the game never shows it, and the only
data there is a repeat or nothing.

- #521: rewritten to B as proposed; its camera clamp stays the ROM-read range,
  not the gutter. #503: absorbed into #521, as in B; the gutter does not revive
  it.
- New issue to file as part of this recommendation: add screen after, then
  before, with the shift list above as acceptance.

Citations: `check_citations` on 12, all matched. `[EST]`
