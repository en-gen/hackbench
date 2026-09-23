/**
 * PaletteStockTables.ts -- per-cell table attribution for a read-only
 * "which ROM table supplies this CGRAM cell" view.
 *
 * loadRomPalettes()'s own per-group rows only cover each group's primary
 * columns (e.g. BackgroundPalettes' cols 2-7); the rest of a 16-wide row
 * comes from tables it reads but returns separately (bgSecondaryCols,
 * berryCols) or, for column 1, from a routine (LoadCol8Pal) that runs
 * before any table is touched at all. This module
 * merges all of that per cell rather than leaving the extra columns as
 * unattributed filler, and names the table that actually supplied each one.
 *
 * The written/unwritten boundary for columns 2-15 reuses
 * CgramOracle.ROM_WRITTEN_INDICES rather than a second hand-derived copy,
 * so the two cannot drift apart. Column 0 and column 1 are handled
 * separately below because CgramOracle excludes column 0 from its own
 * comparison for a different reason (it is never sampled by rendering, not
 * that it holds no data) and column 1 is written by a routine rather than a
 * table, so there is no static address for a table lookup to find.
 */

import { RomFile } from './RomFile'
import { RgbaColor, bgr555ToRgba } from './GraphicsDecoder'
import { ROM_WRITTEN_INDICES } from './CgramOracle'
import {
  loadRomPalettes,
  loadBackAreaColors,
  loadCustomLevelPalette,
  PaletteGroup,
  RomPalettes,
  PALETTE_ROW_COLORS,
  BG_SECONDARY_COLORS,
  BG_SECONDARY_COL_START,
  BERRY_COLS_COUNT,
  BERRY_COL_START,
  BERRY_ROWS_A_START,
  BERRY_ROWS_B_START,
  SHARED_SPRITE_COLS,
  PLAYER_COL_START,
  CUSTOM_PALETTE_LEVEL_COUNT,
  ADDR_BG_COLS_8_15,
  ADDR_BERRY_COLS,
  ADDR_SHARED_SPRITES,
  ADDR_BACK_AREA,
} from './PaletteLoader'

export interface AttributedCell {
  written: boolean
  color: RgbaColor | null
  table: string | null
  romAddr: number | null
}

export interface AttributedVariant {
  label: string
  romAddr: number | null
  rows: AttributedCell[][]
}

export interface AttributedGroup {
  id: string
  label: string
  description: string
  cgRamRow: number | null
  variants: AttributedVariant[]
}

// ── Column 1: LoadCol8Pal, not a table ──────────────────────────────────────
//
// bank_00.asm:5595-5604 (LoadPalette) runs LoadCol8Pal before any per-group
// table load, writing column 1 of every CGRAM row from an LDA #imm operand:
// $7FDD for rows 0-7, $7FFF for rows 8-15. Read the operand at its own
// address rather than hardcode it (CLAUDE.md's ASM-is-reference recipe): a
// hack that recolours column 1 changes exactly these bytes, and gating on
// the opcode means a hack that replaces the routine reports unavailable
// instead of the vanilla constant.

const OPCODE_LDA_IMM = 0xa9
/** LDA #$7FDD, bank_00.asm:5597. */
const ADDR_COL1_BG_LDA = 0x00abef
/** LDA #$7FFF, bank_00.asm:5601. */
const ADDR_COL1_OBJ_LDA = 0x00abfa

function readLdaImmWord(rom: RomFile, opcodeAddr: number): number | null {
  const buf = rom.readAt(opcodeAddr, 3)
  if (!buf || buf[0] !== OPCODE_LDA_IMM) return null
  return buf.readUInt16LE(1)
}

function col1Cell(rom: RomFile, cgramRow: number): AttributedCell {
  const addr = cgramRow <= 7 ? ADDR_COL1_BG_LDA : ADDR_COL1_OBJ_LDA
  const word = readLdaImmWord(rom, addr)
  if (word === null) return { written: false, color: null, table: null, romAddr: null }
  return {
    written: true,
    color: bgr555ToRgba(word),
    table: 'LoadPalette (LoadCol8Pal)',
    romAddr: addr,
  }
}

// ── Secondary tables: real bytes, not the group's own (narrower) row ───────

