# Spike 946: the selected map with its neighbours as cards

Not for merge. Command palette "Map: Show Neighbours"
(`hackbench.mapView.showWithSubAreas`), run while a map tab is focused.
Code: `src/rom/subAreaLayout.ts`, `mapSubAreas` on `ProjectService`, `map-subareas-widget.tsx`.

## Owner's pick
The owner chose thumbnail cards over full-size sub areas (which pushed `$0D0` 3256 px
away): a card is always 160 x 96 and neighbours on one side only nudge along it.

## The card spec

1. A neighbour is a fixed 160 x 96 card: the map letterboxed, its Maps tree name and `$0E1, 3 scr`.
2. Placement by link direction, with a gap: below for a down pipe, above for an up
   pipe, right for a door or side pipe. Centred on its link point; same-side cards nudged apart.
3. Each link is a thin grey dashed arrow: a filled circle at its start, an arrowhead at
   its end (see Direction below).
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

The exit slot is the exit object's own 5-bit field (byte 0 & $1F), not the stream screen
it sits on: the game files it as `ExitTableLow[b0 & $1F]` (`CODE_0DA512`,
`bank_0D.asm:1428-1432`), a later object with the same field replaces the earlier, and
Mario's X (Y when vertical) high byte picks the entry (`bank_05.asm:7095-7101`). Round 1
used the stream screen, which is why `$00B` showed one pipe linked to two sub areas and
the other to none (vanilla: both exit objects are on stream screen 7, fields 3 and 7).
`LevelParser` does not expose the field, so the spike reads `raw[streamOffset] & $1F`
itself; it is labelled `SPIKE WORKAROUND` in `src/rom/subAreaLayout.ts` and belongs in the
parser if this ships (PR #947 bug draft).

On that screen every enterable pipe or door is collected (`findEnterables`; tiles, pages
and conditions in [../rom/enterable-pipes-and-doors.md](../rom/enterable-pipes-and-doors.md)).
The line is drawn from the first; more than one gives the note "N pipes or doors on
screen $X all lead to this exit". With none the line starts at the screen centre, marked
`heuristic`, with a note, and the side comes from the landing's action type
(`bank_05.asm:7155-7161, 7309-7322`). A cap with body `$135` under it is a down pipe, over
it an up pipe (`bank_0D.asm:2118-2186`).

## Direction

Each link is `exit` (from this map's pipe or door to the landing in the card) or `return`
(from the card map's exit pipe or door to this map's landing). The line has a filled circle
at `from` only and an arrowhead at `to`. Circle at start, arrow at end is the BA's reading,
for the owner to confirm. An exit and a return that leave this map from the same point are
drawn a few pixels apart, perpendicular, so they read as two lines. The Playwright hooks
are `data-dir`, `data-from`, `data-to` on each link group.

## Cards

One card per destination slot. An exit that is not a card is a note naming the slot and
why: the overworld enters that map (a way out), it leads back into this map, nothing is
stored there, or the map cannot be read. `$0E0` and `$0E1` exit to `$0DF`, a boss arena:
the game never loads its L1, so the note reads "Map $0DF is a boss arena: the game never
loads its L1 (foreground)".

Vanilla ROM, one machine, from the unit run on 2026-10-16:

| Map | Exits | Cards | Notes |
| --- | --- | --- | --- |
| `$00B` | 2: `$0E1` (side pipe, screen 3), `$0E0` (down pipe, screen 7) | 2 | none |
| `$0E1` | 1: `$0DF` | 1 (`$00B`, return, left) | `$0DF` boss arena, no card |
| `$0E0` | 1: `$0DF` | 1 (`$00B`, return, above) | `$0DF` boss arena, no card |
| `$0BE` | 1: `$0D0` (up pipe) | 5: `$0D0` (exit and return), returns from `$022`, `$0F6`, `$0F5`, `$0D1` | pipe vs action side note |
| `$0D0` | 3: `$0F6`, `$0BE`, `$0F5` (screens 6, 15, 16) | 3 | pipe vs action side note |
| `$022` | 3: `$0F6`, `$0BE`, `$0F5` (screens 6, 15, 16) | 3 | pipe vs action side note |
| `$107` | 1: `$1EA` (door, screen `$0A`) | 1 | none |
| `$1EA` | 2: `$1FB`, `$1F9` | 3 (`$1FB` exit and return, `$1F9`, `$107` return) | 2 doors on screen `$07`; P-switch doors flagged |
| `$106` | 1: `$1CA` | 1 | pipe vs action side note |

## Removed as bullets

The old dot at BOTH ends of a link (now one circle, at the start only); the notes `<ul>`
list bullets (now plain lines); the middle dot in the card caption (`$0E1 · 3 scr`, now
`$0E1, 3 scr`). The map view's own header and menu labels use a middle dot as a
separator; those belong to the merged map view and were left alone.

## Not solved

- With several pipes or doors on one screen only the first is joined; the rest are in
  the note.
- A side pipe always opens right. Depth 1; hacked ROMs, Layer 2 exits, sprites
  unchecked. Inbound needs the overworld-rooted exit graph.
