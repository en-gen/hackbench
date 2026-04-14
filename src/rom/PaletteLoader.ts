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
 *   $00B0B0        BG palette pair 0  (rows 0+1 variant 0)
 *   $00B0C8        BG palette pair 0  (row 1)
 *   $00B190        FG palette pair 0  (rows 2+3 variant 0)
 *   $00B1A8        FG palette pair 0  (row 3)
 *   $00B2C8        Player palettes (20 B each): Mario/Luigi/Fire Mario/Fire Luigi
 *   $00B318        Sprite palette E
 *   $00B330        Sprite palette F
 *   $00B348        Sprite palette sets 0–7 (8 sets × 5 rows × 24 B = 960 B)
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
export const PALETTE_ENTRY_BYTES  = 24   // 12 colors × 2 bytes (indices 1–12)
export const PALETTE_ENTRY_COLORS = 12
// Player palettes are shorter — only 10 colors stored (indices 1–10)
export const PLAYER_ENTRY_BYTES   = 20
export const PLAYER_ENTRY_COLORS  = 10

// Verified ROM addresses
export const ADDR_BACK_AREA   = 0x00B0A0
export const ADDR_BG0         = 0x00B0B0  // BG CGRAM row 0 variant 0
export const ADDR_BG1         = 0x00B0C8  // BG CGRAM row 1 variant 0
export const ADDR_FG0         = 0x00B190  // FG CGRAM row 2 variant 0
export const ADDR_FG1         = 0x00B1A8  // FG CGRAM row 3 variant 0
export const ADDR_PLAYER_MARIO      = 0x00B2C8
export const ADDR_PLAYER_LUIGI      = 0x00B2DC
export const ADDR_PLAYER_FIRE_MARIO = 0x00B2F0
export const ADDR_PLAYER_FIRE_LUIGI = 0x00B304
export const ADDR_SP_E        = 0x00B318
export const ADDR_SP_F        = 0x00B330
// Sprite palette sets: 8 sets × 5 rows × 24 bytes starting here
export const ADDR_SPRITE_SETS = 0x00B348
export const SPRITE_SET_COUNT = 8
export const SPRITE_SET_ROWS  = 5   // CGRAM rows 4–8
export const SPRITE_SET_BYTES = SPRITE_SET_ROWS * PALETTE_ENTRY_BYTES  // 120 bytes/set

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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRANSPARENT: RgbaColor = [0, 0, 0, 0]
const UNKNOWN: RgbaColor     = [40, 40, 40, 255]

function emptyRow(): RgbaRow {
  return Array.from({ length: COLORS_PER_ROW }, (_, i) => i === 0 ? TRANSPARENT : UNKNOWN)
}

function readEntry(rom: RomFile, addr: number, numColors = PALETTE_ENTRY_COLORS): RgbaRow {
  const row = emptyRow()
  const bytes = numColors * 2
  const buf = rom.readAt(addr, bytes)
  if (!buf) return row
  for (let i = 0; i < numColors; i++) {
    row[i + 1] = bgr555ToRgba(buf.readUInt16LE(i * 2))
  }
  return row
}

function singleVariant(label: string, addr: number, rom: RomFile, numColors = PALETTE_ENTRY_COLORS): PaletteVariant {
  return { label, rows: [readEntry(rom, addr, numColors)], romAddr: addr }
}

function unknownVariant(label: string): PaletteVariant {
  return { label, rows: [emptyRow()], romAddr: null }
}

// ── Main loader ───────────────────────────────────────────────────────────────

