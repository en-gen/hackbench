/**
 * Lunar Magic's CODE_04D7F2: it decompresses a stored translevel table into
 * OWLayer1Translevel ($7ED000), sometimes a second buffer into $7FC800, and
 * branches past the counting loop (bank_04.asm:5264-5309). Four layouts are
 * read: the source operands in either order, and one or two blocks.
 */
import type { RomFile } from './RomFile'
import { WILD, matchesAt, type BytePattern } from './BytePattern'
import { tryDecompress } from './LcLz2'
import { hex6 } from './hex'
import { stockCodeMismatch, type StockCode, type StockSpan } from './SubmapFlagGate'

const PROLOGUE: BytePattern = [0xc2, 0x30, 0xa9, 0x00, 0x00, 0xe2, 0x20]
/** LDX #$D000 / STX _0 / LDA #$7E / STA _2: the destination is OWLayer1Translevel. */
const TRANSLEVEL_DEST: BytePattern = [0xa2, 0x00, 0xd0, 0x86, 0x00, 0xa9, 0x7e, 0x85, 0x02]
/** LDX #$C800 / STX _0 / LDA #$7F / STA _2. */
const SECOND_DEST: BytePattern = [0xa2, 0x00, 0xc8, 0x86, 0x00, 0xa9, 0x7f, 0x85, 0x02]
/** The source into GraphicsCompPtr ($8A-$8C), in either order; [lo, hi, bank] offsets. */
const SOURCES: [BytePattern, number, number, number][] = [
  [[0xa2, WILD, WILD, 0x86, 0x8a, 0xa9, WILD, 0x85, 0x8c], 1, 2, 6],
  [[0xa9, WILD, 0x85, 0x8c, 0xa2, WILD, WILD, 0x86, 0x8a], 5, 6, 1],
]
/** PHP / PHK / PER +6 / PEA $804C / JML $00B8DE / PLP: the decompressor's RTS
 *  lands on $00804D, an RTL, which returns to the PLP. */
// prettier-ignore
const CALL: BytePattern = [
  0x08, 0x4b, 0x62, 0x06, 0x00, 0xf4, 0x4c, 0x80, 0x5c, 0xde, 0xb8, WILD, 0x28,
]
const CALL_BANK = 11
/** STZ _F / JSR CODE_04DA49: the stock code after the counting loop. */
const TAIL: BytePattern = [0x64, 0x0f, 0x20, 0x49, 0xda]

const RETURN: StockCode = {
  addr: 0x00804d,
  bytes: [0x6b],
  what: 'the RTL the decompressor call returns through',
  cite: 'bank_00.asm:36',
}
/** CODE_00B8DE through ReadByte's RTS, the LC_LZ2 LcLz2.ts decodes. */
export const DECOMPRESSOR: StockSpan = Object.freeze({
  addr: 0x00b8de,
  length: 0xb4,
  fingerprints: Object.freeze(['5369c9a968738a2f3b402fe4480c2dcd6103e306832409962ad0bf9361d75fca']),
  what: 'CODE_00B8DE, the LC_LZ2 decompressor',
  cite: 'bank_00.asm:6294-6413',
})

/**
 * The translevel per OWL1 buffer index, or why not; null when `entry` (a ROM
 * offset) is not shaped like Lunar Magic's walk at all.
 */
export function readLmTranslevels(
  rom: RomFile,
  entry: number,
  decompressorFingerprints?: readonly string[],
): Uint8Array | string | null {
  let at = entry
  const take = (p: BytePattern): Uint8Array | null => {
    const bytes = matchesAt(rom, at, p)
    if (bytes) at += p.length
    return bytes
  }
  const source = (): number | null => {
    for (const [p, lo, hi, bank] of SOURCES) {
      const b = take(p)
      if (b) return (b[bank]! << 16) | (b[hi]! << 8) | b[lo]!
    }
    return null
  }
  const call = (): boolean => {
    const b = take(CALL)
    return b !== null && (b[CALL_BANK]! & 0x7f) === 0
  }

  if (!take(PROLOGUE) || !take(TRANSLEVEL_DEST)) return null
  const src = source()
  if (src === null || !call()) return null
  if (take(SECOND_DEST) && (source() === null || !call())) return null
  const bra = take([0x80, WILD])
  if (!bra || !matchesAt(rom, at + ((bra[1]! << 24) >> 24), TAIL)) return null

  const patched = stockCodeMismatch(rom, [RETURN, DECOMPRESSOR], decompressorFingerprints)
  if (patched) return `${patched} The stored translevel table cannot be decoded.`
  const data = rom.readUpTo(src, 0x10000)
  const table = data ? tryDecompress(data) : { ok: false as const, reason: 'unreadable' }
  if (!table.ok) return `the translevel table at $${hex6(src)} does not decode: ${table.reason}`
  if (table.bytes.length < 0x800) {
    return `the translevel table at $${hex6(src)} decodes to ${table.bytes.length} bytes, short of $800.`
  }
  return table.bytes
}
