/**
 * Which decompressor a GFX load actually runs, read from the bytes at the
 * entry its caller reaches (CODE_00B8DE on a stock ROM,
 * bank_00.asm:6294-6413). Two replacements are recognized besides stock;
 * evidence and the survey behind them are in docs/rom/gfx-decompressors.md.
 */
import type { RomFile } from './RomFile'
import { WILD, matchesBytes, type BytePattern } from './BytePattern'
import { fingerprint } from './Fingerprint'
import { formatAddr } from './addressing'
import { parseStream, type BackRefOrder } from './LcLz2'

/** REP #$10 / LDY #$0000 / JSR ReadByte / CMP #$FF (bank_00.asm:6294-6300), as the US build
 *  lays it out. Only bytes 0..4 gate the entry: the JSR operand (bytes 6..7) is build specific
 *  (US $B983, J $B924, E0 $B996, E1 $B997; SMWDisX SMW_*.sym), so `readDecompressor` matches
 *  the JSR opcode and the CMP and leaves the operand to the back-reference routine's cross-check.
 *  The US bytes stay here as the documented reference and for tests that plant a stock entry. */
export const STOCK_LCLZ2_ENTRY: readonly number[] = [
  0xc2, 0x10, 0xa0, 0x00, 0x00, 0x20, 0x83, 0xb9, 0xc9, 0xff,
]
/** Where the entry's first instruction pair ends and the body begins. */
const BODY_AT = 5
const JSR = 0x20
const CMP_IMM_FF = [0xc9, 0xff]

/** PHP / REP #$30 / LDA $8A / EOR #key / STA $8A / PLP / REP #$10 / LDY #$0000 / RTL */
// prettier-ignore
export const XOR_PRELUDE: BytePattern = [
  0x08, 0xc2, 0x30, 0xa5, 0x8a, 0x49, WILD, WILD, 0x85, 0x8a, 0x28, 0xc2, 0x10, 0xa0, 0x00, 0x00, 0x6b,
]
const KEY_AT = 6

/** Where the stock body's `PLA / BEQ / BMI` sits from the entry: the BMI's
 *  target is the back-reference routine, CODE_00B966 (bank_00.asm:6329-6331).
 *  The BEQ's displacement is checked too: stock branches to CODE_00B930. */
const DISPATCH_AT = 56
const PLA = 0x68
const BEQ = 0xf0
const BEQ_OFFSET = 0x17
const BMI = 0x30

/** CODE_00B966 (bank_00.asm:6383-6403) as bytes: ReadByte / XBA / ReadByte / [XBA] / TAX, the copy
 *  loop, then a JMP back to the loop head. The three absolute operands (both JSR ReadByte and the
 *  JMP) move with the build, so `backRefRoutine` takes them: `readBackRefOrder` derives them from
 *  the entry's own bytes, ReadByte from entry+6 and the loop head from entry+5. The XBA after the
 *  second read is the J and E1 difference (bank_00.asm:6387-6389), making the order little-endian. */
// prettier-ignore
const BACKREF_TAIL = [
  0xaa, 0x5a, 0x9b, 0xb7, 0x00, 0xbb, 0x7a, 0x97, 0x00, 0xc8, 0xe8, 0xc2, 0x20, 0xc6, 0x8d, 0xe2,
  0x20, 0xd0, 0xee, 0x4c,
]
const XBA = 0xeb
export function backRefRoutine(order: BackRefOrder, readByte: number, loop: number): number[] {
  const jsr = [0x20, readByte & 0xff, readByte >> 8]
  return [
    ...jsr,
    XBA,
    ...jsr,
    ...(order === 'le' ? [XBA] : []),
    ...BACKREF_TAIL,
    loop & 0xff,
    loop >> 8,
  ]
}

/** A body entered by JSL, recognized by the SHA-256 of `length` bytes from its target. */
export interface FastRoutine {
  length: number
  fingerprint: string
}

/** The MVN-based LC_LZ2 routine, in two builds (docs/rom/gfx-decompressors.md). */
export const FAST_LCLZ2: readonly FastRoutine[] = [
  {
    length: 0x1bc,
    fingerprint: 'c70bc52376ce570eddb05c7b592d07299969079ce36efdc9fd5ceef3502a2133',
  },
  {
    length: 0x1ab,
    fingerprint: '575f68adc5aca7ff5c7cbc1e0460dd605efc9158f8865892d4db0b846f4ad209',
  },
]

export type DecompressorKind = 'stock' | 'fast'
export type Decompressor =
  | { ok: true; kind: DecompressorKind; key: number; order: BackRefOrder }
  | { ok: false; reason: string }

