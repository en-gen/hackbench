/**
 * SpriteDispatch.ts -- where one ROM keeps its sprite INIT and MAIN pointer
 * tables, and what a given id resolves to. The tables are READ from the ROM's
 * own dispatch code (HandleSprite -> CallSpriteInit / CallSpriteMain), not
 * assumed at a vanilla address, so a hack that moved a table is followed.
 *
 * Fixed entry points, each byte-checked against the shape the runner depends
 * on and refused with a reason when it differs: the sprite loop ($01:808C,
 * `resolveLoop`, which also yields the setup and HandleSprite addresses),
 * InitSpriteTables ($07:F7D2, `checkInitTables`) and GetRand ($01:ACF9,
 * `checkGetRand`). SMWDisX bank_01.asm:98-125, bank_07.asm:1006,
 * bank_01.asm:6092. The level loader's entries are checked in LevelLoader.ts.
 */
import type { RomFile } from '../../RomFile'
import { loromToOffset } from '../../addressing'
import { bytesAt, shapeMatches } from './Guards'

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
  /** Default HandleSprite address (bank_01.asm:181); `resolveLoop` reads the real one from the loop. */
  handleSprite: 0x018127,
  /** JSL: GetRand, two steps of the RNG at `$148B/C` (bank_01.asm:6092). */
  getRand: 0x01acf9,
} as const

/** Entries in each table. Ids past this read bytes that are not pointers. */
export const SPRITE_TABLE_COUNT = 201

export interface SpriteTables {
  initTable: number
  mainTable: number
}

export type TablesResult = { ok: true; tables: SpriteTables } | { ok: false; reason: string }

const bytes = (rom: RomFile, a: number, n: number): number[] | null => bytesAt(rom, a, n)
const matches = shapeMatches

export type ShapeResult = { ok: true } | { ok: false; reason: string }

/** InitSpriteTables: JSL ZeroSpriteTables / JSL LoadSpriteTables / RTL (bank_07.asm:1006). */
export function checkInitTables(rom: RomFile): ShapeResult {
  const b = bytes(rom, ENTRY.initSpriteTables, 9)
  return matches(b, [0x22, null, null, null, 0x22, null, null, null, 0x6b])
    ? { ok: true }
    : { ok: false, reason: 'InitSpriteTables is not JSL / JSL / RTL' }
}

/** GetRand: PHY LDY #1 JSL step DEY JSL step PLY RTL (bank_01.asm:6092). */
export function checkGetRand(rom: RomFile): ShapeResult {
  const b = bytes(rom, ENTRY.getRand, 14)
  return matches(b, [0x5a, 0xa0, 0x01, 0x22, null, null, 0x01, 0x88, 0x22, null, null, 0x01, 0x7a, 0x6b]) // prettier-ignore
    ? { ok: true }
    : { ok: false, reason: 'GetRand is not the two-step shape this runner knows' }
}

export type LoopResult = { ok: true; setup: number; handle: number } | { ok: false; reason: string }

/**
 * Checks the game's sprite loop at `ENTRY.spriteLoop` is the shape the runner
 * relies on (PHB PHK PLB, then a countdown over slots that does STX $15E9, JSR
 * setup, JSR handle) and RESOLVES the setup and HandleSprite addresses from its
 * two JSR operands. A loop that differs is refused, not guessed at.
 */
export function resolveLoop(rom: RomFile): LoopResult {
  const b = bytes(rom, ENTRY.spriteLoop, 64)
  if (!matches(b, [0x8b, 0x4b, 0xab])) return { ok: false, reason: 'sprite loop does not start PHB PHK PLB' } // prettier-ignore
  // LDX #$0B / STX $15E9 / JSR setup / JSR handle / DEX / BPL back
  const core = [0xa2, 0x0b, 0x8e, 0xe9, 0x15, 0x20, null, null, 0x20, null, null, 0xca, 0x10, 0xf4]
  for (let i = 3; i + core.length <= b!.length; i++) {
    if (!matches(b!.slice(i), core)) continue
    return { ok: true, setup: 0x010000 | (b![i + 6] | (b![i + 7] << 8)), handle: 0x010000 | (b![i + 9] | (b![i + 10] << 8)) } // prettier-ignore
  }
  return { ok: false, reason: 'sprite loop is not the countdown shape this runner knows' }
}

/** Reads both table bases from the dispatch code, or says what did not match. */
export function resolveTables(rom: RomFile, handle: number = ENTRY.handleSprite): TablesResult {
  // HandleSprite: LDA $14C8,X / BEQ / CMP #$08 / BNE +3 / JMP CallSpriteMain / JSL ExecutePtr / table
  const h = bytes(rom, handle, 16 + 4)
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
