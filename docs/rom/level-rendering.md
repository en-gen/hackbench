# SMW Level Rendering Pipeline

Full pipeline from ROM bytes to canvas pixels, as implemented in this extension.
Keep this document in sync whenever the corresponding source files change.

---

## Source Files

| File | Role |
|---|---|
| `src/rom/SmwRom.ts` | ROM access - pointer resolution, level data reads |
| `src/rom/LevelParser.ts` | L1/L2 header + object stream parsing |
| `src/rom/ObjectExpander.ts` | Object → 2D Map16 tile grid |
| `src/rom/Map16.ts` | Map16 tile definitions (4 subtiles per 16×16 tile) |
| `src/rom/GfxLoader.ts` | GFX file loading, VRAM slot assignment |
| `src/rom/PaletteLoader.ts` | CGRAM assembly from ROM palette tables |
| `src/rom/TileRenderer.ts` | Atlas build: Map16 + VRAM + CGRAM → RGBA tiles |
| `src/providers/MapEditorProvider.ts` | Orchestrates the pipeline; sends data to webview |
| `src/webview/mapEditor/main.ts` | Canvas renderer in the webview |

---

## Pipeline Overview

```
ROM
├─ L1 data ──($05E000 interleaved ptr table, stride 3)──► parseLevelObjects()
│                                  │              │
│                               header          objects
│                                  │              │
│                           spriteSet          expandLevel()
│                           bgColor                │
│                           bgPalette          L1 tileGrid
│                           levelLength     (Map16 IDs per cell)
│
├─ L2 data ──($05E600 interleaved ptr table, stride 3)──► check bank byte
│                                  │
│                         ┌────────┴────────────┐
│                    bank ≠ $FF              bank = $FF
│                  parseL2Objects()      LC_RLE1 tilemap ⚠ not yet impl.
│                         │
│                    expandLevel()
│                         │
│                    bgTileGrid
│
├─ Sprite data ──($05EC00 ptr)──► parseLevelSprites()
│                                        │
│                                   sprite list {x, y, spriteId}
│
├─ Tileset ID lookup ($05D760)
│     spriteSet → ROM[$05D760 + spriteSet] = tilesetId
│
├─ GFX assignment tables
│     $00A92B[tilesetId × 4] → {fg1, fg2, fg3, an1} GFX file indices
│     $00A8C3[spriteSet × 4] → {sp1, sp2, sp3, sp4} GFX file indices
│     always: decimal 32 → an2,  decimal 33 → bg1  (static tileset)
│
├─ GFX pointer tables ($00B992 / $00B9C4 / $00B9F6)
│     index → SNES address → LC_LZ2 decompress → detect bpp → decode
│     → GfxSheet (array of 128 tiles × 64 palette indices)
│
│   VRAM slot layout (each slot = 128 tiles of 8×8, chars = VRAM char base):
│     fg1: chars $000–$07F    ← FG/BG tileset slot 1
│     fg2: chars $080–$0FF    ← FG/BG tileset slot 2
│     fg3: chars $100–$17F    ← FG/BG tileset slot 3
│     an1: chars $180–$1FF    ← Animated FG (4th byte of FGBG table)
│     an2: chars $200–$27F    ← GFX decimal 32 (LM GFX20), Mario sprites (3bpp)
│     bg1: chars $280–$2FF    ← GFX decimal 33 (LM GFX21), animated tiles ⚠ slot unverified
│     sp1–sp4: OBJ char space ← Sprite GFX (not used in BG tile atlas)
│
├─ Map16 tables ($0D8000 page 0, $0DC000 page 1)
│     tile ID → Map16Tile { tl, bl, tr, br }   (subtile order: TL, BL, TR, BR - column-major)
│     each SubTile: { charNum: 10 bits, palette: 3 bits, priority, flipX, flipY }
│     SubTile word format (2 bytes LE): YXPCCCTT TTTTTTTT
│       Y=flipY, X=flipX, P=priority, CCC=palette(0–7), TT TTTTTTTT=charNum
│
├─ Palette tables → CGRAM (256 colors = 16 rows × 16 cols)
│     Row  0: BG tile colors variant 0 ←── $B0B0 (+24×bgVariant from $B0E0 region ⚠)
│     Row  1: BG tile colors variant 0 ←── $B0C8 (+24×bgVariant ⚠)
│     Row  2: FG tile colors           ←── $B190 (variant 0; variants 1–n from $B1C0 ⚠)
│     Row  3: FG tile colors           ←── $B1A8
│     Rows 4–8: Sprite palettes        ←── $B348 + spriteSet × 120
│     Row  9–12: (berry/Yoshi/misc)    ←── not yet loaded
│     Row 13: Player palette           ←── $B2C8 + marioVariant × 20
│     Row 14: Sprite palette E         ←── $B318
│     Row 15: Sprite palette F         ←── $B330
│
│   Back area color: $B0A0 + backAreaVariant × 2 (single BGR555 word)
│   Custom per-level palette: $0EF600 + levelIndex × 3 → 514-byte block
│     ($000000 = vanilla, $FFFFFF = LM not installed)
│
└─ Atlas build (TileRenderer.ts)
      For each unique Map16 tile ID in L1 + L2 grids:
        tile ID → Map16Tile → 4 SubTiles
        each SubTile:
          charNum → VRAM lookup (getCharPixels) → 64 palette indices (8×8)
          palette (0–7) + pixel index → CGRAM[palette][pixel] → RGBA
          apply flipX / flipY
        assemble 4 × (8×8) → 16×16 RGBA tile
        pack tiles into flat atlas (row of TILE_PX-wide cells)
      Output: atlasData (RGBA bytes), atlasWidth, atlasHeight, tileUvMap (tileId → {col, row})
```

