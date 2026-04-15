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

// ── CGRAM row structure (empirically verified vs Mesen live CGRAM) ────────────
//
//   Col 0:    $0000 — transparent (hardware)
//   Col 1:    back-area color (from $B0A0 table, written by SMW to every row)
//   Cols 2–7: 6 palette colors from the ROM entry for this row-half
//   Col 8:    $0000 — transparent (second 8-color half)
//   Col 9:    back-area color B (varies; $7FFF for OBJ rows, TBD for BG rows)
//   Cols 10–15: secondary palette colors (source address not yet confirmed)
//
//   Each 24-byte ROM palette entry covers ONE row (12 words = 12 colors).
//   For BG pair entries (rows 0+1 and rows 2+3), the 24-byte block packs
//   TWO rows: words 0–5 → row N, words 6–11 → row N+1.

// Colors active per row-half in the primary slot (cols 2–7 or 10–15)
export const PALETTE_ROW_COLORS = 6

// Full entry stride: one 24-byte ROM block covers one palette row (or a pair for BG/FG).
// Sprite set rows each occupy 24 bytes individually.
export const PALETTE_ENTRY_BYTES  = 24
export const PALETTE_ENTRY_COLORS = 12   // total words per entry (two halves of 6)

// Player palettes: 20 bytes = 10 colors, filling CGRAM palette 8 cols 6–F.
// ROM map: $B2C8 Mario, $B2DC Luigi, $B2F0 Fire Mario, $B304 Fire Luigi (stride 20).
// "Colours 6–F of palette 8" → colStart = 6, cgRamRow = 8.
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
// Row 8 base palette: 24 bytes = 12 colors at CGRAM row 8 cols 2–13.
// Loaded before the player variant; player variant ($B2C8) overwrites cols 6–F.
// Cols 2–5 (4 "base" colors) are not overwritten and show as the "missing" skin tones.
export const ADDR_PLAYER_ROW8_BASE  = 0x00B2B0
export const PLAYER_ROW8_BASE_COLS  = 12   // covers cols 2–13
// SP_E and SP_F share one 24-byte PACKED PAIR at $B318 (same structure as BG/FG pairs):
//   words 0–5 (12B at $B318) → SP_E (row 14 cols 2–7)  [verified 100% match]
//   words 6–11 (12B at $B324) → SP_F (row 15 cols 2–7) [verified 100% match]
export const ADDR_SP_E        = 0x00B318
export const ADDR_SP_F        = 0x00B318 + 12  // = $B324
// Sprite palette sets: 4 sets × 2 pairs × 24B = 48B/set.
// Each set covers CGRAM rows 4–7 via 2 packed pairs:
//   pair0 (24B): rows 4+5 (words 0–5 → row 4 cols 2–7, words 6–11 → row 5 cols 2–7)
//   pair1 (24B): rows 6+7 (words 0–5 → row 6, words 6–11 → row 7)
// CGRAM row 8 is dynamically assembled from sprite-specific data (not in static ROM table).
// 4 variants indexed by sprite palette field (header byte 3 bits 5–4, values 0–3).
export const ADDR_SPRITE_SETS = 0x00B250
export const SPRITE_SET_COUNT = 4
export const SPRITE_SET_ROWS  = 4   // CGRAM rows 4–7 (row 8 = dynamic)
export const SPRITE_SET_BYTES = 2 * PALETTE_ENTRY_BYTES  // 48B/set (2 pairs)

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
  /** Row 8 shared base: 12 colors at cols 2–13, loaded before player variant overlay. */
  playerRow8Base: RgbaRow
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRANSPARENT: RgbaColor = [0, 0, 0, 0]
const UNKNOWN: RgbaColor     = [40, 40, 40, 255]

function emptyRow(): RgbaRow {
  return Array.from({ length: COLORS_PER_ROW }, (_, i) => i === 0 ? TRANSPARENT : UNKNOWN)
}