export function loadRomPalettes(rom: RomFile): RomPalettes {
  const backBuf = rom.readAt(ADDR_BACK_AREA, 2)
  const backAreaColor: RgbaColor = backBuf
    ? bgr555ToRgba(backBuf.readUInt16LE(0))
    : UNKNOWN

  // ── Intermediate BG region ($B0E0–$B18F, 160 bytes) ────────────────────────
  // Structure not fully verified. Contains additional BG/palette variants.
  // Shown as numbered entries; labels may be refined with future research.
  const bgExtraVariants: PaletteVariant[] = []
  for (let i = 0; i * PALETTE_ENTRY_BYTES < 0x00B190 - 0x00B0E0; i++) {
    const addr = 0x00B0E0 + i * PALETTE_ENTRY_BYTES
    bgExtraVariants.push(singleVariant(`Entry ${i} ⚠`, addr, rom))
  }

  // ── Intermediate sprite/misc region ($B1C0–$B2C7, 264 bytes, 11 entries) ──
  // Likely contains CGRAM rows 9–12 variants (berry, Yoshi, sprite rows).
  const miscVariants: PaletteVariant[] = []
  for (let i = 0; i * PALETTE_ENTRY_BYTES < 0x00B2C8 - 0x00B1C0; i++) {
    const addr = 0x00B1C0 + i * PALETTE_ENTRY_BYTES
    miscVariants.push(singleVariant(`Entry ${i} ⚠`, addr, rom))
  }

  // ── Sprite palette sets (CGRAM rows 4–8, indexed by sprite palette 0–7) ───
  // Level header byte 3 bits 5-3 selects the sprite palette (0–7).
  // Each set covers 5 consecutive CGRAM rows (rows 4, 5, 6, 7, 8).
  const spriteSetVariants: PaletteVariant[] = []
  for (let set = 0; set < SPRITE_SET_COUNT; set++) {
    const baseAddr = ADDR_SPRITE_SETS + set * SPRITE_SET_BYTES
    const rows: RgbaRow[] = []
    for (let row = 0; row < SPRITE_SET_ROWS; row++) {
      rows.push(readEntry(rom, baseAddr + row * PALETTE_ENTRY_BYTES))
    }
    spriteSetVariants.push({ label: `Set ${set}`, rows, romAddr: baseAddr })
  }

  const groups: PaletteGroup[] = [

    // ── Background ────────────────────────────────────────────────────────────
    {
      id: 'bg0', label: 'Layer 2 Background (Row 0)', cgRamRow: 0,
      description: 'CGRAM row 0 — BG tile colors. Variant selected by BG palette row (level header byte 0 bits 7-5).',
      variants: [
        singleVariant('BG Palette 0', ADDR_BG0, rom),
        ...bgExtraVariants.filter((_, i) => i % 2 === 0),  // even entries (row 0 candidates)
      ],
    },
    {
      id: 'bg1', label: 'Layer 2 Background (Row 1)', cgRamRow: 1,
      description: 'CGRAM row 1 — BG tile colors second row.',
      variants: [
        singleVariant('BG Palette 1', ADDR_BG1, rom),
        ...bgExtraVariants.filter((_, i) => i % 2 === 1),  // odd entries (row 1 candidates)
      ],
    },

    // ── Foreground ────────────────────────────────────────────────────────────
    {
      id: 'fg0', label: 'Layer 1 Foreground (Row 2)', cgRamRow: 2,
      description: 'CGRAM row 2 — FG tile colors. Variant selected by FG palette set (level header byte 3 bits 2-0).',
      variants: [
        singleVariant('FG Palette 0', ADDR_FG0, rom),
        unknownVariant('FG Variant 1 ⚠'),
        unknownVariant('FG Variant 2 ⚠'),
        unknownVariant('FG Variant 3 ⚠'),
      ],
    },
    {
      id: 'fg1', label: 'Layer 1 Foreground (Row 3)', cgRamRow: 3,
      description: 'CGRAM row 3 — FG tile colors second row.',
      variants: [
        singleVariant('FG Palette 1', ADDR_FG1, rom),
        unknownVariant('FG Row 3 Variant 1 ⚠'),
        unknownVariant('FG Row 3 Variant 2 ⚠'),
        unknownVariant('FG Row 3 Variant 3 ⚠'),
      ],
    },

    // ── Sprite palette sets (rows 4–8, indexed) ───────────────────────────────
    {
      id: 'sprite_sets', label: 'Sprite Palettes (Rows 4–8)', cgRamRow: 4,
      description: 'CGRAM rows 4–8 — 5 sprite palette rows per set. ' +
        'Set selected by Sprite palette field (level header byte 3 bits 5-3, values 0–7). ' +
        'Each variant shows all 5 rows for that set.',
      variants: spriteSetVariants,
    },

    // ── Intermediate palette area (rows 9–12 region) ──────────────────────────
    {
      id: 'misc_palettes', label: 'Rows 9–12 Area ⚠', cgRamRow: 9,
      description: 'CGRAM rows 9–12 area ($B1C0–$B2C7). ' +
        'Likely contains berry objects (row 9), Yoshi/misc (row 10), and additional sprite rows (11–12). ' +
        'Exact variant assignment not yet verified.',
      variants: miscVariants,
    },

    // ── Player ────────────────────────────────────────────────────────────────
    {
      id: 'player', label: 'Player Palettes', cgRamRow: 13,
      description: 'CGRAM row 13 — Mario/Luigi variants. 20 bytes each (10 colors, indices 1–10).',
      variants: [
        singleVariant('Mario',      ADDR_PLAYER_MARIO,      rom, PLAYER_ENTRY_COLORS),
        singleVariant('Luigi',      ADDR_PLAYER_LUIGI,      rom, PLAYER_ENTRY_COLORS),
        singleVariant('Fire Mario', ADDR_PLAYER_FIRE_MARIO, rom, PLAYER_ENTRY_COLORS),
        singleVariant('Fire Luigi', ADDR_PLAYER_FIRE_LUIGI, rom, PLAYER_ENTRY_COLORS),
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

  return { groups, backAreaColor }
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

  if (pl) rows[13] = pl.variants[0]?.rows[0] ?? emptyRow()
  if (se) rows[14] = se.variants[0]?.rows[0] ?? emptyRow()
  if (sf) rows[15] = sf.variants[0]?.rows[0] ?? emptyRow()

  return {
    colors: rows.flat(),
    rows,
    bgVariantIndex: bgVariant,
    fgVariantIndex: fgVariant,
    spriteSetIndex: spriteSet,
  }
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
