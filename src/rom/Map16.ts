/**
 * Map16.ts -- Map16 pointer table construction and tile decoding for Super Mario World.
 *
 * Derived from SMWDisX disassembly:
 *   - CODE_0581FB (bank_05.asm lines 253-358): bitmap-driven pointer table setup
 *   - DATA_0581BB (bank_05.asm lines 243-251): 64-byte bitmap
 *   - TilesetMAP16Loc (bank_05.asm lines 2-17): 15 word entries (tileset addresses)
 *   - Map16Common ($0D8000, bank_0D.asm line 2): common tiles
 *   - Map16BGTiles ($0D9100, bank_0D.asm line 551): L2 preset background tiles
 *   - Map16Tileset0-4 (bank_0D.asm): tileset-specific tiles
 *   - UploadOneMap16Strip (bank_00.asm line 958): DMA order confirms column-major
 *     subtile order: TL, BL, TR, BR
 *
 * Each Map16 tile = 8 bytes = 4 little-endian words (SNES BG tile attributes).
 * Word order (column-major, verified via UploadOneMap16Strip DMA at bank_00 lines 969-1025):
 *   word 0 = TL (top-left)
 *   word 1 = BL (bottom-left)
 *   word 2 = TR (top-right)
 *   word 3 = BR (bottom-right)
 */

import { RomFile } from './RomFile'

// ── ROM addresses (from SMW_U.sym) ────────────────────────────────────────────
/** Map16Common: $0D8000 -- shared (common) Map16 tile data */
export const MAP16_COMMON = 0x0D8000       // bank_0D.asm line 2

/** Map16BGTiles: $0D9100 -- L2 preset background Map16 tile data */
export const MAP16_BG_TILES = 0x0D9100     // bank_0D.asm line 551

/** TilesetMAP16Loc: $058000 -- 15 word entries pointing to tileset-specific data */
export const TILESET_MAP16_LOC = 0x058000   // bank_05.asm line 2

/** DATA_0581BB: $0581BB -- 64-byte bitmap for common/tileset assignment */
export const MAP16_BITMAP_ADDR = 0x0581BB   // bank_05.asm line 243

/** Number of tileset entries in TilesetMAP16Loc */
export const TILESET_COUNT = 15             // bank_05.asm lines 3-17

/**
 * MAP16AppTable at SNES `$058776` (bank_05.asm line 884):
 *   db $B0,$8A,$E0,$84,$F0,$8A,$30,$8B
 *
 * Four 16-bit pointers (bank $0D) to four palette variants of the pipe
 * tile block `$133..$13A`:
 *   idx 0 → $0D8AB0 — palette 3 (FG pal row 3; grey in FG pal 0)
 *   idx 1 → $0D84E0 — palette 5 (StandardColors green)
 *   idx 2 → $0D8AF0 — palette 6 (StandardColors yellow/brown)
 *   idx 3 → $0D8B30 — palette 7 (StandardColors blue/purple)
 *
 * CODE_0580BD (level load, bank_05.asm lines 110-143) and CODE_05877E
 * (scroll-triggered, bank_05.asm lines 900-929) both select one of these
 * variants via `(Layer1TileDown >> 3) & 6` and rewrite Map16Pointers[$133..$13A]
 * to redirect tiles $133..$13A to the chosen variant's 8-tile block.
 *
 * Effect: the same Map16 RAM tile ID can render as any of four colors
 * depending on which screen/scroll-position it was uploaded at. This is how
 * vanilla SMW produces the cycling pipe colors across screens.
 */
export const MAP16_APP_TABLE: readonly number[] = [
  0x0D8AB0,  // variant 0: palette 3 (grey)
  0x0D84E0,  // variant 1: palette 5 (green)
  0x0D8AF0,  // variant 2: palette 6 (yellow)
  0x0D8B30,  // variant 3: palette 7 (blue/purple)
] as const

/** Tile IDs `$133..$13A` are the 8 consecutive pipe tiles the app-table redirects. */
export const PIPE_VARIANT_TILE_START = 0x133
export const PIPE_VARIANT_TILE_COUNT = 8

/**
 * Compute the MAP16AppTable index (0-3) for a given scroll-ish counter, matching
 * the ASM's `(Layer1TileDown >> 3) & 6` then divided by 2.
 *
 * bank_05.asm:119-124 uses Layer1TileDown (level-load loop, increments per strip).
 * bank_05.asm:910-915 uses Layer1TileUp (scroll-triggered, derived from Layer1YPos).
 */
export function pipeVariantIndex(scrollCounter: number): number {
  return ((scrollCounter >>> 3) & 0x06) >>> 1
}

/** Tileset-specific Map16 addresses from SMW_U.sym */
export const MAP16_TILESET_ADDRS: number[] = [
  0x0D8B70,  // Map16Tileset0
  0x0DBC00,  // Map16Tileset1
  0x0DC800,  // Map16Tileset2
  0x0DD400,  // Map16Tileset3
  0x0DE300,  // Map16Tileset4
]

