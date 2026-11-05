Ruled 2026-11-04 (Brian)

# Map view gutter: far end only, one screen wide (#1228)

## Question

D48 part 2 and R24 gave the map view a gutter of half a screen at each long end of a map, with the back color fading out over it. Does the gutter belong before position 0, and how wide is it?

## Options considered

1. Keep a half-screen gutter at both long ends (D48 part 2, R24).
2. A gutter at the far end only (right of a horizontal map, bottom of a vertical one), half a screen wide.
3. A gutter at the far end only, one screen wide.

## Ruling

Option 3. The owner, 2026-11-04, in #1228: "I don't want any gutter to the left of the map, only to the right for the purpose of leaving space to add more map to the right. adding to the left would be problematic as position (0,0) would have to move and shift all tiles to the right".

On width (R41): "I think "the gutter" should be 1 screen wide."

On vertical maps: "the purpose of the "gutter" is it will allow a user to add tiles to extend the map. but, we can't extend the map to negative "x" coordinates." and "remove the gutter such that a user can't add tiles at a negative X coordinate".

Recorded as R36 (the first and the vertical quotes) and R41 (the width), both 2026-11-04, direct to Planning. The plan was gated and ruled as D172 (agreed with the recommendation). R41 also asks that the background layers extend through the gutter and fade; that is #1197 and is not part of this change. This replaces the left half of D48 part 2 and R24 ("half a screen of width to the left and right of a horizontal map").

## Why

- Adding screens only ever extends the map past its far end, so the gutter exists to hold the add-screen control there (#26, #950). A gutter before position 0 would invite growth that would move (0,0) and shift every tile. [EST: the owner's words above]
- The map view puts a vertical map's position 0 at the top and stacks screens downward (`map-view-widget.tsx:1094-1095`), so the same rule gives a vertical map a bottom gutter and no top one. [EST: the code at this commit]
- A map of 32 screens cannot grow: the header's screen-count field is 5 bits (`bank_05.asm:527-528`, `rom/map-data-mechanics.md` section 1), so it has no gutter. A map of 31 has the full 256 px. [EST: SMWDisX, as cited]
- Off-map content is not a gutter. A sprite or mark the data places before position 0 still draws there (D76 call 2, D145) and the canvas grows by that content alone, as a solid band with no fade. [INF: from D76 call 2 and D145, which say the canvas follows the data]

## Applies to

`GUTTER_PX` (now 256), `MAX_SCREENS` and `farGutter` in `src/rom/model/MapGutter.ts`; `offMapPad` and `fadeMask` in `theia/extension/src/browser/off-map-extent.ts`; the fade and checkerboard rects in `map-view-widget.tsx`; `architecture/theia-shell.md`, section The map strip's pad. Narrows `2026-10-19-map-view-gutter-details.md`, whose options 1 to 3 assumed a gutter at both ends.
