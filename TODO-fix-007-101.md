# TODO: Remaining diffs in maps $007 and $101

## Fixed in this branch

Two bugs were fixed; see commit log for details:

1. **CODE_0DC259 missing from EXTENDED_HANDLERS** (ext types $4B/$4C) - reduced $007 diffs
   from 156 to 154 (2 diffs).

2. **Off-by-one in handle_0DB49E bottomMergeAddr** - `resolveJmpTarget` was called with
   `base + 34 + 19` (opcode position off by one); corrected to `base + 34 + 18`. This caused
   the pipe-bottom context merge (which blends pipe-meets-rope-end into merged tiles $0D/$0F)
   to always miss. Reduced $101 diffs from 141 to 124 (17 diffs).

## Remaining unfixable diffs

After two fix iterations the residual counts are:
- **$007**: 154 diffs
- **$101**: 124 diffs

All remaining diffs are caused by **WRAM carry-over** from levels rendered before the captured
level in the Mesen Lua walker's death/retry sequence. The Lua walker records Map16 WRAM on the
first frame of level entry; that WRAM already contains tile data written by objects in the
immediately preceding level.

### Slope tiles at rows 11-24, cols 7-15 (both maps)

Both fixtures have slope tiles $073-$085 across a 9-col x 14-row area anchored at
(row=11, col=7). These come from CODE_0DC2E9 (extended type $84), which writes
DATA_0DC26B (126-byte, 14 rows x 9 tiles). Neither $007 nor $101 contains ext=$84 in
its object stream. The preceding level writes them; our clean-grid ObjectExpander starts
empty.

The "skipped" marker ($25) in DATA_0DC26B means some of those cells remain from whichever
level came before the preceding one, making the carry-over stack two levels deep.

### Coin blocks at row 25 (both maps)

Both fixtures have $109 (page-1 tile $09, rendered as a coin/item block) at row 25 in
the same column footprint as the slope tiles. These come from CODE_0DC4C9 (obj $3b),
which writes a two-row strip: row 0 = $09 (page 1), row 1 = $86 (page 0). Neither $007
nor $101 has objNo=$3b at y=24. Carry-over from a preceding level.

### row 24 non-grass tiles (both maps)

The ground rectangle (CODE_0DB1C8) writes $100 (grass) across row 24. But the fixture
has slope/terrain tiles at many cols on row 24 (e.g. $049, $04a, $053, slope tiles
$079/$07a/$083-$085) because the slope carry-over data occupies those cells AFTER the
ground rect, and our expander cannot reproduce that ordering.

### Tile conflicts from level $101's own rope/pipe objects (map $101 only)

Level $101 has ropes (handle_0DB3E3 with X=3: $08/$0b) and pipes
(handle_0DB49E: $0a/$0c) that legitimately write to cols 7-15, rows 14-20. The
fixture has slope carry-over tiles at those same positions. We cannot suppress our
correct object writes to match carry-over state.

## Why these cannot be fixed

`ObjectExpander.expandMap` starts with a clean grid (all $25). Reproducing carry-over
would require:
1. Knowing which level was rendered immediately before the captured level in the walker
   session; and
2. Running `expandMap` for that preceding level and merging its output into the starting
   grid.

This is architecturally out of scope for the current `ObjectExpander` contract
(it models a single level in isolation). If carry-over reproduction becomes a priority,
the right approach is to amend the Mesen walker to capture AFTER the level's own
objects run (e.g., at a tick where LevelLoad has completed but no prior-level state
remains), producing a fixture that matches our clean-grid output.