function readEntry(rom: RomFile, addr: number, numColors = PALETTE_ENTRY_COLORS, colStart = 2): RgbaRow {
  const row = emptyRow()
  const buf = rom.readAt(addr, numColors * 2)
  if (!buf) return row
  // Colors land at CGRAM col `colStart` (default 2: col 0 = transparent, col 1 = back-area color).
  // Player palettes use colStart = 6 (colours 6–F of their CGRAM row).
  for (let i = 0; i < numColors; i++) {
    row[colStart + i] = bgr555ToRgba(buf.readUInt16LE(i * 2))
  }
  return row
}

function singleVariant(label: string, addr: number, rom: RomFile, numColors = PALETTE_ENTRY_COLORS, colStart = 2): PaletteVariant {
  return { label, rows: [readEntry(rom, addr, numColors, colStart)], romAddr: addr }
}

// ── Main loader ───────────────────────────────────────────────────────────────

export function loadRomPalettes(rom: RomFile, bgVariant = 0): RomPalettes {
  // 8 back area color variants, 2 bytes each, packed at $B0A0–$B0AF.
  // The level's bgPalette field (header byte 0 bits 7-5) selects the variant.
  const backBuf = rom.readAt(ADDR_BACK_AREA + bgVariant * 2, 2)
  const backAreaColor: RgbaColor = backBuf
    ? bgr555ToRgba(backBuf.readUInt16LE(0))
    : UNKNOWN

  // ── BG pair variants 1+ ($B0C8–$B18F) ───────────────────────────────────────
  // Each 24-byte block = row 0 (words 0–5, 12 B) + row 1 (words 6–11, 12 B).
  // Variant 0 is at $B0B0 (ADDR_BG0/ADDR_BG1 above); variants 1+ start at $B0C8.
  // stride = PALETTE_ENTRY_BYTES (24); number of extra variants:
  //   ($B190 - $B0C8) / 24 = $C8 / 24 = 8 variants (indices 1–8)
  const bgRow0ExtraVariants: PaletteVariant[] = []
  const bgRow1ExtraVariants: PaletteVariant[] = []
  for (let i = 0; i * PALETTE_ENTRY_BYTES < 0x00B190 - 0x00B0C8; i++) {
    const pairAddr = 0x00B0C8 + i * PALETTE_ENTRY_BYTES
    bgRow0ExtraVariants.push(singleVariant(`Variant ${i + 1}`, pairAddr,                          rom, PALETTE_ROW_COLORS))
    bgRow1ExtraVariants.push(singleVariant(`Variant ${i + 1}`, pairAddr + PALETTE_ROW_COLORS * 2, rom, PALETTE_ROW_COLORS))
  }

  // ── Intermediate region ($B1C0–$B2C7, 264 bytes = 11 × 24-byte entries) ─────
  // Best hypothesis: alternating FG row-2 and row-3 entries for palette variants 1–5.
  //   $B1C0 = FG row 2 variant 1, $B1D8 = FG row 3 variant 1
  //   $B1F0 = FG row 2 variant 2, $B208 = FG row 3 variant 2   … etc.
  // Variants 1–5 use even/odd entries; entry 10 ($B2B0) is unassigned / padding.
  // ⚠ Not yet confirmed against live CGRAM (use fg_palette_source.lua to verify).
  const fgExtraRow2: PaletteVariant[] = []  // FG row 2 variants 1–5
  const fgExtraRow3: PaletteVariant[] = []  // FG row 3 variants 1–5
  for (let i = 0; i * PALETTE_ENTRY_BYTES < 0x00B2C8 - 0x00B1C0; i++) {
    const addr = 0x00B1C0 + i * PALETTE_ENTRY_BYTES
    const variantNum = Math.floor(i / 2) + 1
    if (i % 2 === 0) {
      fgExtraRow2.push(singleVariant(`Variant ${variantNum} ⚠`, addr, rom))
    } else {
      fgExtraRow3.push(singleVariant(`Variant ${variantNum} ⚠`, addr, rom))
    }
  }

  // ── Sprite palette sets (CGRAM rows 4–7, indexed by sprite palette 0–3) ───
  // Level header byte 3 bits 5-4 selects the sprite palette (0–3).
  // Each set covers 4 CGRAM rows (4–7) stored as 2 packed pairs of 24 bytes:
  //   pair0 at baseAddr +  0: rows 4+5 (words 0–5 → row 4, words 6–11 → row 5)
  //   pair1 at baseAddr + 24: rows 6+7 (words 0–5 → row 6, words 6–11 → row 7)
  const spriteSetVariants: PaletteVariant[] = []
  for (let set = 0; set < SPRITE_SET_COUNT; set++) {
    const baseAddr = ADDR_SPRITE_SETS + set * SPRITE_SET_BYTES
    const pair0 = baseAddr
    const pair1 = baseAddr + PALETTE_ENTRY_BYTES
    const rows: RgbaRow[] = [
      readEntry(rom, pair0,                          PALETTE_ROW_COLORS),  // row 4
      readEntry(rom, pair0 + PALETTE_ROW_COLORS * 2, PALETTE_ROW_COLORS),  // row 5
      readEntry(rom, pair1,                          PALETTE_ROW_COLORS),  // row 6
      readEntry(rom, pair1 + PALETTE_ROW_COLORS * 2, PALETTE_ROW_COLORS),  // row 7
    ]
    spriteSetVariants.push({ label: `Set ${set}`, rows, romAddr: baseAddr })
  }

  const groups: PaletteGroup[] = [

    // ── Background ────────────────────────────────────────────────────────────
    // Variant index = bgPaletteRow from level header (byte 0 bits 7-5).
    // variants[0] → $B0B0, variants[1] → $B0C8 (level $104), variants[2] → $B0E0, …
    {
      id: 'bg0', label: 'Layer 2 Background (Row 0)', cgRamRow: 0,
      description: 'CGRAM row 0 — BG tile colors. Variant selected by BG palette row (level header byte 0 bits 7-5).',
      variants: [
        singleVariant('Variant 0', ADDR_BG0, rom, PALETTE_ROW_COLORS),  // $B0B0
        ...bgRow0ExtraVariants,                                           // $B0C8, $B0E0, …
      ],
    },
    {
      id: 'bg1', label: 'Layer 2 Background (Row 1)', cgRamRow: 1,
      description: 'CGRAM row 1 — BG tile colors second row. Same variant index as row 0.',
      variants: [
        singleVariant('Variant 0', ADDR_BG1, rom, PALETTE_ROW_COLORS),  // $B0BC
        ...bgRow1ExtraVariants,                                           // $B0D4, $B0EC, …
      ],
    },

    // ── Foreground ────────────────────────────────────────────────────────────
    // FG palette variant = level header byte 3 bits 2-0 (= spriteSet & 0x07).
    // Variants 1–5 are loaded speculatively from $B1C0–$B2C7 (every other 24-byte
    // entry). Use fg_palette_source.lua in Mesen to verify the addresses.
    {
      id: 'fg0', label: 'Layer 1 Foreground (Row 2)', cgRamRow: 2,
      description: 'CGRAM row 2 — FG tile colors. ' +
        'Variant = spriteSet & 0x07 (level header byte 3 bits 2-0). ' +
        'Variants 1–5 loaded from $B1C0+ (⚠ addresses unverified).',
      variants: [
        singleVariant('Variant 0', ADDR_FG0, rom, PALETTE_ROW_COLORS),
        ...fgExtraRow2,
      ],
    },
    {
      id: 'fg1', label: 'Layer 1 Foreground (Row 3)', cgRamRow: 3,
      description: 'CGRAM row 3 — FG tile colors second row. Same variant index as row 2.',
      variants: [
        singleVariant('Variant 0', ADDR_FG1, rom, PALETTE_ROW_COLORS),
        ...fgExtraRow3,
      ],
    },

    // ── Sprite palette sets (rows 4–7, indexed) ───────────────────────────────
    {
      id: 'sprite_sets', label: 'Sprite Palettes (Rows 4–7)', cgRamRow: 4,
      description: 'CGRAM rows 4–7 — 4 sprite palette rows per set (row 8 is dynamic). ' +
        'Set selected by sprite palette field (level header byte 3 bits 5-4, values 0–3). ' +
        'Each variant shows all 4 rows for that set.',
      variants: spriteSetVariants,
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
    {
      id: 'sp_e', label: 'Sprite Palette E', cgRamRow: 14,
      description: 'CGRAM row 14 — shared sprite colors. Always loaded.',
      variants: [singleVariant('Palette E', ADDR_SP_E, rom)],
    },
    {
      id: 'sp_f', label: 'Sprite Palette F', cgRamRow: 15,
      description: 'CGRAM row 15 — shared sprite colors. Always loaded.',
      variants: [singleVariant('Palette F', ADDR_SP_F, rom)],
    },

  ]

  // Row 8 base: shared colors at cols 2–13, present before player variant overlay.
  const playerRow8Base = readEntry(rom, ADDR_PLAYER_ROW8_BASE, PLAYER_ROW8_BASE_COLS, 2)

  return { groups, backAreaColor, playerRow8Base }
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

  const bg0 = palettes.groups.find(g => g.id === 'bg0')
  const bg1 = palettes.groups.find(g => g.id === 'bg1')
  const fg0 = palettes.groups.find(g => g.id === 'fg0')
  const fg1 = palettes.groups.find(g => g.id === 'fg1')
  const sp  = palettes.groups.find(g => g.id === 'sprite_sets')
  const pl  = palettes.groups.find(g => g.id === 'player')
  const se  = palettes.groups.find(g => g.id === 'sp_e')
  const sf  = palettes.groups.find(g => g.id === 'sp_f')

  // Clamp indices to available variant count to avoid undefined
  const bg0Idx = bg0 ? Math.min(bgVariant, bg0.variants.length - 1) : 0
  const bg1Idx = bg1 ? Math.min(bgVariant, bg1.variants.length - 1) : 0
  const fg0Idx = fg0 ? Math.min(fgVariant, fg0.variants.length - 1) : 0
  const fg1Idx = fg1 ? Math.min(fgVariant, fg1.variants.length - 1) : 0
  const spIdx  = sp  ? Math.min(spriteSet,  sp.variants.length  - 1) : 0

  if (bg0) rows[0] = bg0.variants[bg0Idx]?.rows[0] ?? emptyRow()
  if (bg1) rows[1] = bg1.variants[bg1Idx]?.rows[0] ?? emptyRow()
  if (fg0) rows[2] = fg0.variants[fg0Idx]?.rows[0] ?? emptyRow()
  if (fg1) rows[3] = fg1.variants[fg1Idx]?.rows[0] ?? emptyRow()

  if (sp) {
    const spVariant = sp.variants[spIdx]
    if (spVariant) {
      for (let r = 0; r < SPRITE_SET_ROWS; r++) {
        rows[4 + r] = spVariant.rows[r] ?? emptyRow()
      }
    }
  }

  // Row 8: start from the shared base ($B2B0, cols 2–13), then overlay player variant
  // cols 6–F from the selected variant ($B2C8+). Cols 2–5 remain as the base "skin tones".
  rows[8] = [...(palettes.playerRow8Base ?? emptyRow())]
  if (pl) {
    const variantRow = pl.variants[Math.min(marioVariant, pl.variants.length - 1)]?.rows[0]
    if (variantRow) {
      for (let c = PLAYER_COL_START; c < COLORS_PER_ROW; c++) {
        if (variantRow[c]) rows[8][c] = variantRow[c]
      }
    }
  }
  if (se) rows[14] = se.variants[0]?.rows[0] ?? emptyRow()
  if (sf) rows[15] = sf.variants[0]?.rows[0] ?? emptyRow()

  // SMW writes the back-area color into col 1 of every CGRAM row at level load.
  // Col 0 stays transparent (hardware); col 1 is the "background" fill color.
  // Rows 0–7 (BG/FG/sprite): back-area color from the level's tileset/variant
  //   (⚠ exact source unconfirmed; $B0A0+bgVariant*2 currently used as best estimate).
  // Rows 8–15 (secondary sprite/player/shared): SMW uses $7FFF (pure white).
  //   This is consistent across all levels and confirmed by CGRAM dump.
  const WHITE: RgbaColor = [248, 248, 248, 255]  // BGR555 $7FFF
  for (let r = 0; r < 8;  r++) rows[r][1]  = palettes.backAreaColor
  for (let r = 8; r < 16; r++) rows[r][1]  = WHITE

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
    return buf ? bgr555ToRgba(buf.readUInt16LE(0)) : (UNKNOWN as RgbaColor)
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
