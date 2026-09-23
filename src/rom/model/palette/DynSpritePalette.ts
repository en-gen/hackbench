import type { RomFile } from '../../RomFile'
import { bgr555ToRgba, type RgbaColor } from '../../GraphicsDecoder'

/**
 * A sprite palette the game writes into CGRAM at runtime, instead of one the
 * level's static palette supplies. `DynPaletteTable` (rammap.asm:1157-1164)
 * carries a CGRAM *colour index*, not a byte address (bank_00.asm:4735), and
 * an entry may cover only part of a 16-colour row, so consumers composite.
 * Derivation: docs/sprites/sprite-1f-magikoopa.md section 4.
 */
export interface DynSpritePalette {
  /** SNES address of the source colour table. */
  addr: number
  /** Colours per entry = the header's byte count / 2. */
  colorsPerEntry: number
  /** Entries in the table. `addr + entryCount * colorsPerEntry * 2` is its end. */
  entryCount: number
  /** The header's CGRAM word address: the first colour index overwritten. */
  cgramStart: number
  /**
   * Entry left in CGRAM while the sprite is idle and visible, on an unmodified
   * cart. Prefer {@link resolveRestingEntry}, which re-reads it.
   */
  restingEntry: number
  /**
   * SNES address of the `CMP #imm` that ends the fade-in by branching PAST the
   * upload; the last entry uploaded is `imm - 2`. Omit when the fade shape is
   * not known.
   */
  restingEntryCmpAddr?: number
}

/**
 * `MagiKoopaPals` - the teleport fade ramp for sprite $1F, uploaded by
 * `CODE_01C028` (bank_01.asm:8733) to CGRAM $F0..$F7 = row 15 columns 0-7.
 *
 * Only the colour bytes are read from the cart at runtime; `addr`,
 * `colorsPerEntry`, `entryCount` and `cgramStart` are hardcoded literals.
 * docs/sprites/sprite-1f-magikoopa.md section 4 has the per-field derivation table,
 * why `restingEntryCmpAddr` is $01:C01C and not the identical-looking
 * `CMP #$09` at $01:C014, and the CGRAM slot this shares with `BooBossPals`.
 */
export const MAGIKOOPA_PALS: DynSpritePalette = {
  addr: 0x03b902,
  colorsPerEntry: 8,
  entryCount: 8,
  cgramStart: 0xf0,
  restingEntry: 7,
  restingEntryCmpAddr: 0x01c01c,
}

/** CGRAM row the entry lands in. CGRAM is 16 rows of 16 colours. */
export function dynPalRow(pal: DynSpritePalette): number {
  return pal.cgramStart >> 4
}

/** First column within that row. Non-zero would mean a mid-row splice. */
export function dynPalFirstCol(pal: DynSpritePalette): number {
  return pal.cgramStart & 0x0f
}

/** 65C816 `CMP #imm` (immediate addressing) opcode. */
const OP_CMP_IMM = 0xc9

/**
 * Which entry this cart's fade actually leaves in CGRAM: the terminal `CMP`
 * immediate minus 2, falling back to the descriptor's literal when the routine
 * does not have the expected shape. See docs/sprites/sprite-1f-magikoopa.md section 4.
 *
 * Evidence scope: all six carts in `test/roms/` hold `C9 09` at $01:C01C, so
 * this returns 7 for every ROM tested today. It exists so a hack that shortens
 * the fade cannot silently leave the editor showing the wrong rung.
 */
export function resolveRestingEntry(rom: RomFile, pal: DynSpritePalette): number {
  if (pal.restingEntryCmpAddr === undefined) return pal.restingEntry
  const buf = rom.readAt(pal.restingEntryCmpAddr, 2)
  if (!buf || buf[0] !== OP_CMP_IMM) return pal.restingEntry
  const entry = buf[1] - 2
  if (entry < 0 || entry >= pal.entryCount) return pal.restingEntry
  return entry
}

/**
 * Read one entry as raw BGR555 words, or null when the entry is out of range
 * or the read falls off the cart. Byte-indexed on purpose: `RomFile.buffer` is
 * a plain `Uint8Array` on the webview side (RomFile.ts:22-31), where
 * `readUInt16LE` would throw a TypeError.
 */
export function readDynPalEntry(
  rom: RomFile,
  pal: DynSpritePalette,
  entry: number,
): number[] | null {
  if (entry < 0 || entry >= pal.entryCount) return null
  const bytes = pal.colorsPerEntry * 2
  const buf = rom.readAt(pal.addr + entry * bytes, bytes)
  if (!buf) return null
  return Array.from({ length: pal.colorsPerEntry }, (_, i) => buf[i * 2] | (buf[i * 2 + 1] << 8))
}

/**
 * Overlay `colors` (BGR555 words) onto a copy of `base` starting at `firstCol`.
 * `base` must not be mutated: `Palette.row()` hands back a shared scratch
 * buffer. `out` is the caller's own scratch, so the render path allocates none.
 */
export function compositeDynPalRow(
  base: readonly RgbaColor[],
  colors: readonly RgbaColor[],
  firstCol: number,
  out: RgbaColor[],
): RgbaColor[] {
  for (let i = 0; i < base.length; i++) out[i] = base[i]
  out.length = base.length
  for (let i = 0; i < colors.length; i++) {
    const c = firstCol + i
    if (c < out.length) out[c] = colors[i]
  }
  return out
}

/** BGR555 words -> RGBA, via the shared bit-replicating converter. */
export function dynPalToRgba(words: readonly number[]): RgbaColor[] {
  return words.map(bgr555ToRgba)
}
