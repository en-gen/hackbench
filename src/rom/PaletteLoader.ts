/**
 * Palette loading for Super Mario World.
 *
 * The global palette viewer shows ALL palette groups that exist in the ROM,
 * organized the same way as SMW's internal palette layout. Users can browse
 * and edit any of them here.
 *
 * The level editor sub-panel shows only the subset active for the current level.
 *
 * ── CGRAM layout (runtime, 256 colors = 16 rows × 16) ─────────────────────
 *   Row  0:    Layer 2 BG (variant per BG palette row, level header byte 0 bits 7-5)
 *   Row  1:    Layer 2 BG (second row, same variant)
 *   Row  2:    Layer 1 FG (variant per FG palette set, level header byte 3 bits 2-0)
 *   Row  3:    Layer 1 FG (second row)
 *   Rows 4–8:  Sprite palettes (variant per sprite palette, level header byte 3 bits 5-3)
 *   Row  9:    Berry objects/sprites (area $B1C0–$B2C7, structure ⚠)
 *   Row 10:    Yoshi/misc objects (same area)
 *   Rows11–12: Sprite palettes continued (same area)
 *   Row 13:    Player (Mario/Luigi/Fire — variant)
 *   Row 14:    Sprite palette E (shared)
 *   Row 15:    Sprite palette F (shared)
 *
 * ── Verified ROM addresses ─────────────────────────────────────────────────
 *   $00B0A0        Back area color (2 B)
 *   $00B0B0        BG palette pair table (rows 0+1, variant 0; stride 24)
 *   $00B0C8        BG palette pair variant 1  (level $104 uses this)
 *   $00B190        FG palette pair 0  (rows 2+3 variant 0)
 *   $00B1A8        FG palette pair 0  (row 3)
 *   $00B250        Sprite palette sets 0–3 (4 sets × 2 pairs × 24 B = 48 B/set)
 *   $00B2BC        Player palettes (12 B each, 6 colors): Mario/Luigi/Fire Mario/Fire Luigi
 *   $00B318        Sprite palette E+F packed pair (24 B; row E = words 0–5, row F = words 6–11)
 *
 * ── Intermediate regions (structure ⚠ partially known) ────────────────────
 *   $00B0E0–$00B18F  Additional BG palette variants (BG rows 0+1)
 *   $00B1C0–$00B2C7  Additional data (rows 9–12 area: berry, Yoshi, sprite rows)
 *
 * Sources: SMW Central RAM/ROM memory maps, smwspeedruns.com/Level_Data_Format
 */

import { RomFile } from './RomFile'
import { bgr555ToRgba, RgbaColor } from './GraphicsDecoder'

// ── Constants ─────────────────────────────────────────────────────────────────

export const COLORS_PER_ROW    = 16

// ── CGRAM row structure ──────────────────────────────────────────────────────
//
//   Col 0:    $0000 — transparent (SNES hardware: color index 0 = transparent
//               for all sub-palettes; CGRAM[0] doubles as the backdrop color
//               but SMW treats col 0 as transparent in the palette viewer).
//   Col 1:    back-area color — SMW writes this at runtime to col 1 of every
//               sub-palette row. For BG rows (0–7) it comes from the level's
//               back-area variant ($B0A0 table). For OBJ rows (8–15) it is
//               $7FFF (white). This value is NOT stored in the ROM palette
//               entries — it is loaded separately from level metadata.
//   Cols 2–7: 6 palette colors from the ROM packed-pair entry for this row-half
//               (words 0–5 → cols 2–7 of row N; words 6–11 → cols 2–7 of row N+1).
//   Cols 8–15: additional colors (source varies by row; many are $0000/unused
//               for BG layers, but OBJ rows may have data from sprite sets).
//
//   Each 24-byte ROM palette entry is a PACKED PAIR of two 6-color half-rows:
//     words 0–5  (12 B) → row N   cols 2–7
//     words 6–11 (12 B) → row N+1 cols 2–7

// Colors active per row-half in the primary slot (cols 2–7 or 10–15)
export const PALETTE_ROW_COLORS = 6

