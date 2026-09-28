# Overworld L1 and L2: how the view reads them

The Overworld view (en-gen/hackbench#363) draws `Map16TilesLow` over
`OWLayer2Tilemap` in one canvas. This page holds the ASM trace behind
`src/rom/OverworldL1.ts`, `src/rom/OverworldL2.ts` and
`OverworldLoader.overworldCgram`. Line numbers are SMWDisX.

## The tile grid

`CODE_04DC09` (bank_04.asm:5637-5681) is reached from the overworld load
through `JSL CODE_04DC09` (bank_00.asm:4321). It:

- stores `DATA_04DC02[OWPlayerSubmap]` to `ObjectTileset` (:5643-5646) and
  `#$11` to `SpriteTileset` (:5647-5648);
- zeroes `Map16TilesHigh` through `CODE_04D770` (:5654-5658, :5227-5261), so
  a tile index is one byte and only 256 of the 512 pointers are reachable;
- fills `Map16Pointers` with `#OWL1CharData + 8*i` (:5660-5672);
- copies $800 bytes into `Map16TilesLow` with
  `LDA #$07FF : LDX #src : LDY #dest : MVN $7E,srcBank` (:5674-5677).

`Map16Pointers` holds 16-bit addresses. The bank they are read in comes from
the L1 upload routines' `LDY #$0D : LDA ObjectTileset : CMP #$10 : BMI :
LDY #$05 : STY _C` (bank_05.asm:1196-1201, with copies at :1314, :1440 and
:1568, one per scroll direction). All four run, so all four must agree.

The reader pins the opcodes and constant operands, and reads the tileset
table, sprite tileset, char data and tile data addresses from the operands.

## Which half is which

`Map16TilesLow` is two $400 halves. The submap flag selects the half
(bank_04.asm:2692-2698, 5178-5184; bank_05.asm:7206-7212). Area 0 reads half
0, the hub; half 1 (areas 1-6) holds camera windows (`DATA_00A06B`/`DATA_00A079`,
bank_00.asm:4242-4248). Drawing the halves side by side, half 0 on the left,
is a view choice, not a ROM fact.

## L2 (background)

`OWLayer2Tilemap` is $4000 bytes: two 64x64 layouts of tilemap words, layout 0
for the hub and layout 1 for half 1 (areas 1-6), each drawn under its L1 half
(`tilemapByteOffset`). `DecompressOverworldL2` (bank_04.asm:5440), reached by
`JSL` at bank_00.asm:3744, runs `CODE_04DC6A` (:5683-5713). That sets the
stream pointer to `#OWTileNumbers` with its bank, and runs the RLE decoder
`CODE_04DABA` (:5452-5483) into the low bytes, then points at `#OWTilemap`,
keeping the same bank, for the high bytes. The decoder stops when the output
index reaches `_E` = $4000. It reads through `[_0],Y`, so a stream that runs
off the end of its bank is refused.

The reader pins the opcodes and constant operands of both, fingerprints the
53-byte decoder, and reads the two stream addresses and their bank from the
operands. GPW 1.2 moves both streams to bank $10 with the code intact, which
is read. An L2 that cannot be read leaves L1 drawn alone, with the reason.

`CODE_04E453`, run afterwards for each event, applies completed events' tile
changes; the view draws the tilemap before any event.

Layers compose in SNES mode 1 order from each word's priority bit: L2 low,
L1 low, L2 high, L1 high. Color 0 is transparent in both, over a backdrop of
the title screen map's back area color, which is part of the same seed choice
as the CGRAM below.

## The palette

`CODE_00AD25` (bank_00.asm:5736-5790), called at bank_00.asm:4337, writes
four CGRAM blocks with `LoadColors` and clears nothing:

| Source                               | Rows | Cols | Lines     |
| ------------------------------------ | ---- | ---- | --------- |
| `OverworldColors + DATA_00ABDF[pal]` | 4-7  | 1-7  | 5738-5761 |
| `OWStdColors`                        | 2-7  | 9-15 | 5762-5770 |
| `OWStdColors2`                       | 8-15 | 1-7  | 5771-5779 |
| `OverworldHudColors`                 | 0-1  | 8-15 | 5780-5788 |

`pal` is `DATA_00AD1E[(ObjectTileset & $0F) - 1]` (:5743-5747): indexed by
the tileset, not the submap.

The cells outside the four blocks hold whatever CGRAM the previous game mode
left: the title screen map's after boot, the exited level's after a level.
There is no one right answer, so the view CHOOSES the title screen map's
`LoadPalette` result as its seed. That is a view choice, not a ROM fact.

`CODE_00AD25` is 129 bytes, so it is recognized by SHA-256 rather than
committed literally. Its fingerprint fixes every table operand, which is what
lets the table addresses in `OW_ADDR` be read directly. `LoadColors`, the
routine it calls to copy each block, is not fingerprinted: its JSR operand is
fixed, but a hack that rewrites `LoadColors` in place is not detected. GPW2, GPW 1.2 and
Invictus replace `STY _0 : LDA ObjectTileset` at $00AD32 with a JSL, and are
refused.

The GFX files come from `UploadSpriteGFX` (bank_00.asm:4334), which Lunar
Magic's ExGFX hook replaces; a hooked or unreadable GFX loader is refused, as
the hook picks the overworld's files from a list HackBench does not read.