function statusBarCell(palettes: RomPalettes, rowInGroup: number, col: number): AttributedCell {
  const color = rowInGroup <= 1 ? palettes.bgSecondaryCols[rowInGroup]?.[col] : undefined
  if (!color) return { written: false, color: null, table: null, romAddr: null }
  const addr =
    ADDR_BG_COLS_8_15 + rowInGroup * BG_SECONDARY_COLORS * 2 + (col - BG_SECONDARY_COL_START) * 2
  return { written: true, color, table: 'StatusBarColors', romAddr: addr }
}

/** Berry's two spans (bank_00.asm:5680-5697): CGRAM rows 2-4 and 9-11, each mapping to one of 3 berry rows. */
function berryIndexForCgramRow(cgramRow: number): number | null {
  if (cgramRow >= BERRY_ROWS_A_START && cgramRow <= BERRY_ROWS_A_START + 2)
    return cgramRow - BERRY_ROWS_A_START
  if (cgramRow >= BERRY_ROWS_B_START && cgramRow <= BERRY_ROWS_B_START + 2)
    return cgramRow - BERRY_ROWS_B_START
  return null
}

function berryCell(palettes: RomPalettes, cgramRow: number, col: number): AttributedCell {
  const bi = berryIndexForCgramRow(cgramRow)
  const color = bi !== null ? palettes.berryCols[bi]?.[col] : undefined
  if (!color) return { written: false, color: null, table: null, romAddr: null }
  const addr = ADDR_BERRY_COLS + (bi as number) * BERRY_COLS_COUNT * 2 + (col - BERRY_COL_START) * 2
  return { written: true, color, table: 'BerryColors', romAddr: addr }
}

// ── Primary (group-owned) columns: loadRomPalettes already read these ──────

function rowBaseOffset(rowInGroup: number): number {
  return rowInGroup === 0 ? 0 : PALETTE_ROW_COLORS * 2
}

function primaryCell(
  ownRow: RgbaColor[],
  col: number,
  colLo: number,
  colHi: number,
  table: string,
  baseAddr: number | null,
  addrForCol: (col: number) => number,
): AttributedCell {
  if (col < colLo || col > colHi) return { written: false, color: null, table: null, romAddr: null }
  return {
    written: true,
    color: ownRow[col] ?? [0, 0, 0, 255],
    table,
    romAddr: baseAddr !== null ? addrForCol(col) : null,
  }
}

// ── One cell, any group ─────────────────────────────────────────────────────

function buildCell(
  rom: RomFile,
  palettes: RomPalettes,
  groupId: string,
  cgramRow: number,
  rowInGroup: number,
  col: number,
  ownRow: RgbaColor[],
  variantAddr: number | null,
): AttributedCell {
  // No table writes column 0. Back area colors go to COLDATA, not CGRAM $00,
  // which CODE_00922F zeroes before every upload (bank_00.asm:2047-2048); they
  // are the standalone back_area group. Other rows' column 0 is a transparent
  // sentinel the hardware never samples (CgramOracle.ts's EXCLUDED_INDICES).
  if (col === 0) return { written: false, color: null, table: null, romAddr: null }
  if (col === 1) return col1Cell(rom, cgramRow)

  if (!ROM_WRITTEN_INDICES.has(cgramRow * 16 + col)) {
    return { written: false, color: null, table: null, romAddr: null }
  }

  switch (groupId) {
    case 'bg':
      if (col <= 7) {
        return primaryCell(
          ownRow,
          col,
          2,
          7,
          'BackgroundPalettes',
          variantAddr,
          c => (variantAddr as number) + rowBaseOffset(rowInGroup) + (c - 2) * 2,
        )
      }
      return statusBarCell(palettes, rowInGroup, col)
    case 'fg':
      if (col <= 7) {
        return primaryCell(
          ownRow,
          col,
          2,
          7,
          'ForegroundPalettes',
          variantAddr,
          c => (variantAddr as number) + rowBaseOffset(rowInGroup) + (c - 2) * 2,
        )
      }
      return berryCell(palettes, cgramRow, col)
    case 'sprite_sets':
      if (col <= 7) {
        const addr = ADDR_SHARED_SPRITES + rowInGroup * SHARED_SPRITE_COLS * 2
        return primaryCell(ownRow, col, 2, 7, 'StandardColors', addr, c => addr + (c - 2) * 2)
      }
      return berryCell(palettes, cgramRow, col)
    case 'player':
      return primaryCell(
        ownRow,
        col,
        PLAYER_COL_START,
        15,
        'PlayerColors',
        variantAddr,
        c => (variantAddr as number) + (c - PLAYER_COL_START) * 2,
      )
    case 'sp_ef':
      return primaryCell(
        ownRow,
        col,
        2,
        7,
        'SpriteColors',
        variantAddr,
        c => (variantAddr as number) + rowBaseOffset(rowInGroup) + (c - 2) * 2,
      )
    default:
      return { written: false, color: null, table: null, romAddr: null }
  }
}