/** The 24-bit JSL target at `snes`, bank kept, or null off a JSL opcode or off
 *  the ROM. Read, not key: callers read through it, and folding $FE/$FF onto
 *  $7E/$7F would make a 4 MB ROM's routine unreadable. A caller comparing it
 *  to a canonical address wraps it in `mirror()`. */
export function jslTarget(rom: RomFile, snes: number): number | null {
  const bytes = rom.readAt(snes, 4)
  if (!bytes || bytes[0] !== 0x22) return null
  return bytes[1]! | (bytes[2]! << 8) | (bytes[3]! << 16)
}

export const replacedReason = (entry: number, what: string): string =>
  `this ROM has replaced the LC_LZ2 decompressor at ${formatAddr(entry)} (${what}), ` +
  'so its GFX are not LC_LZ2 streams this editor can read or write'

/** The key the entry's prelude XORs into the pointer: 0 when the entry
 *  starts stock, null when it starts with anything else. */
export function preludeKey(rom: RomFile, entry: number): number | null {
  const head = rom.readAt(entry, BODY_AT)
  if (!head) return null
  if (matchesBytes(head, STOCK_LCLZ2_ENTRY.slice(0, BODY_AT))) return 0
  const target = head[4] === 0xea ? jslTarget(rom, entry) : null // JSL / NOP
  const p = target === null ? null : rom.readAt(target, XOR_PRELUDE.length)
  return p && matchesBytes(p, XOR_PRELUDE) ? p[KEY_AT]! | (p[KEY_AT + 1]! << 8) : null
}

/** The back-reference byte order of the stock body at `entry`, read from the
 *  routine its dispatch branches to; null when the dispatch is not there or
 *  the routine is neither known form. */
export function readBackRefOrder(rom: RomFile, entry: number): BackRefOrder | null {
  const d = rom.readAt(entry + DISPATCH_AT, 5)
  const at = rom.readAt(entry + BODY_AT, 3) // JSR ReadByte, the entry's own
  // The operand below is only an operand when this is a JSR; callers do not vouch for it.
  if (
    !d ||
    !at ||
    at[0] !== JSR ||
    d[0] !== PLA ||
    d[1] !== BEQ ||
    d[2] !== BEQ_OFFSET ||
    d[3] !== BMI
  )
    return null
  const target = entry + DISPATCH_AT + 5 + ((d[4]! << 24) >> 24)
  const readByte = at[1]! | (at[2]! << 8)
  for (const order of ['be', 'le'] as const) {
    const form = backRefRoutine(order, readByte, (entry + BODY_AT) & 0xffff)
    const bytes = rom.readAt(target, form.length)
    if (bytes && matchesBytes(bytes, form)) return order
  }
  return null
}

export function readDecompressor(
  rom: RomFile,
  entry: number,
  fast: readonly FastRoutine[] = FAST_LCLZ2,
): Decompressor {
  const head = rom.readAt(entry, STOCK_LCLZ2_ENTRY.length)
  if (!head) return { ok: false, reason: 'the decompressor entry does not resolve to ROM data' }
  const replaced = (what: string): Decompressor => ({
    ok: false,
    reason: replacedReason(entry, what),
  })
  const key = preludeKey(rom, entry)
  if (key === null) {
    const target = jslTarget(rom, entry)
    return replaced(
      `an unrecognized entry${target === null ? '' : ` that calls ${formatAddr(target)}`}`,
    )
  }
  // JSR <ReadByte> / CMP #$FF. The JSR operand varies by build and is verified by
  // readBackRefOrder against the back-reference routine's own JSR (#696).
  if (head[BODY_AT] === JSR && matchesBytes(head.subarray(BODY_AT + 3), CMP_IMM_FF)) {
    const order = readBackRefOrder(rom, entry)
    return order
      ? { ok: true, kind: 'stock', key, order }
      : replaced('an unrecognized back-reference routine')
  }
  const target = head[BODY_AT + 4] === 0x60 ? jslTarget(rom, entry + BODY_AT) : null // JSL / RTS
  if (target === null) return replaced('an unrecognized body')
  const known = fast.some(f => fingerprint(rom.readAt(target, f.length)) === f.fingerprint)
  // Both recognized builds are big-endian in use: the stream decoding is
  // unchanged from before #274, not derived from their bytes.
  return known
    ? { ok: true, kind: 'fast', key, order: 'be' }
    : replaced(`it calls ${formatAddr(target)}`)
}

/** Why `stream` has no single meaning on this decompressor, or null: the fast
 *  routine reads some commands above 4 unlike stock (docs/rom/gfx-decompressors.md). */
export function commandRefusal(kind: DecompressorKind, stream: Uint8Array): string | null {
  return kind === 'fast' && !parseStream(stream).terminated
    ? "it uses a command this ROM's decompressor reads differently from stock"
    : null
}
