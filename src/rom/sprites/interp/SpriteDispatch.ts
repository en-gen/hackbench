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
  /**
   * JSL: GenSpriteFromBlk (bank_02.asm:1122-1292), the item block's own spawn: finds a free
   * slot, writes the status and sprite number from its tables, runs InitSpriteTables and then
   * places the sprite and writes its spawn cells. `resolveBlockSpawn` byte-checks it (#566).
   */
  genSpriteFromBlk: 0x028905,
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

/**
 * GenSpriteFromBlk's two fixed shapes (bank_02.asm:1122-1142): the free-slot countdown
 * (LDX #$0B / LDA SpriteStatus,X / BEQ / DEX / CPX #$FF / BNE) and, at CODE_028922, the
 * status write (STX abs / LDY _5 / LDA abs,Y / STA SpriteStatus,X). Anything else is refused.
 */
export function resolveBlockSpawn(
  rom: RomFile,
): { ok: true; entry: number } | { ok: false; reason: string } {
  // prettier-ignore
  const head = bytes(rom, ENTRY.genSpriteFromBlk, 12)
  if (!matches(head, [0xa2, 0x0b, 0xbd, 0xc8, 0x14, 0xf0, null, 0xca, 0xe0, 0xff, 0xd0, null]))
    return { ok: false, reason: 'the item block spawn routine does not start with the free-slot countdown this reader knows' } // prettier-ignore
  const status = bytes(rom, ENTRY.genSpriteFromBlk + 0x1d, 11)
  if (!matches(status, [0x8e, null, null, 0xa4, 0x05, 0xb9, null, null, 0x9d, 0xc8, 0x14]))
    return { ok: false, reason: 'the item block spawn routine does not write the sprite status the way this reader knows' } // prettier-ignore
  return { ok: true, entry: ENTRY.genSpriteFromBlk }
}

/** GetRand: PHY LDY #1 JSL step DEY JSL step PLY RTL (bank_01.asm:6092). */
export function checkGetRand(rom: RomFile): ShapeResult {
  const b = bytes(rom, ENTRY.getRand, 14)
  // The two JSL banks are $01 or its FastROM mirror $81 (36 of 101 SMWC hacks); same code.
  const ok =
    matches(b, [
      0x5a,
      0xa0,
      0x01,
      0x22,
      null,
      null,
      null,
      0x88,
      0x22,
      null,
      null,
      null,
      0x7a,
      0x6b,
    ]) &&
    (b![6] & 0x7f) === 0x01 &&
    (b![11] & 0x7f) === 0x01
  return ok
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
  // More than one match means we cannot say which one runs: unavailable, not a guess.
  const hits: number[] = []
  for (let i = 3; i + core.length <= b!.length; i++) if (matches(b!.slice(i), core)) hits.push(i)
  if (hits.length > 1)
    return { ok: false, reason: 'sprite loop countdown matches more than once; which one runs is unknown' } // prettier-ignore
  if (hits.length === 0)
    return { ok: false, reason: 'sprite loop is not the countdown shape this runner knows' }
  const i = hits[0]
  return { ok: true, setup: 0x010000 | (b![i + 6] | (b![i + 7] << 8)), handle: 0x010000 | (b![i + 9] | (b![i + 10] << 8)) } // prettier-ignore
}

/**
 * ExecutePtr, the 16-bit pointer-table jump (bank_00.asm:847): STY / PLY / STY /
 * REP #$30 / AND #$00FF / ASL / TAY / PLA / STA / INY / LDA [dp],Y / STA /
 * SEP #$30 / LDY / JML [dp]. The inline tables after each JSL are read as 16-bit
 * words only if the call really reaches this; ExecutePtrLong (24-bit entries) has a
 * different body and is refused.
 */
const EXECUTE_PTR_SHAPE: (number | null)[] = [
  0x84,
  null,
  0x7a,
  0x84,
  null,
  0xc2,
  0x30,
  0x29,
  0xff,
  0x00,
  0x0a,
  0xa8,
  0x68,
  0x85,
  null,
  0xc8,
  0xb7,
  null,
  0x85,
  null,
  0xe2,
  0x30,
  0xa4,
  null,
  0xdc,
  null,
  0x00,
]

/** The three dispatch JSLs (HandleSprite, CallSpriteInit, CallSpriteMain) must reach one ExecutePtr. */
function checkExecutePtr(rom: RomFile, jsl: number[][]): ShapeResult {
  // Normalise the FastROM mirror: $80+ banks are the same code.
  const targets = jsl.map(t => ((t[2] & 0x7f) << 16) | (t[1] << 8) | t[0])
  if (new Set(targets).size !== 1)
    return { ok: false, reason: 'the dispatch calls do not all reach the same routine' }
  if (!matches(bytes(rom, targets[0], EXECUTE_PTR_SHAPE.length), EXECUTE_PTR_SHAPE))
    return { ok: false, reason: 'the dispatch calls do not reach the 16-bit ExecutePtr' }
  return { ok: true }
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
  const ep = checkExecutePtr(rom, [h!.slice(13, 16), i!.slice(8, 11), m!.slice(6, 9)])
  if (!ep.ok) return ep
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
