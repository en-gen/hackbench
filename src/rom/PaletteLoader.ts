/**
 * PaletteLoader.ts -- Palette/CGRAM assembly for Super Mario World.
 *
 * Derived from SMWDisX disassembly (bank_00.asm):
 *   - LoadPalette: lines 5595-5699 (main palette loading routine)
 *   - LoadCol8Pal: lines 5701-5711 (set color 1 in all palette rows)
 *   - LoadColors: lines 5713-5730 (generic color loading subroutine)
 *   - DATA_00ABD3: line 5587 (palette variant offsets, stride 24)
 *   - BackAreaColors: $00B0A0 (line 6125, 8 entries x 2 bytes)
 *   - BackgroundPalettes: $00B0B0 (line 6128, 8 variants x 24 bytes)
 *   - StatusBarColors: $00B170 (line 6138, Layer 3 / rows 0-1 cols 8-15)
 *   - ForegroundPalettes: $00B190 (line 6141, 8 variants x 24 bytes)
 *   - StandardColors: $00B250 (line 6151, rows 4-13 cols 2-7)
 *   - PlayerColors: $00B2C8 (line 6163, 4 variants x 20 bytes)
 *   - SpriteColors: $00B318 (line 6169, 8 variants x 24 bytes)
 *   - BerryColors: $00B674 (line 6226, 3 rows x 14 bytes)
 *
 * CGRAM layout (256 colors = 16 rows x 16):
 *   Rows 0-1:   BG (BackgroundPalettes, variant per level header)
 *   Rows 2-3:   FG (ForegroundPalettes, variant per level header)
 *   Rows 4-13:  Standard sprite/object colors (StandardColors)
 *   Row 8:      Player variant overlaid at cols 6-15 (PlayerColors)
 *   Rows 14-15: Sprite palette E/F (SpriteColors variant-selected)
 *
 * Color 0 of each row = transparent (SNES hardware).
 * Color 1 = back area white ($7FDD for BG rows 0-7, $7FFF for OBJ rows 8-15)
 *   (LoadPalette lines 5597-5604: LoadCol8Pal with $7FDD/$7FFF)
 */

import { RomFile } from './RomFile'
import { bgr555ToRgba, RgbaColor } from './GraphicsDecoder'

// ── Constants ─────────────────────────────────────────────────────────────────

export const COLORS_PER_ROW = 16

// ── ROM addresses (from SMW_U.sym, verified against LoadPalette) ──────────────

/** BackAreaColors: $00B0A0 -- 8 BGR555 words indexed by BackAreaColor setting */
export const ADDR_BACK_AREA = 0x00B0A0        // bank_00.asm line 6125

/** BackgroundPalettes: $00B0B0 -- 8 x 24-byte packed pairs (rows 0+1) */
export const ADDR_BG_PAIR = 0x00B0B0          // bank_00.asm line 6128

/** StatusBarColors: $00B170 -- rows 0-1 cols 8-15 (2 x 8 colors = 32 bytes) */
export const ADDR_BG_COLS_8_15 = 0x00B170     // bank_00.asm line 6138

/** ForegroundPalettes: $00B190 -- 8 x 24-byte packed pairs (rows 2+3) */
export const ADDR_FG_PAIR = 0x00B190          // bank_00.asm line 6141

/** StandardColors: $00B250 -- 10 rows x 6 colors x 2B = 120 bytes (rows 4-13 cols 2-7) */
export const ADDR_SHARED_SPRITES = 0x00B250   // bank_00.asm line 6151

/** PlayerColors: $00B2C8 -- 4 variants x 20 bytes (10 colors for row 8 cols 6-15) */
export const ADDR_PLAYER_MARIO = 0x00B2C8     // bank_00.asm line 6163
export const ADDR_PLAYER_LUIGI = 0x00B2DC
export const ADDR_PLAYER_FIRE_MARIO = 0x00B2F0
export const ADDR_PLAYER_FIRE_LUIGI = 0x00B304

/** SpriteColors: $00B318 -- 8 variants x 24-byte packed pairs */
export const ADDR_SPRITE_COLORS = 0x00B318    // bank_00.asm line 6169

