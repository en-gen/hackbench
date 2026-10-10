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
 * `checkGetRand`). SMWDisX bank_01.asm:110-127, bank_07.asm:1006,
 * bank_01.asm:6092. The level loader's entries are checked in LevelLoader.ts.
 */
import { mirror } from '../../addressing'
import type { RomFile } from '../../RomFile'
import { bytesAt, shapeMatches } from './Guards'

export const ENTRY = {
  /** JSL: ZeroSpriteTables + LoadSpriteTables (bank_07.asm:1006). */
  initSpriteTables: 0x07f7d2,
  /**
   * JSL: the game's own per-frame sprite loop. Sets DB to bank 1 (PHK PLB),
   * then for slots $0B..0 runs the OAM-index and timer setup and HandleSprite
   * (bank_01.asm:110-127). A routine that reads a bank-1 table through DB only
   * works under it, which is why the runner calls this and not HandleSprite.
   */
  spriteLoop: 0x01808c,
  /** Default HandleSprite address (bank_01.asm:181); `resolveLoop` reads the real one from the loop. */
  handleSprite: 0x018127,
  /**
   * JSL: CODE_0288DC (bank_02.asm:1097-1119), the item block spawn's dispatcher: by the content
   * index it either takes the free slot FindFreeSprSlot picks (egg, key, vine, balloon) or falls
   * to GenSpriteFromBlk (:1122), which writes the status and number, runs InitSpriteTables and
   * places the sprite and writes its cells (:1139-1292). `resolveBlockSpawn` byte-checks it (#566).
   */
  blockSpawn: 0x0288dc,
  /** JSL: FindFreeSprSlot (bank_02.asm:5513), which the dispatcher calls for the egg, key, vine and balloon. */
  findFreeSprSlot: 0x02a9e4,
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
 * The block spawn's fixed shapes (bank_02.asm:1097-1142), byte-checked, branch displacements free:
 * the dispatcher CODE_0288DC (LDY _5 / CPY #$0B / BNE / LDA TouchBlockXPos / AND #$30 / CMP #$20 / BEQ /
 * CPY #$10 / BEQ / CPY #$08 / BNE / LDA SpriteMemorySetting / BEQ / BNE / CPY #$0C / BNE / JSL FindFreeSprSlot /
 * TYX / BPL / RTL), the free-slot countdown of GenSpriteFromBlk (LDX #$0B / LDA SpriteStatus,X / BEQ / DEX /
 * CPX #$FF / BNE) and, at CODE_028922, its status write (STX abs / LDY _5 / LDA abs,Y / STA SpriteStatus,X).
 * Anything else is refused.
 */
export function resolveBlockSpawn(
  rom: RomFile,
): { ok: true; entry: number } | { ok: false; reason: string } {
  // prettier-ignore
  const n = null
  const dispatch = bytes(rom, ENTRY.blockSpawn, 41)
  if (!matches(dispatch, [0xa4, 0x05, 0xc0, 0x0b, 0xd0, n, 0xa5, 0x9a, 0x29, 0x30, 0xc9, 0x20, 0xf0, n, 0xc0, 0x10, 0xf0, n, 0xc0, 0x08, 0xd0, n, 0xad, 0x92, 0x16, 0xf0, n, 0xd0, n, 0xc0, 0x0c, 0xd0, n, 0x22, n, n, n, 0xbb, 0x10, n, 0x6b])) // prettier-ignore
    return { ok: false, reason: 'the item block spawn dispatcher is not the shape this reader knows' } // prettier-ignore
  // The shape only proves bytes at fixed addresses: each free branch must land where the traced routine goes
  // ([displacement offset, target offset], bank_02.asm:1097-1119), or a hack could jump past what was checked.
  const s8 = (v: number) => (v > 127 ? v - 256 : v)
  const lands: [number, number][] = [[5, 14], [13, 0x29], [17, 33], [21, 29], [26, 0x29], [28, 33], [32, 0x29], [39, 0x46]] // prettier-ignore
  for (const [at, to] of lands)
    if (at + 1 + s8(dispatch![at]!) !== to)
      return { ok: false, reason: 'the item block spawn dispatcher branches somewhere this reader does not know' } // prettier-ignore
  // And its call must reach the FindFreeSprSlot the game uses: the same address, with its own opening bytes.
  const call = dispatch![34]! | (dispatch![35]! << 8) | (dispatch![36]! << 16)
  if (call !== ENTRY.findFreeSprSlot || !matches(bytes(rom, call, 5), [0x64, 0x0e, 0x8b, 0x4b, 0xab]))
    return { ok: false, reason: 'the item block spawn dispatcher does not call the FindFreeSprSlot this reader knows' } // prettier-ignore
  const head = bytes(rom, ENTRY.blockSpawn + 0x29, 12)
  if (!matches(head, [0xa2, 0x0b, 0xbd, 0xc8, 0x14, 0xf0, n, 0xca, 0xe0, 0xff, 0xd0, n]))
    return { ok: false, reason: 'the item block spawn does not start with the free-slot countdown this reader knows' } // prettier-ignore
  const status = bytes(rom, ENTRY.blockSpawn + 0x46, 11)
  if (!matches(status, [0x8e, n, n, 0xa4, 0x05, 0xb9, n, n, 0x9d, 0xc8, 0x14]))
    return { ok: false, reason: 'the item block spawn does not write the sprite status the way this reader knows' } // prettier-ignore
  return { ok: true, entry: ENTRY.blockSpawn }
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
  // Keys fold the FastROM mirror ($80+ is the same code); the read keeps the raw bank (#513, #704).
  const targets = jsl.map(t => (t[2] << 16) | (t[1] << 8) | t[0])
  // mirror() keys $7E and $FE alike, so a WRAM call must be refused before keying. The
  // test is the read's own mapping (readByte -> loromToOffset), not a bank-half rule: on a
  // 4 MB ROM $40:06FA is ROM, while WRAM and past-the-data addresses read null.
  if (targets.some(t => rom.readByte(t) === null))
    return { ok: false, reason: 'a dispatch call does not reach ROM' }
  if (new Set(targets.map(mirror)).size !== 1)
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
  const pair = bytesAt(rom, table + id * 2, 2)
  const w = pair ? pair[0] | (pair[1] << 8) : null
  if (w === null) return { ok: false, reason: 'pointer table is not readable' }
  const address = 0x010000 | w
  // A code pointer lands in the cart's upper half; below $8000 is registers or WRAM.
  if (w < 0x8000 || bytesAt(rom, address, 1) === null)
    return { ok: false, reason: `pointer $${w.toString(16)} is not in ROM code` }
  return { ok: true, handler: { pointer: w, address } }
}
