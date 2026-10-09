# Hypotheses

Circulating claims that are not yet `[EST]`. Each carries an evidence ledger. A hypothesis leaves this file when it is established (moves to the doc that owns the topic) or refuted (stays here, marked refuted, with the source). Not decision inputs until established.

## H-1: the overworld renders wrong tiles in area 4 at (30-31, 23-24)

Status: `[OPEN]`, unverified.

Claim: overworld map area 4 renders the tiles at viewport positions (30,23), (31,23), (30,24) and (31,24) with the wrong tiles and the wrong palette. `[OPEN]`

Live thread: whether `PrepareGraphicsFile($14)` is missed in `loadVram` for the object graphics list of tileset $15. Read but not ruled out when the investigating session ran out of context. `[OPEN]`

| Evidence | Says | Source | Date |
| --- | --- | --- | --- |
| The `charBytePair` layout offset is not the cause | unresolved `[OPEN]` | source not recovered | not recorded |
| The `Map16Pointers` loop range (512 iterations, indices 0-255) is correct | unresolved `[OPEN]` | source not recovered | not recorded |
| The `map16ByteOffset` formula (`OW_TilePos_Calc`) is correct | unresolved `[OPEN]` | source not recovered | not recorded |
| The `blitChar` and `decodeTilemapWord` pixel render path is not the cause | unresolved `[OPEN]` | source not recovered | not recorded |
| The tile coordinates shown by the inspector UI are correct | unresolved `[OPEN]` | source not recovered | not recorded |
| `OBJECTGFXLIST` for tileset $15 may need `PrepareGraphicsFile($14)` that `loadVram` skips | open thread `[OPEN]` | investigating session, worktree notes | not recorded |

What would resolve it: a Mesen capture of area 4 compared against the editor's render at those tiles, with the disassembly line that writes them.