// Full entry stride: one 24-byte ROM block covers one palette row (or a pair for BG/FG).
// Sprite set rows each occupy 24 bytes individually.
export const PALETTE_ENTRY_BYTES  = 24
export const PALETTE_ENTRY_COLORS = 12   // total words per entry (two halves of 6)

// Player palettes: 20 bytes = 10 colors, filling CGRAM palette 8 cols 6–F.
// ROM map: $B2C8 Mario, $B2DC Luigi, $B2F0 Fire Mario, $B304 Fire Luigi (stride 20).
// "Colours 6–F of palette 8" → colStart = 6, cgRamRow = 8.
// Note: cols 1–5 of row 8 come from the sprite set's 5th row (⚠ address TBD).
export const PLAYER_ENTRY_BYTES   = 20   // 10 colors × 2 bytes
export const PLAYER_ENTRY_COLORS  = 10
export const PLAYER_COL_START     = 6    // colors land at CGRAM cols 6–15

// ── Verified ROM addresses ─────────────────────────────────────────────────────
// SMW_Shared.smwpal = exact ROM bytes $B0A0–$B8A1 (confirmed 100% byte match).
//
// $B0A0: back-area colors — 8 BGR555 words, indexed by level bgPalette (0–7)
// $B0B0: BG rows 0+1 PACKED variant 0 — words 0–5 → row 0 cols 2–7,
//                                         words 6–11 → row 1 cols 2–7
// $B0C8: BG rows 0+1 PACKED variant 1 — same layout (verified vs GT CGRAM for level $104)
// $B0E0: BG rows 0+1 PACKED variant 2 — ...  stride 24 up to $B190
// $B190: FG rows 2+3 PACKED — words 0–5 → row 2 cols 2–7,
//                              words 6–11 → row 3 cols 2–7   (verified vs GT CGRAM)
// $B1C0–$B2C7: intermediate 264-byte region (structure ⚠ partially known)
// $B2C8: player palettes (20 B × 4 variants)
// $B318: sprite palette E (24 B)
// $B330: sprite palette F (24 B)
// $B348: sprite palette sets (8 sets × 5 rows × 24 B = 960 B)  ⚠ address unverified

export const ADDR_BACK_AREA   = 0x00B0A0
// BG rows 0+1 in one 24-byte paired entry; row N = words 0–5, row N+1 = words 6–11.
// Table start = $B0B0 (variant 0); variant 1 at $B0C8; stride 24.
export const ADDR_BG_PAIR     = 0x00B0B0  // BG pair table start (variant 0)
// FG rows 2+3 in one 24-byte paired entry; row 2 = words 0–5, row 3 = words 6–11
export const ADDR_FG_PAIR     = 0x00B190
// Aliases for variant 0 row halves
export const ADDR_BG0         = 0x00B0B0  // = ADDR_BG_PAIR (row 0 half, variant 0)
export const ADDR_BG1         = 0x00B0BC  // = ADDR_BG_PAIR + 12 (row 1 half, variant 0)
export const ADDR_FG0         = 0x00B190  // = ADDR_FG_PAIR (row 2 half)
export const ADDR_FG1         = 0x00B19C  // = ADDR_FG_PAIR + 12 (row 3 half)
// Player palettes: 10 colors × 2B = 20B each (CGRAM row 8 cols 6–F); 4 variants at stride 20.
// ROM map confirmed: $B2C8 Mario, $B2DC Luigi, $B2F0 Fire Mario, $B304 Fire Luigi.
export const ADDR_PLAYER_MARIO      = 0x00B2C8
export const ADDR_PLAYER_LUIGI      = 0x00B2DC  // = $B2C8 + 20
export const ADDR_PLAYER_FIRE_MARIO = 0x00B2F0  // = $B2C8 + 40
export const ADDR_PLAYER_FIRE_LUIGI = 0x00B304  // = $B2C8 + 60
// SP_E and SP_F share one 24-byte PACKED PAIR at $B318 (same structure as BG/FG pairs):
//   words 0–5 (12B at $B318) → SP_E (row 14 cols 2–7)  [verified 100% match]
//   words 6–11 (12B at $B324) → SP_F (row 15 cols 2–7) [verified 100% match]
export const ADDR_SP_E        = 0x00B318
export const ADDR_SP_F        = 0x00B318 + 12  // = $B324
// ── Shared sprite colors (NOT variant-dependent) ────────────────────────────
// SMW DMA at $00:AC1F loads from $B250 into CGRAM rows 4–13, cols 2–7.
// 10 rows × 6 colors × 2B = 120 bytes, packed sequentially (NOT packed pairs).
// This block ends at $B2C7, immediately before the player palettes at $B2C8.
// Row 8 cols 2–5 are the player BASE colors (skin tones, shoe brown) shared
// across all Mario/Luigi variants; cols 6–15 are overwritten by player variant.
export const ADDR_SHARED_SPRITES      = 0x00B250
export const SHARED_SPRITE_ROWS       = 10   // CGRAM rows 4–13
export const SHARED_SPRITE_COLS       = 6    // cols 2–7
export const SHARED_SPRITE_FIRST_ROW  = 4    // first CGRAM row