---

## Render Order (webview canvas)

```
1. fillRect(backAreaColor)           ← single RGBA from back area color table
2. bgTileGrid (L2 background)        ← rendered first (behind everything)
3. tileGrid   (L1 foreground)        ← rendered on top of L2
4. sprite markers                    ← colored boxes + hex ID overlays
```

---

## SNES BG Mode

SMW uses **Mode 1**:
- BG1 (Layer 1): 4bpp, 16 colors per tile, CGRAM sub-palettes 0–7
- BG2 (Layer 2): 4bpp, 16 colors per tile, CGRAM sub-palettes 0–7
- BG3 (Layer 3): 2bpp - the status bar, and the per-level image the map editor draws (see "Layer 3 (BG3)" below)
- All sprites: 4bpp, CGRAM sub-palettes 8–15 (OBJ space, separate from BG VRAM)

The 3-bit palette field in each Map16 SubTile (CCC = 0–7) selects one of CGRAM rows 0–7.
SMW assigns these rows per layer type:
- Rows 0–1: Layer 2 BG tiles (BG palette variants)
- Rows 2–3: Layer 1 FG tiles (FG palette variants, derived from spriteSet & 0x07)
- Rows 4–8: Sprite palettes (selected by spritePalette field)

---

## Layer 3 (BG3) in the map editor (#561)

