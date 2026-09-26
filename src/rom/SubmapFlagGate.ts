/**
 * The stock code a static model of a slot's high byte depends on. The high
 * byte comes from `LDA OWPlayerSubmap,Y / BEQ +`, not from any table, so a
 * model is right only while that code, and the path into it, is stock.
 *
 * The four edited corpus ROMs replace both BEQs with a JSL (6 ROMs, one
 * machine): empirical, not an ASM claim. A mismatch means code HackBench does
 * not decode, so callers decline rather than assume the stock rule.
 *
 * The overworld entry is checked contiguously from the JMP target through
 * `STA _F`: CODE_05D83E's 100-byte body as a fingerprint, then CODE_05D8A2
 * literally.
 */
import type { RomFile } from './RomFile'
import { WILD } from './BytePattern'
import { fingerprint } from './Fingerprint'

export interface StockCode {
  addr: number
  /** WILD (BytePattern.ts) matches any byte: an operand whose value does not matter to the check. */
  bytes: readonly number[]
  /** A bank byte, compared with bit 7 masked: a FastROM mirror is the same bank. */
  bankAt?: number
  what: string
  cite: string
}

/** A span too long to commit literally, recognized by the SHA-256 of its bytes. */
export interface StockSpan {
  addr: number
  length: number
  /** The recognized builds; a caller may pass its own to `stockCodeMismatch`. */
  fingerprints: readonly string[]
  /** Offsets zeroed before hashing: operands the caller reads and checks itself. */
  mask?: readonly number[]
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

/** Vanilla only, measured: the magic ROM matches it; the four hacks do not. */
export const OVERWORLD_INDEX_BODY: StockSpan = Object.freeze({
  addr: 0x05d83e,
  length: 0x64,
  fingerprints: Object.freeze(['db1c8ea21ff4fdb26c78dcb5b9386c8fa5ef059fcb1dacd0a2b2d71b514a93d2']),
  what: 'CODE_05D83E, the OWLayer1Translevel index',
  cite: 'bank_05.asm:7164-7215',
})

export const OVERWORLD_ENTRY: readonly (StockCode | StockSpan)[] = [
  REACH,
  { addr: 0x05d7b0, bytes: [0x4c, 0x3e, 0xd8], what: 'JMP CODE_05D83E', cite: 'bank_05.asm:7093' },
  OVERWORLD_INDEX_BODY,
  {
    addr: 0x05d8a2,
    // prettier-ignore
    bytes: [
      0xc9, WILD,       // CMP #threshold
      0x90, 0x03,       // BCC +
      0x38,             // SEC
      0xe9, WILD,       // SBC #bias
      0x8d, 0xbb, 0x17, // + STA LoadingLevelNumber
      0x85, 0x0e,       // STA _E
      0xb9, 0x11, 0x1f, // LDA OWPlayerSubmap,Y
      0xf0, 0x02,       // BEQ +
      0xa9, WILD,       // LDA #submapHigh
      0x85, 0x0f,       // + STA _F
    ],
    what: 'CODE_05D8A2, the translevel bias and high byte',
    cite: 'bank_05.asm:7217-7226',
  },
]

/** The screen-exit path's own `LDA #imm` submap high byte (bank_05.asm:7109). */
export const SCREEN_EXIT_HIGH_AT = 0x05d7d1

export const SCREEN_EXIT: readonly StockCode[] = [
  REACH,
  {
    addr: 0x05d7cb,
    // prettier-ignore
    bytes: [
      0xb9, 0x11, 0x1f, // LDA OWPlayerSubmap,Y
      0xf0, 0x02,       // BEQ +
      0xa9, WILD,       // LDA #submapHigh
      0x85, 0x0f,       // + STA _F
    ],
    what: 'screen exit high byte',
    cite: 'bank_05.asm:7107-7110',
  },
  {
    addr: 0x05d7e2,
    bytes: [0xb9, 0x00, 0xf8],
    what: 'LDA DATA_05F800,Y',
    cite: 'bank_05.asm:7117',
  },
]

/**
 * The high byte `LDA #imm` at `at` loads for a submap, or a refusal: the
 * pointer table has $200 slots, so only 0 and 1 name one.
 */
export function readSubmapHigh(rom: RomFile, at: number): number | string {
  const high = rom.readByte(at)!
  if (high <= 1) return high
  return (
    `$${at.toString(16).toUpperCase().padStart(6, '0')} loads submap high byte ` +
    `$${high.toString(16).toUpperCase()}, which names no slot: the pointer table ends at $1FF.`
  )
}

/** CODE_05D8A2's own operands: translevels at or above `threshold` are
 *  biased by `bias`, and a submap tile's slot carries `submapHigh` in its
 *  high byte (bank_05.asm:7217-7226). */
export interface TranslevelBias {
  threshold: number
  bias: number
  submapHigh: number
}

export type TranslevelBiasSite = ({ ok: true } & TranslevelBias) | { ok: false; reason: string }

/** Reads `TranslevelBias`, reusing the stock-code gate OverworldEntrances checks. */
export function readTranslevelBias(
  rom: RomFile,
  spanFingerprints?: readonly string[],
): TranslevelBiasSite {
  const patched = stockCodeMismatch(rom, OVERWORLD_ENTRY, spanFingerprints)
  if (patched) return { ok: false, reason: patched }
  const threshold = rom.readByte(0x05d8a3)!
  const bias = rom.readByte(0x05d8a8)!
  const submapHigh = readSubmapHigh(rom, 0x05d8b4)
  if (typeof submapHigh === 'string') return { ok: false, reason: submapHigh }
  return { ok: true, threshold, bias, submapHigh }
}

/** CODE_05D8A2's formula. `layout` (which buffer half assigned the
 *  translevel) decides the high byte; a bare translevel cannot give it. */
export function translevelToPointerIndex(
  mapping: TranslevelBias,
  translevel: number,
  layout: 0 | 1,
): number {
  const biased = translevel >= mapping.threshold ? (translevel - mapping.bias) & 0xff : translevel
  return layout === 1 ? (mapping.submapHigh << 8) | biased : biased
}

/** SHA-256 of `bytes` with `mask`'s offsets zeroed, or null for a failed read. */
export function spanFingerprint(
  bytes: Uint8Array | null,
  mask: readonly number[] = [],
): string | null {
  if (!bytes) return null
  const copy = Uint8Array.from(bytes)
  for (const i of mask) copy[i] = 0
  return fingerprint(copy)
}

const hex = (bytes: Iterable<number>): string =>
  [...bytes].map(b => (b === WILD ? '??' : b.toString(16).padStart(2, '0'))).join(' ')

/**
 * A sentence naming the first run that is not stock, or null when all are.
 *
 * @param spanFingerprints Replaces every span's own list; for a synthetic ROM.
 */
export function stockCodeMismatch(
  rom: RomFile,
  checks: readonly (StockCode | StockSpan)[],
  spanFingerprints?: readonly string[],
): string | null {
  for (const c of new Set(checks)) {
    if ('fingerprints' in c) {
      const fp = spanFingerprint(rom.readAt(c.addr, c.length), c.mask)
      if (fp !== null && (spanFingerprints ?? c.fingerprints).includes(fp)) continue
      return (
        `$${c.addr.toString(16).toUpperCase().padStart(6, '0')} (${c.what}, ${c.cite}) is ` +
        `${fp ? 'not a recognized build of that code' : 'not readable'}.`
      )
    }
    const found = rom.readAt(c.addr, c.bytes.length)
    const same = (b: number, i: number): boolean =>
      b === WILD ? true : i === c.bankAt ? ((found![i]! ^ b) & 0x7f) === 0 : found![i] === b
    if (found && c.bytes.every(same)) continue
    return (
      `$${c.addr.toString(16).toUpperCase().padStart(6, '0')} (${c.what}, ${c.cite}) holds ` +
      `${found ? hex(found) : 'nothing readable'}, not the stock ${hex(c.bytes)}.`
    )
  }
  return null
}
