# Spike 946: an entry map drawn with its sub areas

Not for merge. Branch `spike/946-subarea-layout`. Command palette: "Map: Show With
Sub Areas" (`hackbench.mapView.showWithSubAreas`), run while a map tab is focused.
Code: `src/rom/subAreaLayout.ts` (placement), `mapSubAreas` on `ProjectService`,
`theia/extension/src/browser/map-subareas-widget.tsx` (the read-only canvas).

## How it places a sub area

1. Walk the entry map's screen exits in screen order. The first exit that reaches
   a slot defines that sub area (the route entrance of #945, computed here, not
   built there). Destination and landing entrance come from the same tables the
   exit graph reads (`DATA_05F800` for a secondary exit, else the main entrance).
2. Find the pipe or door on the exit's screen by scanning Layer 1 for the tiles
   the player code tests: `$137/$138` pipe cap (`bank_00.asm:13205-13216`),
   `$13F` side pipe (`bank_00.asm:13177`), `$20` door (`bank_00.asm:12100-12118`).
   A cap with the body tile `$135` under it is a down pipe; one with the body
   over it is an up pipe (`bank_0D.asm:2118-2186`: pipe type 1 starts with the
   cap, type 4 ends with it).
3. Down pipe: sub area below. Up pipe: above. Door or side pipe: beside, right.
   The landing column (below, above) or row (beside) is shifted to line up with
   the exit. A 32 px gap separates the maps. A faint dashed line joins the two.
4. Cross-check: the landing entrance has an action type (`DATA_05FE00` bits 0-2,
   or `DATA_05F200` bits 3-5 for a main entrance, `bank_05.asm:7155-7161,
   7309-7322`). 3 means it emerges upward (came down a pipe), 4 downward, 1 and 2
   from a side pipe, 0 walks out (`bank_00.asm:4987-5044`). When the tile and the
   action disagree the sub area carries a note. With no tile on the screen the
   action alone picks the side, the exit is the screen centre, and the placement
   is marked `heuristic`.

## Levels used (vanilla ROM, one machine)

| Entry map | Sub area | Kind | Basis | Offset (x, y) |
| --- | --- | --- | --- | --- |
| `$00B` screen 7 | `$0E1` | below | pipe tile, action agrees | 1864, 464 |
| `$00B` screen 7 | `$0E0` | below | same pipe, pushed past `$0E1` | 840, 928 |
| `$0BE` screen 3 | `$0D0` | above | pipe tile, action agrees | -3256, -464 |
| `$107` screen `$0A` | `$1EA` | beside | door tile, action agrees | 2848, 16 |

`$00B` is the confirmed down pipe, `$0BE` the confirmed up pipe, `$107` the
confirmed door (Vanilla Ghost House; `$1EA` is also entered from `$1FB`).

The brief's guesses did not hold: `$106` (Yoshi's Island 2) has its only exit on
screen `$13`, not `$0F`, to `$1CA`, with no pipe or door tile on that screen; the
landing action says it emerges downward, so it is drawn above, marked a guess.
`$022` (Chocolate Island 1) has three exits, all on screen `$13`, none on a tile
the scan knows; all three are guesses.

## What did not work or is not solved

- An exit belongs to a whole screen. With two pipes or doors on it, the first in
  reading order is used and a note says how many there were. Several exits on one
  screen (as `$00B`) share one pipe.
- Overlap: sub areas on the same side are pushed further out until they do not
  overlap. Nothing else is done; the pushed ones no longer line up with the
  connector's natural run and can sit far away (`$0BE` puts `$0D0` 3256 px left).
- Loops back into the entry map are noted and not drawn. Depth is 1.
- A sub area shared with another level is drawn once and noted ("Also entered
  from ..."); its placement is only right for the entry map shown.
- Which way a side pipe opens is not decoded; it is always placed to the right.
- Some exits are not a pipe or door tile at all (`$106`, `$022`): the scan finds
  nothing and the placement is a guess from the entrance action.
- Not checked: hacked ROMs, Layer 2 exits, sprites (not drawn in the combined view).
