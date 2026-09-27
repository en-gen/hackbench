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
- BG3 (Layer 3): 2bpp - used for the **HUD/status bar only**, not level content
- All sprites: 4bpp, CGRAM sub-palettes 8–15 (OBJ space, separate from BG VRAM)

The 3-bit palette field in each Map16 SubTile (CCC = 0–7) selects one of CGRAM rows 0–7.
SMW assigns these rows per layer type:
- Rows 0–1: Layer 2 BG tiles (BG palette variants)
- Rows 2–3: Layer 1 FG tiles (FG palette variants, derived from spriteSet & 0x07)
- Rows 4–8: Sprite palettes (selected by spritePalette field)

---

## The L1 handler interpreter

`src/rom/objectHandlers/interpret.ts` (#664) runs an object handler's own
bytes and returns its Map16 buffer writes, or a refusal with a reason. Phase 1
only compares it with the hand ports; the ports still render.

**State.** A, X, Y (8- or 16-bit, with M/X), N, Z, C, DB, the direct page,
and a typed stack of call frames and data bytes. Any value may be UNKNOWN.
The loader's direct-page inputs are set as `bank_05.asm:677-782` leaves them:
`_A`/`_B`, `$57`, `$59`, `$5A`, `$6B`, `$6E`. Other inputs are named:
`$1928`/`$1BA1` (screen), `$1931` (tileset), switch palace flags, and the
game-state bytes (item memory, coins, 1-ups, moons, midway), which default to 0.
Buffer reads fall back to what earlier objects left, then `$25` low / `$00`
high. Writes come back as buffer addresses; `applyWrites` turns them into a
grid for a given screen stride.

**Primitives.** Only two. `JSL` to a routine whose 36 bytes hash to
ExecutePtrLong (`bank_00.asm:864-884`) reads the inline `dl` table and leaves
`_0`-`_5`, A, Y, C and M/X as the routine does. `MVN` copies inside one
Map16 buffer. Every shared helper (page select, write+advance, row+1,
bookmark, merges) runs inline from the ROM.

**Refusals.** An opcode+mode outside the 65 measured on vanilla; `JSL` to
anything but the dispatch; a return over pushed data; execution or a dispatch
target outside ROM; a read of unmodelled RAM; an UNKNOWN value at a branch,
an index, a pointer or a buffer write; a write outside the buffers and
`$1BA1` (so ext `$00`/`$01` refuse: the parser owns screen exits and jumps);
the budgets.

**Budgets.** 250,000 steps and 16,384 buffer writes per object. Vanilla's
largest completed run needs 99,776 steps (CODE_0DBADC) and 13,470 writes
(the castle wall, CODE_0DDF3A), measured at screen 1, row 2, column 3.

**Differential.** `test/suite/unit/L1Interpret.corpus.test.ts` runs every
object, size and tileset dispatcher on vanilla against the ports. Each known
disagreement is allow-listed by routine with an issue number, or as a
zero-nibble wrap, an out-of-range size, or a ROM quirk.

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