/** BerryColors: $00B674 -- 3 rows x 7 colors x 2B = 42 bytes */
export const ADDR_BERRY_COLS = 0x00B674       // bank_00.asm line 6226

// ── Palette layout constants ──────────────────────────────────────────────────

/** Each packed pair = 24 bytes = 12 BGR555 words (6 per half-row) */
export const PALETTE_ENTRY_BYTES = 24
export const PALETTE_ROW_COLORS = 6    // colors 2-7 per half-row
export const PALETTE_ENTRY_COLORS = 12 // total words per packed pair

/** Player palette: 20 bytes = 10 colors filling cols 6-15 of row 8 */
export const PLAYER_ENTRY_BYTES = 20
export const PLAYER_ENTRY_COLORS = 10
export const PLAYER_COL_START = 6

/** Variant offset table: DATA_00ABD3 (bank_00.asm line 5587) */
// db $00,$18,$30,$48,$60,$78,$90,$A8
// Each offset = variant * 24 ($18 = 24 decimal)
const VARIANT_OFFSETS = [0x00, 0x18, 0x30, 0x48, 0x60, 0x78, 0x90, 0xA8]

// Standard sprite rows
export const SHARED_SPRITE_ROWS = 10
export const SHARED_SPRITE_COLS = 6
export const SHARED_SPRITE_FIRST_ROW = 4

// BG secondary colors
export const BG_SECONDARY_COLORS = 8
export const BG_SECONDARY_COL_START = 8

// Berry colors
export const BERRY_COLS_COUNT = 7
export const BERRY_COL_START = 9
export const BERRY_ROW_COUNT = 3
export const BERRY_ROWS_A_START = 2
export const BERRY_ROWS_B_START = 9

// Sprite secondary (rows 5-7 cols 9-15 from SpriteColors variant)
export const SPRITE_SEC_COLS_COUNT = 7
export const SPRITE_SEC_COL_START = 9
export const SPRITE_SEC_ROW_COUNT = 3
export const SPRITE_SEC_FIRST_ROW = 5

// Legacy aliases for compatibility
export const ADDR_SPRITE_SETS = ADDR_SHARED_SPRITES
export const SPRITE_SET_COUNT = 1
export const SPRITE_SET_ROWS = SHARED_SPRITE_ROWS
export const SPRITE_SET_BYTES = SHARED_SPRITE_ROWS * SHARED_SPRITE_COLS * 2
export const ADDR_SP_E = ADDR_SPRITE_COLORS
export const ADDR_SP_F = ADDR_SPRITE_COLORS + 12
export const ADDR_SPRITE_SECONDARY = 0x00B552
export const ADDR_BG0 = ADDR_BG_PAIR
export const ADDR_BG1 = ADDR_BG_PAIR + 12
export const ADDR_FG0 = ADDR_FG_PAIR
export const ADDR_FG1 = ADDR_FG_PAIR + 12

// Lunar Magic custom palette (kept for compatibility)
export const ADDR_CUSTOM_PALETTE_TABLE = 0x0EF600
export const CUSTOM_PALETTE_LEVEL_COUNT = 424
export const CUSTOM_PALETTE_PTR_BYTES = 3
export const CUSTOM_PALETTE_BLOCK_BYTES = 0x0202
export const CUSTOM_PALETTE_COLORS_OFFSET = 2

// ── Types ─────────────────────────────────────────────────────────────────────

export type RgbaRow = RgbaColor[]

export interface PaletteGroup {
  id: string
  label: string
  description: string
  variants: PaletteVariant[]
  cgRamRow: number | null
}

export interface PaletteVariant {
  label: string
  rows: RgbaRow[]
  romAddr: number | null
}