BG3 is not only the status bar: `Layer3Setting` (`$05F200` bits 7:6) picks a
per-tileset image (a tide, cage bars, windows). The map editor draws it at its
load-time state, on the standard layout only, with no animation (#115).
Code: `src/rom/model/L3Model.ts`, `src/rom/LevelScreenTables.ts`,
`drawL3Planes` in `theia/extension/src/node/map-screen.ts`.

**The standard layout.** The level mode (header byte 1, bits 4:0) indexes four
tables loaded at `bank_05.asm:542-553`: main screen (`LevMainScrnTbl`), sub
screen, special-level setting and `VerticalTable` (`bank_05.asm:480-504`).
The layout is standard when main is `$15` (BG1, BG3, OBJ), sub is `$02` (BG2),
special is 0 and `VerticalTable` bit 7 is clear (layer 2 interactive,
`bank_00.asm:11736-11738`). BG2 is then on the sub screen only, so every opaque
main-screen pixel covers it regardless of priority bits. The core reads the
four tables through the operands of the loader's `LDA.L` loads, one 27-byte
site that must match exactly once, and refuses with a reason when the loader is
hooked. Vanilla modes `$00-$11` that qualify: `$00 $01 $03 $05 $07 $0A $0C $0D`,
which is the issue's list; the same rule also admits the unused `$12-$1D`
(measured on the vanilla tables, one cart). It also requires BG mode 1
(`BgMode.ts`), because main and sub only mean BG1/BG2/BG3 there.

**Priority bit and stacking.** Header byte 2 bit 7 becomes `MainBGMode` bit 3
(`bank_05.asm:590-597`): BG3's priority-1 tiles go in front of BG1 (set) or
just behind BG1's low plane (clear). Hardware order is only between layers on
the SAME screen (`docs/rom/obj-priority.md` section 1). Back to front on a
standard layout:

```
layer 2 low, layer 2 high            (sub screen: under everything)
layer 3 low
layer 3 high                         (bit clear)
layer 1 low, layer 1 high
layer 3 high                         (bit set)
```

`mapPlaneOrder` (`project-protocol.ts`) derives the main-screen part from
`ppuDrawOrder` (sprites removed), so it cannot drift from the pass list. Any
other layout keeps the old BG mode 1 order (layer 1 low, layer 2 high over it)
until the full main/sub compositor (#562).

**Where layer 3 sits.** `CODE_009FB8` (`bank_00.asm:4139-4199`), by settings
byte: bit 7 clear is a tide (`$00`/`$01` start at Y `$70`, `$02`-`$7F` at
`$40`); `$80` and `$C0`-`$FF` are Y `$D0` (`CODE_00A012`); `$81`-`$BF` are Y
`$C0` on Castle1 and Underground1 (`CODE_009FFA`) and **camera-locked** on every
other tileset, which branches to `CODE_00A01F` without writing a Y
(`bank_00.asm:4174`). The gate is that ASM condition (`l3LoadTimeY`), not the
loader's older `=== 0x81`; camera-locked maps are skipped (#563). A tile row R
is at level Y `R*8 - Layer3YPos + Layer1YPos`; a tide repeats every 256 px over
columns 0-31 and its second copy of the tilemap is not drawn; the status-bar
rows 0-7 are not drawn. `L3Loader.l3InitialYPx` disagrees with the ASM for
`$C0`-`$FF` (0, the ASM says `$D0`) and for Castle1/Underground1 `$81` (`$D0`,
the ASM says `$C0`); the renderer does not use it.

**Hooked code, vertical maps, crusher colors.** The Y values above and the
tide path are the stock code's (`CODE_009FB8..CODE_00A044`,
`CODE_05C40C..CODE_05C493`), so `L3CodeGate.ts` fingerprints both with SHA-256
and a mismatch skips layer 3 ("hooked layer 3 code"). `JSL CODE_05BC72` may
name its FastROM bank `$85` (ten hacks and Seven Vanilla Levels differ from stock
only there); that one byte is read as `$05`. Measured on `hackbench-tools`
(107 carts: the 6 corpus carts and 101 hacks, one machine): 40 pass the gate and
37 also have a readable layer 3 GFX range. Of the 6 corpus carts, vanilla,
Lunar Magic and Seven Vanilla Levels pass; Grand Poo World 2 1.1, GrandPooWorld
1.2 and Invictus do not. A cart whose GFX loader (`CODE_00A993`) is hooked has no
readable range and skips layer 3 as well. Vertical maps are skipped: a sublevel's entry never reads
`$05F600` (`bank_05.asm:7116-7162`), so its Layer1YPos is unverified. Settings
`$00` is Layer3TideSetting 0 (not a tide: 512 px repeat, whole tilemap), the non-tide path of `CODE_05C40C`: off Castle1
and Underground1 it sets Layer3YPos = Layer1YPos every frame
(`CODE_05C428` to `CODE_05C48D`), so it is camera-locked like `$81`. A `$80`
level runs `CODE_00A007` (`bank_00.asm:4184-4189`), which copies
`BigCrusherColors` over CGRAM colors 12-15 after `LoadPalette`
(`bank_00.asm:4868-4870`); the level palette path applies it (`readCrusherColors`),
so layer 3 palette 3 and any layer 1 or 2 pixel using those colors show it.

**Measured, one cart.** On the vanilla cart the renderer draws layer 3 on 8
slots (`$002 $01F $0BE $0C1 $102 $127 $1D4 $1FC`; `$01F $1D4 $1FC` are the
crusher-colors levels), skips 3 as camera-locked (`$011 $130 $1C1`), 14 as
interactive layer 2 maps (`$009` is mode 2) and 1 on a non-standard layout
(`$018`); 462 have no layer 3 (of the 488 slots that hold a map; 486 of all 512), and
"no layer 3" is reported before the layout reason. The corpus sweep in
`test/suite/unit/MapScreenL3.test.ts` compares every slot's priority bit,
layout and draw decision with a straight decode of the header and the tables.

---

## The L1 handler interpreter

`src/rom/objectHandlers/interpret.ts` (#351) runs an object handler's own
bytes and returns its Map16 buffer writes, or a refusal with a reason. Phase 1
only compares it with the hand ports; the ports still render.

**State.** A, X, Y (8- or 16-bit, with M/X), N, Z, C, DB, the direct page,
and a typed stack of call frames and data bytes. Any value may be UNKNOWN.
The loader's direct-page inputs are set as `bank_05.asm:677-782` leaves them:
`_A`/`_B`, `$57`, `$59`, `$5A`, `$6B`, `$6E`. Other inputs are named:
`$1928`/`$1BA1` (screen), `$1931` (tileset), switch palace flags, and the
game-state bytes (item memory, coins, 1-ups, moons, midway), which default to 0.
Buffer reads see this object's own writes, else `$25` low / `$00` high; what
earlier objects left is a phase 2 input. Writes come back as buffer addresses;
`applyWrites` turns them into a horizontal-level grid.

**Primitives.** Only two. `JSL` to a routine whose 36 bytes hash to
ExecutePtrLong (`bank_00.asm:864-884`) reads the inline `dl` table and leaves
`_0`-`_5`, A, Y, C and M/X as the routine does. `MVN` copies inside one
Map16 buffer. Every shared helper (page select, write+advance, row+1,
bookmark, merges) runs inline from the ROM.

**Refusals.** An opcode+mode outside the 65 measured on vanilla; `JSL` to
anything but the dispatch; a return over pushed data, or of the wrong kind
(the loader JSLs the entry, so it must end in `RTL`); execution or a dispatch
target outside the $8000-$FFFF half of a ROM bank; a read of unmodelled RAM,
SRAM or unmapped space; an UNKNOWN value at a branch, an index, a pointer or a
buffer write; a write outside the buffers, the direct page (direct-page mode
only, and never the loader's `$65`-`$67`) and `$1BA1`, so ext `$00`/`$01`
refuse (the parser owns screen exits and jumps); an absolute write while DB is
unknown; the budgets.

**Budgets.** 250,000 steps and 16,384 buffer writes per object. Vanilla's
largest completed run needs 99,776 steps (CODE_0DBADC) and 13,470 writes
(the castle wall, CODE_0DDF3A), measured at screen 1, row 2, column 3.

**Differential.** `test/suite/unit/L1Interpret.corpus.test.ts` runs every
object, size and tileset dispatcher on vanilla against the ports, at columns
0, 3 and 15 of screen 5, each on a row where the object fits (moving it down a
row moves every write down a row). Each known disagreement is allow-listed by
routine (`test/suite/support/l1AllowList.ts`) with an issue number or the
quirk it is, plus the exact number of cases it absorbs and a digest of the
interpreter's output, so an entry cannot quietly widen.

---

## Known Gaps / Not Yet Implemented

| Gap | File | Status |
|---|---|---|
| L2 bank=$FF tilemap (LC_RLE1) | LevelParser.ts, MapEditorProvider.ts | ❌ Not implemented |
| BG/FG palette variant addresses for variants ≥ 1 | PaletteLoader.ts | ⚠ Unverified ($B0E0 region) |
| CGRAM rows 9–12 (berry/Yoshi/misc) | PaletteLoader.ts | ❌ Not loaded |
| Colors 13–15 per palette row | PaletteLoader.ts | ❌ Not read (only indices 1–12) |
| Sprite GFX rendering (sp1–sp4) | TileRenderer.ts | ❌ OBJ space not in atlas |
| GFX33 (decimal 33) VRAM slot | GfxLoader.ts | ⚠ Loaded into bg1 ($280–$2FF) - unverified |
| L2 object type meanings | ObjectExpander.ts | ❌ All expand to TILE_UNKNOWN |
| Screen exits (level folder links) | SmwRom.ts, RomExplorerProvider.ts | ❌ Not implemented |

---

## Message Protocol (Extension ↔ Webview)

**Extension → Webview (`load` message):**

```typescript
{
  type: 'load'
  _initial: boolean           // true on first load, false on rerender
  levelIndex: number
  screens: number
  tileGrid: number[][]        // Layer 1 tile grid [row][col] = Map16 tile ID
  bgTileGrid: number[][]      // Layer 2 tile grid [row][col] = Map16 tile ID
  atlasData: number[]         // serialized Uint8ClampedArray (RGBA)
  atlasWidth: number
  atlasHeight: number
  tileUvMap: Record<number, { col: number; row: number }>
  backAreaColor: [r, g, b, a]
  paletteColors: [r, g, b, a][]  // 256 CGRAM entries, row-major
  sprites: Array<{ x: number; y: number; spriteId: number }>
  header: {
    music: number
    backAreaVariant: number   // back area color index (h[1] bits 7–5)
    bgPaletteRow: number      // BG tile palette variant (h[0] bits 7–5)
    fgVariant: number         // FG palette variant (= spriteSet & 0x07)
    spritePalette: number     // sprite palette index (h[3] bits 5–4)
    spriteSet: number         // sprite GFX set (h[3] bits 3–0)
    gfxTilesetId: number      // from $05D760[spriteSet]
  }
}
```

**Extension → Webview (`error` message):**
```typescript
{ type: 'error'; message: string }
```

**Webview → Extension:**
```typescript
{ type: 'ready' }
{ type: 'rerender'; backAreaVariant; bgPaletteRow; fgVariant; spritePalette; marioVariant; spriteSet; tilesetId }
{ type: 'edit'; kind: 'place' | 'erase'; tileId; col; row }
```