// ── BG secondary colors (cols 8–15) ────────────────────────────────────────
// SMW DMA at $00:AC06 loads from $B170 into CGRAM rows 0–1, cols 8–15.
// 2 rows × 8 colors × 2B = 32 bytes packed sequentially.
export const ADDR_BG_COLS_8_15        = 0x00B170
export const BG_SECONDARY_COLORS      = 8    // cols 8–15
export const BG_SECONDARY_COL_START   = 8

// ── Berry/Secondary colors (cols 9–15) ──────────────────────────────────────
// SMW DMA at $00:ACBF loads $B674 → rows 2–4 cols 9–15 (3 rows × 7 colors).
// SMW DMA at $00:ACD6 reuses $B674 → rows 9–11 cols 9–15 (same 3 rows).
// ROM map: $B674=pal 2&9, $B682=pal 3&A, $B690=pal 4&B (14 bytes each).
export const ADDR_BERRY_COLS          = 0x00B674
export const BERRY_COLS_COUNT         = 7    // cols 9–15
export const BERRY_COL_START          = 9
export const BERRY_ROW_COUNT          = 3    // 3 source rows
export const BERRY_ROWS_A_START       = 2    // target A: rows 2–4
export const BERRY_ROWS_B_START       = 9    // target B: rows 9–11 (same data reused)

// ── Sprite rows 5–7 secondary (cols 9–15) ──────────────────────────────────
// ROM map: $B552=pal 5, $B560=pal 6, $B56E=pal 7 (14 bytes each = 7 colors).
// These are separate from the berry block above.
export const ADDR_SPRITE_SECONDARY    = 0x00B552
export const SPRITE_SEC_COLS_COUNT    = 7    // cols 9–15
export const SPRITE_SEC_COL_START     = 9
export const SPRITE_SEC_ROW_COUNT     = 3    // rows 5, 6, 7
export const SPRITE_SEC_FIRST_ROW     = 5

// Legacy aliases (kept for backward compatibility with palette viewer groups)
export const ADDR_SPRITE_SETS = ADDR_SHARED_SPRITES
export const SPRITE_SET_COUNT = 1       // single shared block, no variants
export const SPRITE_SET_ROWS  = SHARED_SPRITE_ROWS
export const SPRITE_SET_BYTES = SHARED_SPRITE_ROWS * SHARED_SPRITE_COLS * 2  // 120B

// ── Per-level custom palette (Lunar Magic extension) ─────────────────────────
// Lunar Magic stores a full per-level CGRAM override at $0EF600.
// Pointer table: 424 entries × 3 bytes (24-bit SNES address).
// Each pointer → $0202-byte block:
//   bytes 0–1:     back area color (BGR555)
//   bytes 2–513:   all 256 CGRAM colors in row-major order (16 rows × 16 colors × 2 B)
// Special pointer values:
//   $000000  = use vanilla palette (no custom block for this level)
//   $FFFFFF  = Lunar Magic patch not installed
export const ADDR_CUSTOM_PALETTE_TABLE = 0x0EF600
export const CUSTOM_PALETTE_LEVEL_COUNT = 424
export const CUSTOM_PALETTE_PTR_BYTES   = 3         // 24-bit pointer
export const CUSTOM_PALETTE_BLOCK_BYTES = 0x0202    // 514 bytes: 2 back + 512 colors
export const CUSTOM_PALETTE_COLORS_OFFSET = 2       // first 2 bytes = back area color