export interface RomPalettes {
  groups: PaletteGroup[]
  backAreaColor: RgbaColor
  sharedSpriteRows: RgbaRow[]
  bgSecondaryCols: RgbaRow[]
  berryCols: RgbaRow[]
  spriteSecondaryCols: RgbaRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRANSPARENT: RgbaColor = [0, 0, 0, 0]
const BLACK: RgbaColor = [0, 0, 0, 255]

function emptyRow(): RgbaRow {
  return Array.from({ length: COLORS_PER_ROW }, (_, i) => i === 0 ? TRANSPARENT : BLACK)
}

/**
 * Read palette colors from ROM into an RgbaRow.
 * Each color is a 16-bit LE BGR555 word.
 * Colors are placed starting at `colStart` in the 16-color row.
 */
function readEntry(rom: RomFile, addr: number, numColors = PALETTE_ROW_COLORS, colStart = 2): RgbaRow {
  const row = emptyRow()
  const buf = rom.readAt(addr, numColors * 2)
  if (!buf) return row
  for (let i = 0; i < numColors; i++) {
    row[colStart + i] = bgr555ToRgba(buf.readUInt16LE(i * 2))
  }
  return row
}

function singleVariant(label: string, addr: number, rom: RomFile, numColors = PALETTE_ROW_COLORS, colStart = 2): PaletteVariant {
  return { label, rows: [readEntry(rom, addr, numColors, colStart)], romAddr: addr }
}

// ── Main loader ──────────────────────────────────────────────────────────────

/**
 * Load all ROM palette data into a structured format.
 *
 * Follows LoadPalette (bank_00.asm lines 5595-5699):
 *   1. Set color 1 in BG palettes to $7FDD, OBJ palettes to $7FFF
 *   2. Load StatusBarColors → rows 0-1 cols 8-15
 *   3. Load StandardColors → rows 4-13 cols 2-7
 *   4. Load BackAreaColors[variant]
 *   5. Load ForegroundPalettes[variant] → rows 2-3 cols 2-7
 *   6. Load SpriteColors[variant] → rows 14-15 cols 2-7
 *   7. Load BackgroundPalettes[variant] → rows 0-1 cols 2-7
 *   8. Load BerryColors → rows 2-4 cols 9-15 AND rows 9-11 cols 9-15
 */
export function loadRomPalettes(rom: RomFile, bgVariant = 0): RomPalettes {
  // Back area color
  const backBuf = rom.readAt(ADDR_BACK_AREA + bgVariant * 2, 2)
  const backAreaColor: RgbaColor = backBuf
    ? bgr555ToRgba(backBuf.readUInt16LE(0))
    : BLACK

  // BG pair variants (8 variants x 24 bytes)
  // LoadPalette line 5663-5679: BackgroundPalettes + DATA_00ABD3[variant]
  const bgPairVariants: PaletteVariant[] = []
  for (let v = 0; v < 8; v++) {
    const pairAddr = ADDR_BG_PAIR + VARIANT_OFFSETS[v]
    bgPairVariants.push({
      label: `Palette ${v}`,
      rows: [
        readEntry(rom, pairAddr, PALETTE_ROW_COLORS),
        readEntry(rom, pairAddr + PALETTE_ROW_COLORS * 2, PALETTE_ROW_COLORS),
      ],
      romAddr: pairAddr,
    })
  }

  // FG pair variants (8 variants x 24 bytes)
  // LoadPalette line 5629-5645: ForegroundPalettes + DATA_00ABD3[variant]
  const fgPairVariants: PaletteVariant[] = []
  for (let v = 0; v < 8; v++) {
    const pairAddr = ADDR_FG_PAIR + VARIANT_OFFSETS[v]
    fgPairVariants.push({
      label: `Palette ${v}`,
      rows: [
        readEntry(rom, pairAddr, PALETTE_ROW_COLORS),
        readEntry(rom, pairAddr + PALETTE_ROW_COLORS * 2, PALETTE_ROW_COLORS),
      ],
      romAddr: pairAddr,
    })
  }

  // Shared sprite colors (10 rows x 6 colors)
  // LoadPalette line 5614-5622: StandardColors → cols 2-7 in palettes 4-D
  const sharedSpriteRows: RgbaRow[] = []
  for (let row = 0; row < SHARED_SPRITE_ROWS; row++) {
    const addr = ADDR_SHARED_SPRITES + row * SHARED_SPRITE_COLS * 2
    sharedSpriteRows.push(readEntry(rom, addr, SHARED_SPRITE_COLS))
  }

  // BG secondary colors (rows 0-1, cols 8-15)
  // LoadPalette line 5605-5613: StatusBarColors → cols 8-15 in palettes 0-1
  const bgSecondaryCols: RgbaRow[] = []
  for (let row = 0; row < 2; row++) {
    const addr = ADDR_BG_COLS_8_15 + row * BG_SECONDARY_COLORS * 2
    bgSecondaryCols.push(readEntry(rom, addr, BG_SECONDARY_COLORS, BG_SECONDARY_COL_START))
  }

  // Berry colors (rows 2-4/9-11, cols 9-15)
  // LoadPalette line 5680-5697: BerryColors → cols 9-15 in palettes 2-4 AND 9-11
  const berryCols: RgbaRow[] = []
  for (let row = 0; row < BERRY_ROW_COUNT; row++) {
    const addr = ADDR_BERRY_COLS + row * BERRY_COLS_COUNT * 2
    berryCols.push(readEntry(rom, addr, BERRY_COLS_COUNT, BERRY_COL_START))
  }

  // Sprite secondary colors (rows 5-7, cols 9-15)
  const spriteSecondaryCols: RgbaRow[] = []
  for (let row = 0; row < SPRITE_SEC_ROW_COUNT; row++) {
    const addr = ADDR_SPRITE_SECONDARY + row * SPRITE_SEC_COLS_COUNT * 2
    spriteSecondaryCols.push(readEntry(rom, addr, SPRITE_SEC_COLS_COUNT, SPRITE_SEC_COL_START))
  }

  const groups: PaletteGroup[] = [
    {
      id: 'bg', label: 'Layer 2 Background (Rows 0-1)', cgRamRow: 0,
      description: 'CGRAM rows 0-1. Variant selected by BackgroundPalette (header byte 0 bits 7-5).',
      variants: bgPairVariants,
    },
    {
      id: 'fg', label: 'Layer 1 Foreground (Rows 2-3)', cgRamRow: 2,
      description: 'CGRAM rows 2-3. Variant selected by ForegroundPalette (header byte 3 bits 2-0).',
      variants: fgPairVariants,
    },
    {
      id: 'sprite_sets', label: 'Shared Sprite Colors (Rows 4-13)', cgRamRow: 4,
      description: 'CGRAM rows 4-13 cols 2-7. Fixed from StandardColors at $B250.',
      variants: [{ label: 'Shared', rows: sharedSpriteRows, romAddr: ADDR_SHARED_SPRITES }],
    },
    {
      id: 'player', label: 'Player Palettes', cgRamRow: 8,
      description: 'CGRAM row 8 cols 6-15. PlayerColors at $B2C8.',
      variants: [
        singleVariant('Mario',      ADDR_PLAYER_MARIO,      rom, PLAYER_ENTRY_COLORS, PLAYER_COL_START),
        singleVariant('Luigi',      ADDR_PLAYER_LUIGI,      rom, PLAYER_ENTRY_COLORS, PLAYER_COL_START),
        singleVariant('Fire Mario', ADDR_PLAYER_FIRE_MARIO, rom, PLAYER_ENTRY_COLORS, PLAYER_COL_START),
        singleVariant('Fire Luigi', ADDR_PLAYER_FIRE_LUIGI, rom, PLAYER_ENTRY_COLORS, PLAYER_COL_START),
      ],
    },
    {
      id: 'sp_e', label: 'Sprite Palette E', cgRamRow: 14,
      description: 'CGRAM row 14. SpriteColors at $B318.',
      variants: [singleVariant('Palette E', ADDR_SPRITE_COLORS, rom, PALETTE_ROW_COLORS)],
    },
    {
      id: 'sp_f', label: 'Sprite Palette F', cgRamRow: 15,
      description: 'CGRAM row 15. SpriteColors+12 at $B324.',
      variants: [singleVariant('Palette F', ADDR_SPRITE_COLORS + 12, rom, PALETTE_ROW_COLORS)],
    },
  ]

  return { groups, backAreaColor, sharedSpriteRows, bgSecondaryCols, berryCols, spriteSecondaryCols }
}

// ── Level CGRAM assembly ──────────────────────────────────────────────────────

export interface ActiveLevelPalette {
  colors: RgbaColor[]
  rows: RgbaRow[]
  bgVariantIndex: number
  fgVariantIndex: number
  spriteSetIndex: number
}

/**
 * Build the full 16-row CGRAM for a specific level configuration.
 *
 * Follows the exact LoadPalette order from bank_00.asm:
 *   1. Color 1 = $7FDD (BG) / $7FFF (OBJ) -- LoadCol8Pal
 *   2. StatusBarColors → rows 0-1 cols 8-15
 *   3. StandardColors → rows 4-13 cols 2-7
 *   4. ForegroundPalettes[variant] → rows 2-3 cols 2-7
 *   5. SpriteColors[variant] → rows 14-15 cols 2-7
 *   6. BackgroundPalettes[variant] → rows 0-1 cols 2-7
 *   7. BerryColors → rows 2-4 & 9-11 cols 9-15
 *   8. PlayerColors[variant] → row 8 cols 6-15
 */
export function buildLevelCgram(
  palettes: RomPalettes,
  bgVariant: number,
  fgVariant: number,
  _spriteSet: number,
  marioVariant = 0,
): ActiveLevelPalette {
  const rows: RgbaRow[] = Array.from({ length: 16 }, emptyRow)

  const bg = palettes.groups.find(g => g.id === 'bg')
  const fg = palettes.groups.find(g => g.id === 'fg')
  const sp = palettes.groups.find(g => g.id === 'sprite_sets')
  const pl = palettes.groups.find(g => g.id === 'player')
  const se = palettes.groups.find(g => g.id === 'sp_e')
  const sf = palettes.groups.find(g => g.id === 'sp_f')

  const bgIdx = bg ? Math.min(bgVariant, bg.variants.length - 1) : 0
  const fgIdx = fg ? Math.min(fgVariant, fg.variants.length - 1) : 0

  // BG rows 0-1, cols 2-7
  if (bg) {
    const bgV = bg.variants[bgIdx]
    if (bgV) {
      rows[0] = bgV.rows[0] ?? emptyRow()
      rows[1] = bgV.rows[1] ?? emptyRow()
    }
  }

  // BG rows 0-1, cols 8-15 (StatusBarColors)
  for (let r = 0; r < 2; r++) {
    const src = palettes.bgSecondaryCols[r]
    if (src) {
      for (let c = BG_SECONDARY_COL_START; c < COLORS_PER_ROW; c++) {
        if (src[c]) rows[r][c] = src[c]
      }
    }
  }

  // FG rows 2-3, cols 2-7
  if (fg) {
    const fgV = fg.variants[fgIdx]
    if (fgV) {
      rows[2] = fgV.rows[0] ?? emptyRow()
      rows[3] = fgV.rows[1] ?? emptyRow()
    }
  }

  // Shared sprite rows 4-13, cols 2-7 (StandardColors)
  for (let r = 0; r < SHARED_SPRITE_ROWS; r++) {
    const src = palettes.sharedSpriteRows[r]
    if (src) {
      const cgramRow = SHARED_SPRITE_FIRST_ROW + r
      for (let c = 2; c < 2 + SHARED_SPRITE_COLS; c++) {
        if (src[c]) rows[cgramRow][c] = src[c]
      }
    }
  }

  // Berry cols 9-15 → rows 2-4 AND rows 9-11
  for (let i = 0; i < BERRY_ROW_COUNT; i++) {
    const src = palettes.berryCols[i]
    if (src) {
      for (let c = BERRY_COL_START; c < BERRY_COL_START + BERRY_COLS_COUNT; c++) {
        if (src[c]) rows[BERRY_ROWS_A_START + i][c] = src[c]
        if (src[c]) rows[BERRY_ROWS_B_START + i][c] = src[c]
      }
    }
  }

  // Sprite rows 5-7, cols 9-15
  for (let i = 0; i < SPRITE_SEC_ROW_COUNT; i++) {
    const src = palettes.spriteSecondaryCols[i]
    if (src) {
      for (let c = SPRITE_SEC_COL_START; c < SPRITE_SEC_COL_START + SPRITE_SEC_COLS_COUNT; c++) {
        if (src[c]) rows[SPRITE_SEC_FIRST_ROW + i][c] = src[c]
      }
    }
  }

  // Row 8: player variant at cols 6-15
  if (pl) {
    const variantRow = pl.variants[Math.min(marioVariant, pl.variants.length - 1)]?.rows[0]
    if (variantRow) {
      for (let c = PLAYER_COL_START; c < COLORS_PER_ROW; c++) {
        if (variantRow[c]) rows[8][c] = variantRow[c]
      }
    }
  }

  // SP_E/F rows 14-15, cols 2-7
  if (se) rows[14] = se.variants[0]?.rows[0] ?? emptyRow()
  if (sf) rows[15] = sf.variants[0]?.rows[0] ?? emptyRow()

  // Color 1: $7FDD for BG rows 0-7, $7FFF for OBJ rows 8-15
  // LoadPalette lines 5597-5604: LoadCol8Pal
  const COL1_BG: RgbaColor = bgr555ToRgba(0x7FDD)
  const COL1_OBJ: RgbaColor = bgr555ToRgba(0x7FFF)
  for (let r = 0; r < 8; r++) rows[r][1] = COL1_BG
  for (let r = 8; r < 16; r++) rows[r][1] = COL1_OBJ

  return {
    colors: rows.flat(),
    rows,
    bgVariantIndex: bgVariant,
    fgVariantIndex: fgVariant,
    spriteSetIndex: _spriteSet,
  }
}

/** Load all 8 back area color variants. */
export function loadBackAreaColors(rom: RomFile): RgbaColor[] {
  return Array.from({ length: 8 }, (_, i) => {
    const buf = rom.readAt(ADDR_BACK_AREA + i * 2, 2)
    return buf ? bgr555ToRgba(buf.readUInt16LE(0)) : (BLACK as RgbaColor)
  })
}

export function loadLevelPalette(rom: RomFile): { colors: RgbaColor[]; rows: RgbaRow[] } {
  const palettes = loadRomPalettes(rom)
  const cgram = buildLevelCgram(palettes, 0, 0, 0)
  return { colors: cgram.colors, rows: cgram.rows }
}

export function getPaletteColor(
  palette: { colors: RgbaColor[] },
  row: number,
  col: number,
): RgbaColor {
  return palette.colors[row * COLORS_PER_ROW + col] ?? [255, 0, 255, 255]
}

// ── Custom per-level palette (Lunar Magic) ────────────────────────────────────

export interface CustomLevelPalette {
  backAreaColor: RgbaColor
  rows: RgbaRow[]
  colors: RgbaColor[]
}

export function loadCustomLevelPalette(
  rom: RomFile,
  levelIndex: number,
): CustomLevelPalette | null {
  if (levelIndex < 0 || levelIndex >= CUSTOM_PALETTE_LEVEL_COUNT) return null

  const ptrAddr = ADDR_CUSTOM_PALETTE_TABLE + levelIndex * CUSTOM_PALETTE_PTR_BYTES
  const ptrBuf = rom.readAt(ptrAddr, CUSTOM_PALETTE_PTR_BYTES)
  if (!ptrBuf) return null

  const blockAddr = ptrBuf[0] | (ptrBuf[1] << 8) | (ptrBuf[2] << 16)
  if (blockAddr === 0x000000 || blockAddr === 0xFFFFFF) return null

  const block = rom.readAt(blockAddr, CUSTOM_PALETTE_BLOCK_BYTES)
  if (!block) return null

  const backAreaColor: RgbaColor = bgr555ToRgba(block.readUInt16LE(0))

  const rows: RgbaRow[] = []
  for (let r = 0; r < 16; r++) {
    const row: RgbaRow = []
    for (let c = 0; c < COLORS_PER_ROW; c++) {
      const off = CUSTOM_PALETTE_COLORS_OFFSET + (r * COLORS_PER_ROW + c) * 2
      const word = block.readUInt16LE(off)
      row.push(c === 0 ? [0, 0, 0, 0] : bgr555ToRgba(word))
    }
    rows.push(row)
  }

  return { backAreaColor, rows, colors: rows.flat() }
}
