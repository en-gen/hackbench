# Reading the overworld by following the render pipeline

Status: proposal. Drafted 2026-09-17.

How HackBench should read the overworld: by reproducing the scene the PPU
composes, reading each table at the point the game reads it.

## The mistake this replaces

Our overworld code models a **per-area L3 mask**: data, indexed by area,
returning a rectangle of border thickness. The game has no such thing.

It loads one stripe image into BG3 once at overworld entry, and zeroes
`HW_BG3HOFS` / `HW_BG3VOFS` every NMI (bank_00.asm:338-341). The frame is
fixed in screen space while BG1 and BG2 scroll underneath it. That is a
rendering fact. No amount of table-hunting finds it, because it is not
expressed as data anywhere.

Having invented the abstraction, we then filled it with guesses, and the
guesses disagree with each other and with the ROM:

| Where                                    | Claims                                                   | ROM                                                        |
| ---------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| `l3MaskForArea` (OverworldLoader.ts:583) | top 4 or 5, bottom 2, left 2, right 2; `null` for area 0 | uniform top 6, bottom 3, left 3, right 3, including area 0 |
| comment at OverworldLoader.ts:503        | 32x21 window                                             | 26x19                                                      |
| `OW_SUBAREA_TILES_H` (line 550)          | 28                                                       | 19                                                         |
| `heightTiles` (line 402)                 | 32                                                       | 19                                                         |

The `isTopRow` branch keyed on `cameraY < 0` has no basis in ROM data at all.

The window was readable the whole time: `OWBorderStripe` at `$04A400`
(bank_04.asm:3526), a stripe image decoding to an exact rectangle of screen
tile rows 6-24, cols 3-28.

## The principle

**The disassembly is the specification. The ROM is the data.**

Romhacks edit data far more often than code, so the pipeline the disassembly
describes is reliable. What moves is where the data lives.

Therefore: **hardcode the location of a pointer, never the value it resolves
to.** Read each address from the instruction operand the game reads it from.

We already violate this. `OW_ADDR.L2_STREAM_LO = 0x04A533` and
`L2_STREAM_HI = 0x04C02B` are resolved values. All four hacked ROMs in the
corpus repoint those streams by rewriting the immediate operands in
`CODE_04DC6A`; the routine is structurally identical, the data moved. Our
loader would read vanilla terrain on every one of them and render it with no
indication anything was wrong.

The codebase already knows the technique in one place:
`OW_ADDR.TITLE_LEVEL_LDA_OPERAND = 0x0096CC` is the address of an operand,
not a resolved target. That is the pattern; it should be the default.

## The pipeline

Each stage names what the game does, and therefore what we read.

| Stage           | Mechanism                                                                                                                  | Cite                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Choose layout   | `layout = (OWPlayerSubmap == 0) ? 0 : 1`. A hardcoded `BEQ`, not a table. Patches the DMA source high byte `$40` -> `$60`. | bank_00.asm:4792-4818; bank_04.asm:5219-5222          |
| BG2 tilemap     | Twin-stream RLE decompressed into `OWLayer2Tilemap` (`$7F4000`), output limit `$4000` = exactly 2 x `$2000`                | bank_04.asm:5683; limit at 5691-5694; rammap.asm:2124 |
| BG1 Map16       | `OWL1TileData`, `$0800` bytes = 2 x 1024 cells; same `submap == 0` split; `+$0400` on the tile index for sub-maps          | bank_04.asm:5673-5677, 2692-2698                      |
| VRAM / GFX      | `ObjectTileset` from `DATA_04DC02` -> `OBJECTGFXLIST` -> GFX files into slots                                              | bank_04.asm:5634. **Not yet traced by us.**           |
| CGRAM           | `ObjectTileset & $0F` minus 1 -> `DATA_00AD1E` -> palette block offset                                                     | bank_00.asm:5744-5747                                 |
| BG3 frame       | `OWBorderStripe` (`$04A400`) loaded once; scroll registers zeroed every NMI                                                | bank_04.asm:3526; bank_00.asm:4339-4341, 338-341      |
| Camera          | `DATA_00A06B` / `DATA_00A079` on the load path, `DATA_049A0C` on the warp path (a duplicate that must be edited in step)   | bank_00.asm:4322-4331; bank_04.asm:2904-2911          |
| Main-map scroll | Not fixed: clamped by `OWScrollLowerBound` / `OWScrollUpperBound`. Sub-maps return early, so their camera never moves.     | bank_04.asm:2111-2116, 2636-2658                      |

## What follows from it

**An area is not a partition. It is a camera position over a layout.** There
are exactly two 64x64 layouts and nothing else. So the viewer renders each
layout whole, and a "sub-map" becomes an annotation: camera origin plus the
26x19 window, both read from ROM.

**`OW_AREA_COUNT = 7` is a data convention, not an engine limit.** No bounds
check exists on the submap value anywhere. The only mask in the engine is
`AND #$000F` on the star-warp path (bank_04.asm:577-581). The tables are seven
entries because the next label begins there, which is a fact about vanilla's
data, not about the game.

**The derived sub-map rectangles are disjoint in vanilla.** That is a property
worth asserting in a test, not an invariant to build on.

## Scope for the first release

The first release targets people creating new romhacks, who start from a stock
ROM. So the acceptance target is vanilla only. The other corpus ROMs are used
to prove the reader fails honestly, not to pin numbers.

That does not license hardcoding resolved addresses. Following the operand
costs the same as not following it, and it is the difference between
"unsupported" and "confidently wrong".

## Open questions

1. The GFX and CGRAM path (`OBJECTGFXLIST`, tileset `$15`) is the one stage we
   have never traced. The unexplained half of the area-4 symptom is a palette
   error, which points here rather than at buffer addressing.
2. Does the same invented-abstraction problem exist in the level renderer? The
   draw order recorded in project notes ("L2, L1 non-priority, sprites, L1
   priority") is a rule someone wrote down, not a traced pipeline.
3. Round-trip identity (read a structure, write it back unchanged, compare
   bytes) would prove the read model is complete rather than merely plausible.
   Nothing in the project does this today.

## What this is not

Not an emulator, and not an ASM interpreter. We follow the pipeline to learn
which table is read, from where, and with what index. Then we read the table.