// ── Types ─────────────────────────────────────────────────────────────────────

export type RgbaRow = RgbaColor[]   // 16 colors

/**
 * A named palette group shown in the editor (e.g. "BG Palette", "Sprite Palettes").
 * Each variant is one selectable version (e.g. BG variant 0, sprite set 3).
 * A variant may contain multiple CGRAM rows (e.g. sprite sets show 5 rows).
 */
export interface PaletteGroup {
  id: string
  label: string
  description: string
  variants: PaletteVariant[]
  /** Which CGRAM row this group's first row occupies at runtime (null = varies). */
  cgRamRow: number | null
}

export interface PaletteVariant {
  label: string
  /** One element per CGRAM row — most groups have 1 row, sprite sets have 5. */
  rows: RgbaRow[]
  /** ROM address of the first row (null = unverified). */
  romAddr: number | null
}

/** Full palette database — everything readable from ROM. */
export interface RomPalettes {
  groups: PaletteGroup[]
  backAreaColor: RgbaColor
  /** Shared sprite colors: 10 rows (CGRAM 4–13) × 6 colors (cols 2–7). From $B250. */
  sharedSpriteRows: RgbaRow[]
  /** BG secondary colors: 2 rows (CGRAM 0–1) × 8 colors (cols 8–15). From $B170. */
  bgSecondaryCols: RgbaRow[]
  /** Berry/secondary: 3 rows × 7 cols 9–15. From $B674. Applied to rows 2–4 AND 9–11. */
  berryCols: RgbaRow[]
  /** Sprite rows 5–7 secondary: 3 rows × 7 cols 9–15. From $B552. */
  spriteSecondaryCols: RgbaRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRANSPARENT: RgbaColor = [0, 0, 0, 0]
const BLACK: RgbaColor       = [0, 0, 0, 255]

function emptyRow(): RgbaRow {
  // Col 0 = transparent (SNES color index 0); all other cols default to
  // black ($0000) matching the SNES CGRAM power-on/cleared state.
  return Array.from({ length: COLORS_PER_ROW }, (_, i) => i === 0 ? TRANSPARENT : BLACK)
}

function readEntry(rom: RomFile, addr: number, numColors = PALETTE_ROW_COLORS, colStart = 2): RgbaRow {
  const row = emptyRow()
  const buf = rom.readAt(addr, numColors * 2)
  if (!buf) return row
  // Colors land at CGRAM col `colStart`.
  // Default colStart=2: col 0 = transparent ($0000), col 1 = back-area color
  // (written by SMW at runtime), cols 2–7 = 6 ROM palette colors.
  // Player palettes use colStart=6 (colours 6–F of their CGRAM row).
  for (let i = 0; i < numColors; i++) {
    row[colStart + i] = bgr555ToRgba(buf.readUInt16LE(i * 2))
  }
  return row
}

function singleVariant(label: string, addr: number, rom: RomFile, numColors = PALETTE_ROW_COLORS, colStart = 2): PaletteVariant {
  return { label, rows: [readEntry(rom, addr, numColors, colStart)], romAddr: addr }
}

// ── Main loader ───────────────────────────────────────────────────────────────

export function loadRomPalettes(rom: RomFile, bgVariant = 0): RomPalettes {
  // 8 back area color variants, 2 bytes each, packed at $B0A0–$B0AF.
  // The level's bgPalette field (header byte 0 bits 7-5) selects the variant.
  const backBuf = rom.readAt(ADDR_BACK_AREA + bgVariant * 2, 2)
  const backAreaColor: RgbaColor = backBuf
    ? bgr555ToRgba(backBuf.readUInt16LE(0))
    : BLACK

  // ── BG pair variants ($B0B0–$B16F) ──────────────────────────────────────────
  // Each 24-byte block is a PACKED PAIR: words 0–5 → row 0, words 6–11 → row 1.
  // ROM map: $B0B0=BG 0, $B0C8=BG 1, ... $B158=BG 7. Stride = 24 bytes.
  // Each variant produces 2 rows shown together in the palette viewer.
  const bgPairVariants: PaletteVariant[] = []
  for (let v = 0; v * PALETTE_ENTRY_BYTES < 0x00B170 - ADDR_BG_PAIR; v++) {
    const pairAddr = ADDR_BG_PAIR + v * PALETTE_ENTRY_BYTES
    bgPairVariants.push({
      label: `Palette ${v}`,
      rows: [
        readEntry(rom, pairAddr,                          PALETTE_ROW_COLORS),  // row 0
        readEntry(rom, pairAddr + PALETTE_ROW_COLORS * 2, PALETTE_ROW_COLORS),  // row 1
      ],
      romAddr: pairAddr,
    })
  }

  // ── FG pair variants ($B190–$B24F) ──────────────────────────────────────────
  // ROM map: $B190/$B19C=FG 0 (rows 2+3), $B1A8/$B1B4=FG 1, ...
  // Each variant is 2 × 12 bytes (row 2 then row 3), stride = 24 bytes.
  const fgPairVariants: PaletteVariant[] = []
  for (let v = 0; v * PALETTE_ENTRY_BYTES < ADDR_SHARED_SPRITES - ADDR_FG_PAIR; v++) {
    const row2Addr = ADDR_FG_PAIR + v * PALETTE_ENTRY_BYTES
    const row3Addr = row2Addr + PALETTE_ROW_COLORS * 2
    fgPairVariants.push({
      label: `Palette ${v}`,
      rows: [
        readEntry(rom, row2Addr, PALETTE_ROW_COLORS),  // row 2
        readEntry(rom, row3Addr, PALETTE_ROW_COLORS),  // row 3
      ],
      romAddr: row2Addr,
    })
  }

  // ── Shared sprite colors (rows 4–13, cols 2–7, NOT variant-dependent) ──────
  // SMW DMA at $00:AC1F loads 10 sequential 6-color rows from $B250.
  // No packed-pair structure — just 60 consecutive BGR555 words.
  const sharedSpriteRows: RgbaRow[] = []
  for (let row = 0; row < SHARED_SPRITE_ROWS; row++) {
    const addr = ADDR_SHARED_SPRITES + row * SHARED_SPRITE_COLS * 2
    sharedSpriteRows.push(readEntry(rom, addr, SHARED_SPRITE_COLS))
  }

  // ── BG secondary colors (rows 0–1, cols 8–15) ───────────────────────────
  // SMW DMA at $00:AC06 loads 2 sequential 8-color rows from $B170.
  const bgSecondaryCols: RgbaRow[] = []
  for (let row = 0; row < 2; row++) {
    const addr = ADDR_BG_COLS_8_15 + row * BG_SECONDARY_COLORS * 2
    bgSecondaryCols.push(readEntry(rom, addr, BG_SECONDARY_COLORS, BG_SECONDARY_COL_START))
  }

  // ── Berry/secondary cols 9–15 (rows 2–4 and reused for 9–11) ─────────────
  // ROM map: $B674 (pal 2&9), $B682 (pal 3&A), $B690 (pal 4&B) — 14B each.
  const berryCols: RgbaRow[] = []
  for (let row = 0; row < BERRY_ROW_COUNT; row++) {
    const addr = ADDR_BERRY_COLS + row * BERRY_COLS_COUNT * 2
    berryCols.push(readEntry(rom, addr, BERRY_COLS_COUNT, BERRY_COL_START))
  }

  // ── Sprite rows 5–7, cols 9–15 ─────────────────────────────────────────
  // ROM map: $B552 (pal 5), $B560 (pal 6), $B56E (pal 7) — 14B each.
  const spriteSecondaryCols: RgbaRow[] = []
  for (let row = 0; row < SPRITE_SEC_ROW_COUNT; row++) {
    const addr = ADDR_SPRITE_SECONDARY + row * SPRITE_SEC_COLS_COUNT * 2
    spriteSecondaryCols.push(readEntry(rom, addr, SPRITE_SEC_COLS_COUNT, SPRITE_SEC_COL_START))
  }

  const groups: PaletteGroup[] = [

    // ── Background (rows 0+1, always loaded together) ──────────────────────
    // Each variant is a 24-byte packed pair → 2 rows shown together.
    // Variant selected by BG palette field (level header byte 0 bits 7-5).
    // ROM map: $B0B0=BG 0, $B0C8=BG 1, ... $B158=BG 7.
    {
      id: 'bg', label: 'Layer 2 Background (Rows 0–1)', cgRamRow: 0,
      description: 'CGRAM rows 0–1 — BG tile colors (packed pair). ' +
        'Variant selected by BG palette (level header byte 0 bits 7-5).',
      variants: bgPairVariants,
    },

    // ── Foreground (rows 2+3, always loaded together) ────────────────────
    // Each variant is a packed pair → 2 rows shown together.
    // ROM map: $B190=FG 0, $B1A8=FG 1, ... $B238=FG 7.
    {
      id: 'fg', label: 'Layer 1 Foreground (Rows 2–3)', cgRamRow: 2,
      description: 'CGRAM rows 2–3 — FG tile colors (packed pair). ' +
        'Variant selected by FG palette (level header).',
      variants: fgPairVariants,
    },

    // ── Shared sprite colors (rows 4–13, NOT variant-selectable) ───────────────
    {
      id: 'sprite_sets', label: 'Shared Sprite Colors (Rows 4–13)', cgRamRow: 4,
      description: 'CGRAM rows 4–13, cols 2–7 — shared sprite base colors from $B250. ' +
        'Fixed for all levels (not variant-selectable). 10 rows × 6 colors.',
      variants: [{
        label: 'Shared',
        rows: sharedSpriteRows,
        romAddr: ADDR_SHARED_SPRITES,
      }],
    },

    // ── Player ────────────────────────────────────────────────────────────────
    {
      id: 'player', label: 'Player Palettes', cgRamRow: 8,
      description: 'CGRAM row 8, cols 6–F — Mario/Luigi variants (10 colors each). ' +
        'ROM map: $B2C8 Mario / $B2DC Luigi / $B2F0 Fire Mario / $B304 Fire Luigi.',
      variants: [
        singleVariant('Mario',      ADDR_PLAYER_MARIO,      rom, PLAYER_ENTRY_COLORS, PLAYER_COL_START),
        singleVariant('Luigi',      ADDR_PLAYER_LUIGI,      rom, PLAYER_ENTRY_COLORS, PLAYER_COL_START),
        singleVariant('Fire Mario', ADDR_PLAYER_FIRE_MARIO, rom, PLAYER_ENTRY_COLORS, PLAYER_COL_START),
        singleVariant('Fire Luigi', ADDR_PLAYER_FIRE_LUIGI, rom, PLAYER_ENTRY_COLORS, PLAYER_COL_START),
      ],
    },

    // ── Shared sprite rows ────────────────────────────────────────────────────
    // SP_E and SP_F are packed pairs at $B318: words 0–5 → SP_E cols 1–6,
    // words 6–11 → SP_F cols 1–6.
    {
      id: 'sp_e', label: 'Sprite Palette E', cgRamRow: 14,
      description: 'CGRAM row 14 — shared sprite colors. Always loaded.',
      variants: [singleVariant('Palette E', ADDR_SP_E, rom, PALETTE_ROW_COLORS)],
    },
    {
      id: 'sp_f', label: 'Sprite Palette F', cgRamRow: 15,
      description: 'CGRAM row 15 — shared sprite colors. Always loaded.',
      variants: [singleVariant('Palette F', ADDR_SP_F, rom, PALETTE_ROW_COLORS)],
    },

  ]

  return { groups, backAreaColor, sharedSpriteRows, bgSecondaryCols, berryCols, spriteSecondaryCols }
}

// ── Level-specific palette summary ─────────────────────────────────────────────

export interface ActiveLevelPalette {
  colors: RgbaColor[]
  rows: RgbaRow[]
  bgVariantIndex: number
  fgVariantIndex: number
  spriteSetIndex: number
}

export function buildLevelCgram(
  palettes: RomPalettes,
  bgVariant: number,
  fgVariant: number,
  spriteSet: number,
  marioVariant = 0,   // 0=Mario 1=Luigi 2=Fire Mario 3=Fire Luigi
): ActiveLevelPalette {
  const rows: RgbaRow[] = Array.from({ length: 16 }, emptyRow)

  const bg = palettes.groups.find(g => g.id === 'bg')
  const fg = palettes.groups.find(g => g.id === 'fg')
  const sp = palettes.groups.find(g => g.id === 'sprite_sets')
  const pl = palettes.groups.find(g => g.id === 'player')
  const se = palettes.groups.find(g => g.id === 'sp_e')
  const sf = palettes.groups.find(g => g.id === 'sp_f')

  // Clamp indices to available variant count to avoid undefined
  const bgIdx = bg ? Math.min(bgVariant, bg.variants.length - 1) : 0
  const fgIdx = fg ? Math.min(fgVariant, fg.variants.length - 1) : 0
  const spIdx = sp ? Math.min(spriteSet, sp.variants.length - 1) : 0

  // ── BG rows 0–1, cols 2–7 (variant-selectable, packed pair) ──────────────
  if (bg) {
    const bgV = bg.variants[bgIdx]
    if (bgV) {
      rows[0] = bgV.rows[0] ?? emptyRow()
      rows[1] = bgV.rows[1] ?? emptyRow()
    }
  }

  // ── BG rows 0–1, cols 8–15 (fixed from $B170) ──────────────────────────
  for (let r = 0; r < 2; r++) {
    const src = palettes.bgSecondaryCols[r]
    if (src) {
      for (let c = BG_SECONDARY_COL_START; c < COLORS_PER_ROW; c++) {
        if (src[c]) rows[r][c] = src[c]
      }
    }
  }

  // ── FG rows 2–3, cols 2–7 (variant-selectable, packed pair) ────────────
  if (fg) {
    const fgV = fg.variants[fgIdx]
    if (fgV) {
      rows[2] = fgV.rows[0] ?? emptyRow()
      rows[3] = fgV.rows[1] ?? emptyRow()
    }
  }

  // ── Shared sprite rows 4–13, cols 2–7 (fixed from $B250) ───────────────
  for (let r = 0; r < SHARED_SPRITE_ROWS; r++) {
    const src = palettes.sharedSpriteRows[r]
    if (src) {
      const cgramRow = SHARED_SPRITE_FIRST_ROW + r
      for (let c = 2; c < 2 + SHARED_SPRITE_COLS; c++) {
        if (src[c]) rows[cgramRow][c] = src[c]
      }
    }
  }

  // ── Berry cols 9–15 → rows 2–4 AND reused → rows 9–11 (from $B674) ────
  for (let i = 0; i < BERRY_ROW_COUNT; i++) {
    const src = palettes.berryCols[i]
    if (src) {
      for (let c = BERRY_COL_START; c < BERRY_COL_START + BERRY_COLS_COUNT; c++) {
        if (src[c]) rows[BERRY_ROWS_A_START + i][c] = src[c]
        if (src[c]) rows[BERRY_ROWS_B_START + i][c] = src[c]
      }
    }
  }

  // ── Sprite rows 5–7, cols 9–15 (from $B552) ──────────────────────────────
  for (let i = 0; i < SPRITE_SEC_ROW_COUNT; i++) {
    const src = palettes.spriteSecondaryCols[i]
    if (src) {
      for (let c = SPRITE_SEC_COL_START; c < SPRITE_SEC_COL_START + SPRITE_SEC_COLS_COUNT; c++) {
        if (src[c]) rows[SPRITE_SEC_FIRST_ROW + i][c] = src[c]
      }
    }
  }

  // ── Row 8: overlay player variant at cols 6–F ──────────────────────────
  // Cols 2–5 already filled from shared sprites ($B250 row index 4) above.
  // Player variant ($B2C8 etc.) overwrites cols 6–15.
  if (pl) {
    const variantRow = pl.variants[Math.min(marioVariant, pl.variants.length - 1)]?.rows[0]
    if (variantRow) {
      for (let c = PLAYER_COL_START; c < COLORS_PER_ROW; c++) {
        if (variantRow[c]) rows[8][c] = variantRow[c]
      }
    }
  }

  // ── SP_E/F rows 14–15, cols 2–7 (variant-selectable) ──────────────────
  if (se) rows[14] = se.variants[0]?.rows[0] ?? emptyRow()
  if (sf) rows[15] = sf.variants[0]?.rows[0] ?? emptyRow()

  // Col 0 = $0000 (transparent) for all rows — set by emptyRow().
  // Col 1 = hardcoded in SMW's palette init routine at $00:ABF0:
  //   BG rows 0–7:  LDA #$7FDD → JSR $ACED (near-white, BGR555)
  //   OBJ rows 8–15: LDA #$7FFF → JSR $ACED (pure white, BGR555)
  const COL1_BG:  RgbaColor = bgr555ToRgba(0x7FDD)  // #EFF7FF — SMW hardcoded
  const COL1_OBJ: RgbaColor = bgr555ToRgba(0x7FFF)  // #FFFFFF — SMW hardcoded
  for (let r = 0; r < 8;  r++) rows[r][1] = COL1_BG
  for (let r = 8; r < 16; r++) rows[r][1] = COL1_OBJ

  return {
    colors: rows.flat(),
    rows,
    bgVariantIndex: bgVariant,
    fgVariantIndex: fgVariant,
    spriteSetIndex: spriteSet,
  }
}

/** Load all 8 back area color variants from $B0A0 (2 bytes each). */
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

/**
 * Load the per-level custom palette installed by Lunar Magic, if present.
 *
 * Returns null if:
 *  - levelIndex is out of range
 *  - The pointer table is not in ROM (unpatched ROM)
 *  - The pointer for this level is $000000 (use vanilla) or $FFFFFF (LM not installed)
 *  - The palette block could not be read
 *
 * @param rom          ROM file
 * @param levelIndex   0-based level index (0–511, but table only covers 0–423)
 */
export function loadCustomLevelPalette(
  rom: RomFile,
  levelIndex: number,
): CustomLevelPalette | null {
  if (levelIndex < 0 || levelIndex >= CUSTOM_PALETTE_LEVEL_COUNT) return null

  const ptrAddr = ADDR_CUSTOM_PALETTE_TABLE + levelIndex * CUSTOM_PALETTE_PTR_BYTES
  const ptrBuf  = rom.readAt(ptrAddr, CUSTOM_PALETTE_PTR_BYTES)
  if (!ptrBuf) return null

  // Read 24-bit little-endian pointer
  const blockAddr = ptrBuf[0] | (ptrBuf[1] << 8) | (ptrBuf[2] << 16)

  // $000000 = vanilla palette; $FFFFFF = LM not installed
  if (blockAddr === 0x000000 || blockAddr === 0xFFFFFF) return null

  const block = rom.readAt(blockAddr, CUSTOM_PALETTE_BLOCK_BYTES)
  if (!block) return null

  // Back area color: first 2 bytes
  const backAreaColor: RgbaColor = bgr555ToRgba(block.readUInt16LE(0))

  // CGRAM colors: bytes 2–513, 256 colors × 2 bytes, row-major
  const rows: RgbaRow[] = []
  for (let r = 0; r < 16; r++) {
    const row: RgbaRow = []
    for (let c = 0; c < COLORS_PER_ROW; c++) {
      const off = CUSTOM_PALETTE_COLORS_OFFSET + (r * COLORS_PER_ROW + c) * 2
      const word = block.readUInt16LE(off)
      // Color 0 of each row is transparent at runtime (CGRAM index 0 = back area per-row)
      row.push(c === 0 ? [0, 0, 0, 0] : bgr555ToRgba(word))
    }
    rows.push(row)
  }

  return { backAreaColor, rows, colors: rows.flat() }
}