export const MAP16_TILE_BYTES = 8
export const MAP16_TOTAL_TILES = 512        // 64 bytes * 8 bits = 512 tile entries

// ── Subtile / tile types ─────────────────────────────────────────────────────

export interface SubTile {
  charNum: number    // 10-bit GFX character index (bits 0-9)
  palette: number    // 3-bit palette row (bits 10-12)
  priority: boolean  // bit 13
  flipX: boolean     // bit 14
  flipY: boolean     // bit 15
}

/** A decoded 16x16 Map16 tile with its four 8x8 subtiles. */
export interface Map16Tile {
  id: number
  tl: SubTile   // top-left     (word 0, column-major)
  tr: SubTile   // top-right    (word 2, column-major)
  bl: SubTile   // bottom-left  (word 1, column-major)
  br: SubTile   // bottom-right (word 3, column-major)
}

function decodeSubTile(word: number): SubTile {
  return {
    charNum:  word & 0x3FF,
    palette:  (word >> 10) & 0x7,
    priority: ((word >> 13) & 1) === 1,
    flipX:    ((word >> 14) & 1) === 1,
    flipY:    ((word >> 15) & 1) === 1,
  }
}

const EMPTY_SUBTILE: SubTile = { charNum: 0, palette: 0, priority: false, flipX: false, flipY: false }

function readTileAt(rom: RomFile, addr: number, id: number): Map16Tile {
  const buf = rom.readAt(addr, MAP16_TILE_BYTES)
  if (!buf) {
    return { id, tl: EMPTY_SUBTILE, tr: EMPTY_SUBTILE, bl: EMPTY_SUBTILE, br: EMPTY_SUBTILE }
  }
  // Column-major word order: TL(0), BL(2), TR(4), BR(6)
  const w0 = buf.readUInt16LE(0)  // TL
  const w1 = buf.readUInt16LE(2)  // BL
  const w2 = buf.readUInt16LE(4)  // TR
  const w3 = buf.readUInt16LE(6)  // BR
  return {
    id,
    tl: decodeSubTile(w0),
    bl: decodeSubTile(w1),
    tr: decodeSubTile(w2),
    br: decodeSubTile(w3),
  }
}

/**
 * Build the Map16 pointer table for a given object tileset.
 *
 * Algorithm from CODE_0581FB (bank_05.asm lines 253-358):
 *   - Read 64-byte bitmap from DATA_0581BB ($0581BB)
 *   - Process each byte MSB-first (8 bits per byte, 64 bytes = 512 bits = 512 tile slots)
 *   - For each bit:
 *     - bit=1 (carry set after ASL): use Map16Common pointer, advance common pointer by 8
 *     - bit=0 (carry clear after ASL): use tileset-specific pointer, advance tileset pointer by 8
 *   - Result: array of 512 SNES addresses, one per Map16 tile
 *
 * @param rom       ROM file
 * @param tileset   Object tileset index (0-14, from level header byte 4 bits 3-0)
 */
export function buildMap16PointerTable(rom: RomFile, tileset: number): number[] {
  // Read the tileset-specific address from TilesetMAP16Loc
  // bank_05.asm line 268-269: LDA.L TilesetMAP16Loc,X (X = tileset*2)
  const tilesetWord = rom.readWord(TILESET_MAP16_LOC + (tileset & 0x0F) * 2)
  // This is a 16-bit address in bank $0D
  let tilesetPtr = 0x0D0000 | (tilesetWord ?? 0x8B70)

  // Common pointer starts at Map16Common ($0D8000)
  // bank_05.asm line 270-271: LDA.W #Map16Common -> STA.B _2
  let commonPtr = MAP16_COMMON

  // Read the 64-byte bitmap from ROM
  // bank_05.asm line 272-273: LDA.W #DATA_0581BB -> STA.B _D
  const bitmap = rom.readAt(MAP16_BITMAP_ADDR, 64)

  const pointers: number[] = new Array(512)

  // bank_05.asm CODE_058237 (line 281) through line 316:
  // Y iterates 0..63 (64 bitmap bytes), for each byte:
  //   _C = bitmap[Y]; then 8 iterations of ASL _C
  let tileIdx = 0
  for (let byteIdx = 0; byteIdx < 64; byteIdx++) {
    let bitmapByte = bitmap ? bitmap[byteIdx] ?? 0 : 0

    for (let bit = 0; bit < 8; bit++) {
      // ASL _C: shift left, carry = MSB
      const carry = (bitmapByte & 0x80) !== 0
      bitmapByte = (bitmapByte << 1) & 0xFF

      if (carry) {
        // bit=1: common tile (line 288-294)
        pointers[tileIdx] = commonPtr
        commonPtr += MAP16_TILE_BYTES
      } else {
        // bit=0: tileset-specific tile (line 297-303)
        pointers[tileIdx] = tilesetPtr
        tilesetPtr += MAP16_TILE_BYTES
      }
      tileIdx++
    }
  }

  // CODE_058281 (bank_05.asm line 321): tilesets 0 and 7 overwrite the
  // pointers for tiles $1C4-$1C7 and $1EC-$1EF with a special run of 8
  // consecutive Map16 entries starting at $0D8A70. These are the diagonal
  // slope-pipe tiles (green-pipe variant, palette 5) that replace the
  // common-bank browns that the bitmap walk would otherwise point at.
  if (tileset === 0 || tileset === 7) {
    let slopePtr = 0x0D8A70
    for (const t of [0x1C4, 0x1C5, 0x1C6, 0x1C7, 0x1EC, 0x1ED, 0x1EE, 0x1EF]) {
      pointers[t] = slopePtr
      slopePtr += MAP16_TILE_BYTES
    }
  }

  return pointers
}