/**
 * How many levels carry a Lunar Magic custom palette block at $0EF600
 * (ADDR_CUSTOM_PALETTE_TABLE) that these stock tables do not reflect. A
 * hack with any is one this view is honest about being incomplete for:
 * showing vanilla-shaped output under a patched cart's name is the failure
 * CLAUDE.md calls out as the worst outcome available.
 */
export function countCustomPaletteLevels(rom: RomFile): number {
  let count = 0
  for (let i = 0; i < CUSTOM_PALETTE_LEVEL_COUNT; i++) {
    if (loadCustomLevelPalette(rom, i)) count++
  }
  return count
}

/**
 * Back Area Colors, standalone: NOT a palette table and never written into
 * CGRAM. `bank_00.asm:5623-5628` reads `BackAreaColors,Y` and does
 * `STA.W BackgroundColor`; `rammap.asm:1166-1170` names that RAM address
 * ($7E0701) as the value buffer for PPU register $2132 (COLDATA), the
 * fixed colour fed to colour math behind every layer. It shares no CGRAM
 * row with anything else this view shows, which is why every OTHER group
 * states the rows it occupies and this one cannot.
 *
 * Was previously shown as one swatch riding beside each of the 8 Layer 2
 * Background variants, implying a pairing the cartridge does not have: BG
 * palette is level header byte 0 bits 7-5, back area colour is byte 1 bits
 * 7-5 (`bank_05.asm:562-568`), two independent fields. A level can combine
 * BG palette 3 with back area colour 6.
 */
function buildBackAreaGroup(backAreaColors: RgbaColor[]): AttributedGroup {
  const cells: AttributedCell[] = backAreaColors.map((color, i) => ({
    written: true,
    color,
    table: 'BackAreaColors',
    romAddr: ADDR_BACK_AREA + i * 2,
  }))
  return {
    id: 'back_area',
    label: 'Back Area Colors',
    cgRamRow: null,
    description:
      'The 8 fixed background colours, written to PPU register $2132 (COLDATA) rather than ' +
      'to CGRAM. A map chooses among them with level header byte 1 bits 7-5, independent of ' +
      'its BG palette. BackAreaColors at $B0A0.',
    variants: [{ label: 'Fixed', romAddr: ADDR_BACK_AREA, rows: [cells] }],
  }
}

/** Every stock palette table, attributed per cell, for the read-only palette view. */
export function buildStockTables(rom: RomFile): AttributedGroup[] {
  const palettes = loadRomPalettes(rom)
  const backAreaColors = loadBackAreaColors(rom)

  const groups = palettes.groups.map((g: PaletteGroup): AttributedGroup => ({
    id: g.id,
    label: g.label,
    description: g.description,
    cgRamRow: g.cgRamRow,
    variants: g.variants.map((v): AttributedVariant => ({
      label: v.label,
      romAddr: v.romAddr,
      rows: v.rows.map((ownRow, ri) => {
        const cgramRow = g.cgRamRow !== null ? g.cgRamRow + ri : -1
        return Array.from({ length: 16 }, (_, col) =>
          buildCell(rom, palettes, g.id, cgramRow, ri, col, ownRow, v.romAddr),
        )
      }),
    })),
  }))

  // Display order for the palette view; loadRomPalettes keeps CGRAM order.
  groups.push(buildBackAreaGroup(backAreaColors))
  // Unlisted ids sort last rather than vanish.
  const rank = (id: string) => {
    const i = VIEW_ORDER.indexOf(id)
    return i === -1 ? VIEW_ORDER.length : i
  }
  return groups.sort((a, b) => rank(a.id) - rank(b.id))
}

const VIEW_ORDER = ['player', 'sprite_sets', 'sp_ef', 'fg', 'bg', 'back_area']
