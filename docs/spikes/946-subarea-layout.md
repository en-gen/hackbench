# Spike 946: the selected map with its neighbours as cards

Not for merge. Branch `spike/946-subarea-layout`. Command palette: "Map: Show
Neighbours" (`hackbench.mapView.showWithSubAreas`), run while a map tab is focused.
Code: `src/rom/subAreaLayout.ts` (neighbours, links, `placeCards`), `mapSubAreas` on
`ProjectService`, `theia/extension/src/browser/map-subareas-widget.tsx` (the view).

## Owner's pick

The first version drew sub areas at full size; the owner chose thumbnail cards. Fixed-size cards end the overlap problem: the full-size view
pushed `$0D0` 3256 px away to clear its neighbours, a card is always 160 x 96 and
neighbours on one side only nudge along that side.

## The card spec

1. A neighbour is a fixed 160 x 96 card: the whole map scaled down and letterboxed
   (aspect kept), its name (the Maps tree label) and `$0E1 · 3 scr`.
2. Placement by link direction, with a gap from the map: below for a down pipe, above
   for an up pipe, beside (right) for a door or side pipe. A card is centred on its
   link point along the map edge; cards on one side are sorted and nudged apart.
3. Each link is a thin grey dashed line with a dot at both ends: one on the pipe or
   door of the full-size selected map, one on the scaled position inside the card.
   Hovering a link or its card makes it solid, blue, thicker, with bigger dots.
4. A room with a return (the map's exit leads to the room's IN, the room's own exit
   leads back to a different entrance) is one card with two links, centred on the
   midpoint of the two points on the selected map. `$0BE` / `$0D0` is one.
5. Inbound neighbours: maps whose exits lead into the selected map, from the exit
   graph. The side is the reverse of the origin's own pipe: you came down a pipe, so
   the origin sits above (`$0E1` shows `$00B` above). An origin that is also an
   outbound neighbour merges into the same card. An origin the overworld enters
   directly (as `$00B`) counts here, though it is not a sub area going out.
6. Clicking a card selects that slot's node in the Maps tree (`selectSlot`), and the
   tree's own selection handler opens the map. The view follows `onMapOpened` and
   re-targets to the new map.

## How a link is found

The exit's screen is scanned for the tile the player code tests (pipe cap
`$137/$138`, `bank_00.asm:13205-13216`; side pipe `$13F`, `bank_00.asm:13177`; door
`$20`, `bank_00.asm:12100-12118`); a cap with body `$135` under it is a down pipe, over
it an up pipe (`bank_0D.asm:2118-2186`). The landing's action type (`bank_05.asm:7155-7161,
7309-7322`) cross-checks, and alone picks the side when no tile is found (`heuristic`).

Levels (vanilla ROM, one machine): `$00B` down pipe to `$0E1`/`$0E0` (below); `$0BE` up
pipe to `$0D0` (above); `$107` door to `$1EA` (beside). `$022`, `$106`: guesses.

## Not solved

- Several pipes or doors on one screen: the first in reading order, with a note.
- A side pipe always opens to the right (its direction is not decoded).
- Depth 1; hacked ROMs, Layer 2 exits, sprites unchecked. Inbound needs the
  overworld-rooted exit graph, so a map nothing reaches lists none.
