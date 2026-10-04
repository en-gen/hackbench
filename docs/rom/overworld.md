# Overworld L1 and L2: how the view reads them

The Overworld view (en-gen/hackbench#363) draws half 0 of `Map16TilesLow` over
`OWLayer2Tilemap` as one 512x512 canvas, the hub. Each area (1..N) is its own
tab, a 256x224 camera window over half 1 (see "Area windows" below). This page
holds the ASM trace behind
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

`Map16TilesLow` is two $400 halves. On a submap the tile
position moves up by $400 (bank_04.asm:2692-2698). Area 0 reads half
0, the hub; half 1 (areas 1-6) holds camera windows (`DATA_00A06B`/`DATA_00A079`,
bank_00.asm:4242-4248). The halves are independent layouts in both layers, so
each is drawn as its own 512x512 image. The hub view shows half 0 only.

## Area windows

The game loads one area's tileset and palette at a time and draws the whole
half with them; the L3 border hides the rest (owner decision, #364). So an
area view is that area's camera window over half 1, in that area's own
tileset (`DATA_04DC02[area]`, read through the L1 reader's operand, refused
per area when the byte is not in the ROM) and the palette
`overworldCgram` builds for that tileset.

- The window is 256x224 at the signed camera (`DATA_00A06B[area]`,
  `DATA_00A079[area]`, bank_00.asm:4242-4248), read at the operands the area
  derivation (`src/rom/OverworldAreas.ts`) located, and wraps at 512 on both
  axes: view pixel (x, y) is half-1 pixel ((wx + x) mod 512, (wy + y) mod 512).
  `halfPixel` / `cropWindow` in `src/rom/OverworldWindow.ts` are the one
  place that mapping lives (edits will reuse it, #283).
- A window does not sit on an 8 px cell boundary (camera X -17), so the
  cropped layer carries its priority per pixel (`prioCell` 1) instead of per
  8x8 cell.
- Measured on vanilla (one ROM): cameras are (-17,-40), (-17,128), (-17,296),
  (240,-40), (240,128), (240,296) for areas 1-6.
- An area the derivation marks invalid (past the camera table) keeps its
  explorer row with the reason in its tooltip and opens nothing. A refused
  derivation gives no child rows and the reason on the Overworld row; the hub
  still draws.

## L2 (background)

`OWLayer2Tilemap` is $4000 bytes: two 64x64 layouts of tilemap words, layout 0
for the hub and layout 1 for half 1 (areas 1-6), each drawn under its L1 half
(`tilemapByteOffset`). Layout 1 belongs to half 1 because, on a submap, the
L2 upload's DMA source high byte is `$60` (`LDA #$60 : STA HW_DMAADDR+$11`,
bank_04.asm:5219-5222 and bank_00.asm:4809-4812). `DecompressOverworldL2`
(bank_04.asm:5440), reached by `JSL` at bank_00.asm:3744 and :4301, runs
`CODE_04DC6A` (:5683-5713). That sets the stream pointer to `#OWTileNumbers`
with its bank, and runs the RLE decoder `CODE_04DABA` (:5452-5483) into the
low bytes, then points at `#OWTilemap`, keeping the same bank, for the high
bytes. The decoder stops once a command ends at or past `_E` = $4000
(`CPX _E : BCC`, :5481-5482). It reads through `[_0],Y`, so a stream that
runs off the end of its bank is refused; one that ends exactly on the bank's
last byte is read.

The reader pins both calls, both DMA selects and the opcodes and constant
operands of `CODE_04DC6A`, fingerprints the 53-byte decoder, and reads the two
stream addresses and their bank from the operands. It reads LoROM only. On GPW 1.2, both streams sit in bank $10 with the code intact, and are read
from there (measured on that one ROM of the 6-ROM corpus, 2026-09-28). An L2 that cannot be read leaves L1 drawn alone, with the reason.

`CODE_04DC6A` then runs `CODE_04E453` for each event (:5705-5712), applying
completed events' tile changes before first display. The view draws the
tilemap before any event.

Layers compose in SNES mode 1 order from each word's priority bit: L2 low,
L1 low, L2 high, L1 high (`src/rom/render/OverworldComposite.ts`, run in the
browser so the layer toggles need no round trip). Color 0 is transparent in both, over a backdrop of
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
