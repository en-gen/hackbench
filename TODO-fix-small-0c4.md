# TODO: map $0c4 remaining diff (4 cells)

## Symptom

`diff_cells.ts 0c4` reports 4 diffs:

```
r=22 c=10  expected=$066  actual=$025
r=22 c=11  expected=$067  actual=$025
r=23 c=10  expected=$068  actual=$025
r=23 c=11  expected=$069  actual=$025
```

## Level contents

Level $0c4: tileset 5, 2 screens.

L1 objects (4 total, all with OK handlers):
- obj=$15 set=$91 pos=(13,15) -> handle_0DB224 (3-col door frame, cols 13/14/15, rows 15-24)
- ext=$49 pos=(0,11)          -> handle_0DEABF (ghost house facade 6-wide x 13-tall, cols 0-5, rows 11-23)
- obj=$32 set=$2f pos=(0,24)  -> handle_0DEF67 (floor, row 24+)
- obj=$32 set=$2f pos=(16,24) -> handle_0DEF67 (floor, row 24+, screen 1)

None of the four handlers writes page-0 tiles $066/$067/$068/$069.

## Investigation findings

- DATA_0DA7E3 = `db $66,$67,$68,$69` (CODE_0DA7E7 handler, ext=$86) writes exactly this 2x2 block.
  But level $0c4 has no ext=$86 object in its L1 stream.

- L2 pointer: 0x06861B (object-stream L2, not preset). L2 bytes begin with `00 00 00 00 00 FF`
  (two objects: ext=0 at (0,0) and ext=0xFF at (0,0)). Neither produces tiles at (10-11, 22-23).
  Running loadL2Objects on the full L2 stream (which spills into adjacent ROM data) also
  produces no tiles at those coordinates.

- All #$66/#$67/#$68/#$69 immediate values in bank_0D.asm for tileset-5 handlers use page-1
  (Sta1To6ePointer) or are in tileset-specific range.

- LevelLoadPos encoding confirmed: CODE_0DA97D resets Y from LevelLoadPos (not the drifted Y),
  so handle_0DEABF col-reset on each row is correct; facade writes cols 0-5 only.

- Fixture was captured by Mesen auto-walker at tick 51. The tiles appear in the very first
  observable tick, ruling out animation or runtime placement.

## Hypothesis

The tiles at (10-11, 22-23) may originate from a source not yet modelled in diff_cells.ts:
possibly sprite/object initialization code that pre-fills certain Map16 slots, or a
tileset-5 level-load hook that diff_cells.ts does not run. Neither has been found in
the bank_0D disassembly after exhaustive search.

## What would help next

1. Add Mesen scripting to log which SNES write instruction (by PC) places the tile IDs
   0x66/0x67/0x68/0x69 at Map16TilesLow offsets corresponding to (r=22, c=10) and (r=23, c=10).
2. Cross-reference that PC with bank_0D.asm to identify the responsible handler.
