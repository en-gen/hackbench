# Spike 946: the selected map with its neighbours as cards

Not for merge. Command palette "Map: Show Neighbours"
(`hackbench.mapView.showWithSubAreas`), run while a map tab is focused.
Code: `src/rom/subAreaLayout.ts`, `mapSubAreas` on `ProjectService`, `map-subareas-widget.tsx`.

## Owner's pick
The owner chose thumbnail cards over full-size sub areas (which pushed `$0D0` 3256 px
away): a card is always 160 x 96 and neighbours on one side only nudge along it.

## The card spec

1. A neighbour is a fixed 160 x 96 card: the map letterboxed, its Maps tree name and `$0E1 · 3 scr`.
2. Placement by link direction, with a gap: below for a down pipe, above for an up
   pipe, right for a door or side pipe. Centred on its link point; same-side cards nudged apart.
3. Each link is a thin grey dashed line with a dot at both ends: one on the pipe or
   door of the full-size selected map, one on the scaled position inside the card.
   Hovering a link or its card (CSS classes, no re-render) makes it solid, blue, thick.
4. A room with a return (its exit leads back to a different entrance) is one card
   with two links, centred on their midpoint. `$0BE` / `$0D0` is one.
5. Inbound neighbours: maps whose exits lead into the selected map, from the exit
   graph. The side is the reverse of the origin's own pipe: you came down a pipe, so
   the origin sits above (`$0E1` shows `$00B` above). An origin that is also an
   outbound neighbour merges into the same card. An origin the overworld enters
   directly (as `$00B`) counts here, though it is not a sub area going out.
6. Clicking a card selects its Maps tree node (`selectSlot`); the tree opens the map
   and the view re-targets on `onMapOpened`.

## How a link is found

The exit's screen is scanned for the tile the player code tests (pipe cap
`$137/$138`, `bank_00.asm:13205-13216`; side pipe `$13F`, `bank_00.asm:13177`; door
`$20`, `bank_00.asm:12100-12118`); a cap with body `$135` under it is a down pipe, over
it an up pipe (`bank_0D.asm:2118-2186`). The landing's action type (`bank_05.asm:7155-7161,
7309-7322`) cross-checks, and alone picks the side when no tile is found (`heuristic`).

Vanilla ROM, one machine: `$00B` down pipe to `$0E1`/`$0E0`; `$0BE` up pipe to `$0D0`;
`$107` door to `$1EA`; `$022`, `$106` are guesses.

## Not solved

- Several pipes or doors on one screen: the first in reading order, with a note.
- A side pipe always opens right. Depth 1; hacked ROMs, Layer 2 exits, sprites
  unchecked. Inbound needs the overworld-rooted exit graph.
