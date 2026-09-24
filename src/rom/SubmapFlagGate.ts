/**
 * The stock code a static model of a slot's high byte depends on. The high
 * byte comes from `LDA OWPlayerSubmap,Y / BEQ +`, not from any table, so a
 * model is right only while that code, and the path into it, is stock.
 *
 * The four edited corpus ROMs replace both BEQs with a JSL (6 ROMs, one
 * machine): empirical, not an ASM claim. A mismatch means code HackBench does
 * not decode, so callers decline rather than assume the stock rule.
 *
 * Hack-fragility point: the body of CODE_05D83E (bank_05.asm:7164-7215) is
 * not checked. The JMP into it and the BEQ after it are, so a patch that
 * diverts inside it passes this gate.
 */
import type { RomFile } from './RomFile'

export interface StockCode {
  addr: number
  bytes: readonly number[]
  /** A bank byte, compared with bit 7 masked: a FastROM mirror is the same bank. */
  bankAt?: number
  what: string
  cite: string
}

const REACH: StockCode = {
  addr: 0x0096f4,
  bytes: [0x22, 0x96, 0xd7, 0x05],
  bankAt: 3,
  what: 'JSL CODE_05D796',
  cite: 'bank_00.asm:2644',
}

export const OVERWORLD_ENTRY: readonly StockCode[] = [
  REACH,
  { addr: 0x05d7b0, bytes: [0x4c, 0x3e, 0xd8], what: 'JMP CODE_05D83E', cite: 'bank_05.asm:7093' },
  {
    addr: 0x05d8ae,
    bytes: [0xb9, 0x11, 0x1f, 0xf0, 0x02],
    what: 'overworld entry high byte',
    cite: 'bank_05.asm:7223-7224',
  },
]

export const SCREEN_EXIT: readonly StockCode[] = [
  REACH,
  {
    addr: 0x05d7cb,
    bytes: [0xb9, 0x11, 0x1f, 0xf0, 0x02],
    what: 'screen exit high byte',
    cite: 'bank_05.asm:7107-7108',
  },
  {
    addr: 0x05d7e2,
    bytes: [0xb9, 0x00, 0xf8],
    what: 'LDA DATA_05F800,Y',
    cite: 'bank_05.asm:7117',
  },
]

const hex = (bytes: Iterable<number>): string =>
  [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ')

/** A sentence naming the first run that is not stock, or null when all are. */
export function stockCodeMismatch(rom: RomFile, checks: readonly StockCode[]): string | null {
  for (const c of new Set(checks)) {
    const found = rom.readAt(c.addr, c.bytes.length)
    const same = (b: number, i: number): boolean =>
      i === c.bankAt ? ((found![i]! ^ b) & 0x7f) === 0 : found![i] === b
    if (found && c.bytes.every(same)) continue
    return (
      `$${c.addr.toString(16).toUpperCase().padStart(6, '0')} (${c.what}, ${c.cite}) holds ` +
      `${found ? hex(found) : 'nothing readable'}, not the stock ${hex(c.bytes)}.`
    )
  }
  return null
}