/**
 * Apply the MAP16AppTable pipe-palette override to a pointer table in place.
 *
 * Tiles `$133..$13A` get their pointers redirected to `MAP16_APP_TABLE[variantIdx]`,
 * which references an 8-tile block whose Map16 data has a different palette row
 * baked in. Matches the runtime behavior of CODE_0580BD / CODE_05877E.
 *
 * @param pointers     Pointer table produced by `buildMap16PointerTable`.
 * @param variantIdx   0..3 selecting grey/green/yellow/blue pipe variant.
 *                     Out-of-range values are masked to the lower 2 bits.
 */
export function applyPipePaletteVariant(pointers: number[], variantIdx: number): void {
  const base = MAP16_APP_TABLE[variantIdx & 0x03]
  for (let i = 0; i < PIPE_VARIANT_TILE_COUNT; i++) {
    pointers[PIPE_VARIANT_TILE_START + i] = base + i * MAP16_TILE_BYTES
  }
}

/**
 * Load all 512 Map16 tiles using the bitmap-driven pointer table.
 *
 * This is the correct algorithm from the game -- tiles are NOT simply
 * page 0 ($0D8000) + page 1 ($0DC000). The bitmap at DATA_0581BB
 * interleaves common and tileset-specific tiles.
 *
 * If `pipeVariantIdx` is supplied, tiles `$133..$13A` are redirected through
 * MAP16_APP_TABLE to that palette variant (matches CODE_0580BD behavior).
 * Omit the argument for the bitmap-default pointers (equivalent to variant 1 /
 * green).
 */
export function loadAllMap16(rom: RomFile, tileset = 0, pipeVariantIdx?: number): Map16Tile[] {
  const pointers = buildMap16PointerTable(rom, tileset)
  if (pipeVariantIdx !== undefined) {
    applyPipePaletteVariant(pointers, pipeVariantIdx)
  }
  const tiles: Map16Tile[] = new Array(512)
  for (let i = 0; i < 512; i++) {
    tiles[i] = readTileAt(rom, pointers[i], i)
  }
  return tiles
}

/**
 * Load a single Map16 tile by ID, using the pointer table for the given tileset.
 */
export function loadMap16Tile(rom: RomFile, tileId: number, tileset = 0): Map16Tile {
  const pointers = buildMap16PointerTable(rom, tileset)
  if (tileId < 0 || tileId >= 512) {
    return { id: tileId, tl: EMPTY_SUBTILE, tr: EMPTY_SUBTILE, bl: EMPTY_SUBTILE, br: EMPTY_SUBTILE }
  }
  return readTileAt(rom, pointers[tileId], tileId)
}

/**
 * Build the Map16 pointer table for L2 preset backgrounds.
 *
 * From CODE_058126 ending (bank_05.asm lines 225-238):
 *   After L2 preset decompression, Map16Pointers are filled sequentially
 *   from Map16BGTiles ($0D9100), each entry 8 bytes apart, for 512 entries
 *   (X iterates 0..0x3FF by 2 = 512 pointer words).
 */
export function buildL2Map16PointerTable(): number[] {
  const pointers: number[] = new Array(512)
  let addr = MAP16_BG_TILES
  for (let i = 0; i < 512; i++) {
    pointers[i] = addr
    addr += MAP16_TILE_BYTES
  }
  return pointers
}

/**
 * Load all 512 Map16 tiles from the L2 BG tile table.
 */
export function loadAllMap16BG(rom: RomFile): Map16Tile[] {
  const pointers = buildL2Map16PointerTable()
  const tiles: Map16Tile[] = new Array(512)
  for (let i = 0; i < 512; i++) {
    tiles[i] = readTileAt(rom, pointers[i], i)
  }
  return tiles
}
