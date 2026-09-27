/**
 * The Bonus Games room and the Yoshi Heaven sub areas: maps the game enters
 * after a level, not from an overworld tile.
 *
 * `CODE_05D796` tests `YoshiHeavenFlag` and `BonusGameActivate` and, when
 * either is set, calls `CODE_05DBAC` (bank_05.asm:7085-7090). That routine
 * picks Y with two `LDY #imm`, the first kept when `YoshiHeavenFlag` is clear,
 * and stores `DATA_05DBA9[Y]` as the screen exit's low byte
 * (bank_05.asm:7607-7620). The high byte then comes from the submap flag,
 * as for every screen exit (bank_05.asm:7106-7111).
 *
 * Checked: the JSL into `CODE_05D796`, every byte from there to the
 * `DATA_05F800` load (bank_05.asm:7079-7117), the routine the JSR reaches, and
 * the primary-exit branch's landing. Assumes that path: with `UseSecondaryExit`
 * set (bank_0D.asm:1438) the destination comes from `DATA_05F800` instead.
 */
import type { RomFile } from './RomFile'
import { matchesBytes, WILD, type BytePattern } from './BytePattern'
import {
  SCREEN_EXIT,
  SCREEN_EXIT_HIGH_AT,
  readSubmapHigh,
  stockCodeMismatch,
  type StockCode,
  type StockSpan,
} from './SubmapFlagGate'
import type { SpecialMap } from './SpecialMaps'

/** Which flag sends the player there: `BonusGameActivate` or `YoshiHeavenFlag`. */
export type BonusRole = 'bonus-game' | 'yoshi-heaven'
type BonusMap = SpecialMap<BonusRole>

/** CODE_05D796 through the screen exit low byte and TAY (bank_05.asm:7079-7106): 53
 *  bytes, so fingerprinted. The JSR operand is masked because it is read and followed.
 *  Vanilla only, measured: the magic ROM and GPW 1.2 match; the other three hacks do not. */
export const BONUS_CALL: StockSpan = Object.freeze({
  addr: 0x05d796,
  length: 53,
  mask: Object.freeze([19, 20]),
  fingerprints: Object.freeze(['6728446a5b24c7a9069acc5397c1c44c01942d8fc826d3691d0acb2c9b6db305']),
  what: 'CODE_05D796 through the screen exit low byte',
  cite: 'bank_05.asm:7079-7106',
})
const JSR_AT = 0x05d7a9

/** Between SCREEN_EXIT's high byte and its DATA_05F800 load. */
export const BONUS_PRIMARY: StockCode = Object.freeze({
  addr: 0x05d7d4,
  // prettier-ignore
  bytes: Object.freeze([
    0xad, 0x93, 0x1b, // LDA UseSecondaryExit
    0xf0, WILD,       // BEQ +, followed below
    0xc2, 0x30,       // REP #$30
    0xa9, 0x00, 0x00, // LDA #$0000
    0xe2, 0x20,       // SEP #$20
    0xa4, 0x0e,       // LDY _E
  ]),
  what: 'the UseSecondaryExit test',
  cite: 'bank_05.asm:7111-7116',
})
const PRIMARY_BEQ = 0x05d7d7

/** Where the primary-exit branch lands (bank_05.asm:7162). */
export const BONUS_LOAD_JMP: BytePattern = Object.freeze([0x4c, 0xb7, 0xd8]) // JMP CODE_05D8B7

/** CODE_05DBAC (bank_05.asm:7607-7620). */
// prettier-ignore
export const BONUS_PICK: BytePattern = Object.freeze([
  0xa0, WILD,       // LDY #bonus
  0xad, 0x95, 0x1b, // LDA YoshiHeavenFlag
  0xf0, 0x02,       // BEQ +
  0xa0, WILD,       // LDY #yoshi
  0xa6, 0x95,       // + LDX PlayerXPosNext+1
  0xa5, 0x5b,       // LDA ScreenMode
  0x29, 0x01,       // AND #!ScrMode_Layer1Vert
  0xf0, 0x02,       // BEQ +
  0xa6, 0x97,       // LDX PlayerYPosNext+1
  0xb9, WILD, WILD, // + LDA DATA_05DBA9,Y
  0x9d, 0xb8, 0x19, // STA ExitTableLow,X
  0xee, 0x1a, 0x14, // INC SublevelCount
  0x60,             // RTS
])
const BONUS_Y = 1
const YOSHI_Y = 8
const TABLE = 20

const hex6 = (addr: number): string => `$${addr.toString(16).toUpperCase().padStart(6, '0')}`

/** @param fingerprints Replaces BONUS_CALL's recognized builds; for a synthetic ROM. */
export function findBonusEntrances(
  rom: RomFile,
  fingerprints: readonly string[] = BONUS_CALL.fingerprints,
): { maps: BonusMap[]; notes: string[] } {
  const refuse = (why: string): { maps: BonusMap[]; notes: string[] } => ({
    maps: [],
    notes: [`Bonus Games and Yoshi Heaven: ${why} Their maps are still listed as unassigned.`],
  })
  const patched = stockCodeMismatch(rom, [...SCREEN_EXIT, BONUS_CALL, BONUS_PRIMARY], fingerprints)
  if (patched) return refuse(patched)
  const bank = BONUS_CALL.addr & 0xff0000
  const landing = PRIMARY_BEQ + 2 + ((rom.readByte(PRIMARY_BEQ + 1)! << 24) >> 24)
  if (!matchesBytes(rom.readAt(landing, BONUS_LOAD_JMP.length), BONUS_LOAD_JMP)) {
    return refuse(`the primary-exit branch lands on ${hex6(landing)}, not JMP CODE_05D8B7.`)
  }
  const pickAt = bank | rom.readWord(JSR_AT)!
  const pick = rom.readAt(pickAt, BONUS_PICK.length)
  if (!matchesBytes(pick, BONUS_PICK))
    return refuse(`the JSR reaches ${hex6(pickAt)}, not CODE_05DBAC.`)
  const high = readSubmapHigh(rom, SCREEN_EXIT_HIGH_AT)
  if (typeof high === 'string') return refuse(high)

  // PHK / PLB in CODE_05D796 sets the data bank, so the table sits in that bank.
  const table = bank | pick![TABLE]! | (pick![TABLE + 1]! << 8)
  const maps: BonusMap[] = []
  for (const [role, y] of [
    ['bonus-game', pick![BONUS_Y]!],
    ['yoshi-heaven', pick![YOSHI_Y]!],
  ] as const) {
    const low = rom.readByte(table + y)
    if (low === null) return refuse(`DATA_05DBA9 at ${hex6(table + y)} is not readable.`)
    for (const index of new Set([low, (high << 8) | low])) {
      maps.push({ index, role, foundAt: hex6(table + y) })
    }
  }
  return { maps, notes: [] }
}
