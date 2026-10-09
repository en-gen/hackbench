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
import { fingerprint } from './Fingerprint'
import { stockCodeMismatch, type StockCode } from './SubmapFlagGate'
import { FAST_LCLZ2, commandRefusal, readDecompressor, type FastRoutine } from './GfxDecompressor'

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
 *  lands on $00804D, an RTL, which returns to the PLP. The JML target is pinned. */
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
const DECOMPRESSOR_ENTRY = 0x00b8de
const UNDECODED = 'The stored translevel table cannot be decoded.'

/** Recognized decompressor builds; the shipped ones where a field is absent. */
export interface LmDecompressors {
  /** SHA-256 of CODE_00B8DE's $AF bytes from entry+5, past a prelude's reach,
   *  through ReadByte's RTS (bank_00.asm:6296-6413). */
  stockBody?: readonly string[]
  fast?: readonly FastRoutine[]
}
/** One build across all 69 store and corpus ROMs read as stock, keyed or not. */
export const STOCK_LCLZ2_BODY: readonly string[] = Object.freeze([
  'da8cac1e47c273012ef1e7e3c34aa59e45f1879f1f1f27c8edad12e29e1104d9',
])
const STOCK_BODY = { at: DECOMPRESSOR_ENTRY + 5, length: 0xaf }

/**
 * The translevel per OWL1 buffer index, or why not; null when `entry` (a ROM
 * offset) is not shaped like Lunar Magic's walk at all.
 */
export function readLmTranslevels(
  rom: RomFile,
  entry: number,
  known: LmDecompressors = {},
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

  const patched = stockCodeMismatch(rom, [RETURN])
  if (patched) return `${patched} ${UNDECODED}`
  const d = readDecompressor(rom, DECOMPRESSOR_ENTRY, known.fast ?? FAST_LCLZ2)
  if (!d.ok) return `${d.reason}. ${UNDECODED}`
  const body = fingerprint(rom.readAt(STOCK_BODY.at, STOCK_BODY.length)) ?? ''
  if (d.kind === 'stock' && !(known.stockBody ?? STOCK_LCLZ2_BODY).includes(body)) {
    return `the translevel decompressor at $${hex6(DECOMPRESSOR_ENTRY)} has a stock entry, but its body is not a recognized build. ${UNDECODED}`
  }
  // The prelude keys $8A-$8B, never $8C, before ReadByte loads through [$8A]
  // (bank_00.asm:6406); this call stores its operand there, so it is keyed.
  const addr = src ^ d.key
  const data = rom.readUpTo(addr, 0x10000)
  const table = data
    ? tryDecompress(data, { order: d.order })
    : { ok: false as const, reason: 'unreadable' }
  const why =
    (data && commandRefusal(d.kind, data)) ??
    (!table.ok
      ? table.reason
      : table.bytes.length < 0x800
        ? `only ${table.bytes.length} bytes, short of $800`
        : null)
  if (why || !table.ok) return `the translevel table at $${hex6(addr)} does not decode: ${why}.`
  return table.bytes
}
