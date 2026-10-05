/**
 * SpriteDispatch.ts -- where one ROM keeps its sprite INIT and MAIN pointer
 * tables, and what a given id resolves to. The tables are READ from the ROM's
 * own dispatch code (HandleSprite -> CallSpriteInit / CallSpriteMain), not
 * assumed at a vanilla address, so a hack that moved a table is followed.
 *
 * Only three entry points are fixed: the routines the game's own sprite loop
 * calls (SMWDisX bank_01.asm:119-181 and bank_07.asm:1006). Each is verified
 * against the byte shape the reader depends on and refused when it differs.
 */
import type { RomFile } from '../../RomFile'
import { loromToOffset } from '../../addressing'

export const ENTRY = {
  /** JSL: ZeroSpriteTables + LoadSpriteTables (bank_07.asm:1006). */
  initSpriteTables: 0x07f7d2,
  /**
   * JSL: the game's own per-frame sprite loop. Sets DB to bank 1 (PHK PLB),
   * then for slots $0B..0 runs the OAM-index and timer setup and HandleSprite
   * (bank_01.asm:98-125). A routine that reads a bank-1 table through DB only
   * works under it, which is why the runner calls this and not HandleSprite.
   */
  spriteLoop: 0x01808c,
  /** The dispatcher the loop calls, read by `resolveTables` (bank_01.asm:181). */
  handleSprite: 0x018127,
} as const

/** Entries in each table. Ids past this read bytes that are not pointers. */
export const SPRITE_TABLE_COUNT = 201

export interface SpriteTables {
  initTable: number
  mainTable: number
}

export type TablesResult = { ok: true; tables: SpriteTables } | { ok: false; reason: string }

const bytes = (rom: RomFile, a: number, n: number): number[] | null => {
  const b = rom.readAt(a, n)
  return b ? [...b] : null
}
const matches = (got: number[] | null, want: (number | null)[]): boolean =>
  !!got && want.every((w, i) => w === null || got[i] === w)

/** Reads both table bases from the dispatch code, or says what did not match. */
export function resolveTables(rom: RomFile): TablesResult {
  // HandleSprite: LDA $14C8,X / BEQ / CMP #$08 / BNE +3 / JMP CallSpriteMain / JSL ExecutePtr / table
  const h = bytes(rom, ENTRY.handleSprite, 16 + 4)
  if (!matches(h, [0xbd, 0xc8, 0x14, 0xf0, null, 0xc9, 0x08, 0xd0, 0x03, 0x4c, null, null, 0x22]))
    return { ok: false, reason: 'HandleSprite is not the dispatch shape this reader knows' }
  const mainEntry = 0x010000 | (h![10] | (h![11] << 8))
  // Status 1 (INIT) is the second word of the status table that follows the JSL.
  const initEntry = 0x010000 | (h![18] | (h![19] << 8))
  // CallSpriteInit: LDA #$08 / STA $14C8,X / LDA $9E,X / JSL ExecutePtr / table
  const i = bytes(rom, initEntry, 11)
  if (!matches(i, [0xa9, 0x08, 0x9d, 0xc8, 0x14, 0xb5, 0x9e, 0x22]))
    return { ok: false, reason: 'CallSpriteInit is not the dispatch shape this reader knows' }
  // CallSpriteMain: STZ abs / LDA $9E,X / JSL ExecutePtr / table
  const m = bytes(rom, mainEntry, 9)
  if (!matches(m, [0x9c, null, null, 0xb5, 0x9e, 0x22]))
    return { ok: false, reason: 'CallSpriteMain is not the dispatch shape this reader knows' }
  return { ok: true, tables: { initTable: initEntry + 11, mainTable: mainEntry + 9 } }
}

export interface ResolvedHandler {
  /** Pointer word and the bank-1 address it names. */
  pointer: number
  address: number
}

/** Pointer for `id` in one table, refusing past the table or into non-code. */
export function resolvePointer(
  rom: RomFile,
  table: number,
  id: number,
): { ok: true; handler: ResolvedHandler } | { ok: false; reason: string } {
  if (id < 0 || id >= SPRITE_TABLE_COUNT)
    return { ok: false, reason: `id $${id.toString(16)} is past the ${SPRITE_TABLE_COUNT}-entry pointer table` } // prettier-ignore
  const w = rom.readWord(table + id * 2)
  if (w === null) return { ok: false, reason: 'pointer table is not readable' }
  const address = 0x010000 | w
  // A code pointer lands in the cart's upper half; below $8000 is registers or WRAM.
  if (w < 0x8000 || loromToOffset(address, rom.romSize) === null)
    return { ok: false, reason: `pointer $${w.toString(16)} is not in ROM code` }
  return { ok: true, handler: { pointer: w, address } }
}
