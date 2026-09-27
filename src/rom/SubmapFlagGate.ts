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
import { WILD, matchesBytes, type BytePattern } from './BytePattern'
import { fingerprint } from './Fingerprint'
import { hex6 } from './hex'

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

const ENTRY_PATH = OVERWORLD_ENTRY.slice(0, -1)
const ENTRY_SITE = OVERWORLD_ENTRY[OVERWORLD_ENTRY.length - 1] as StockCode
/** The stock site's `LDA OWPlayerSubmap,Y` ends here; the hook's JSL follows. */
const SITE_KEPT = 15

/** CODE_05D8A2 as Lunar Magic leaves it: a JSL, followed, in place of `BEQ + /
 *  LDA #submapHigh`, returning to the stock `STA _F`. */
export const LM_ENTRY_SITE: StockCode = {
  addr: ENTRY_SITE.addr,
  bytes: [...ENTRY_SITE.bytes.slice(0, SITE_KEPT), 0x22, WILD, WILD, WILD, 0x85, 0x0f],
  what: "CODE_05D8A2 with Lunar Magic's high-byte JSL",
  cite: ENTRY_SITE.cite,
}

/** The JSL's routine. Off the override path it recomputes the level number
 *  from TranslevelNo and takes the high byte from the translevel, not the submap. */
// prettier-ignore
export const LM_ENTRY_HOOK: BytePattern = [
  0xa8,             // TAY
  0xad, 0x09, 0x01, // LDA OverworldOverride
  0xf0, 0x06,       // BEQ tile
  0x98,             // TYA: an override keeps the submap high byte
  0xf0, 0x02,       // BEQ +
  0xa9, 0x01,       // LDA #$01
  0x6b,             // + RTL
  0xa8,             // tile: TAY, so Y is 0
  0xad, 0xbf, 0x13, // LDA TranslevelNo
  0xc9, WILD,       // CMP #threshold
  0x90, 0x03,       // BCC +
  0xe9, WILD,       // SBC #bias
  0xc8,             // INY: high byte 1
  0x8d, 0xbb, 0x17, // + STA LoadingLevelNumber
  0x85, 0x0e,       // STA _E
  0x98,             // TYA
  0x6b,             // RTL
]

/** The routine's own threshold and bias, or why the site is not the hook. */
function lmEntryHook(rom: RomFile): { threshold: number; bias: number } | string {
  const site = stockCodeMismatch(rom, [LM_ENTRY_SITE])
  if (site) return site
  const b = rom.readAt(LM_ENTRY_SITE.addr + SITE_KEPT + 1, 3)!
  const at = b[0]! | (b[1]! << 8) | (b[2]! << 16)
  const routine = rom.readAt(at, LM_ENTRY_HOOK.length)
  if (!matchesBytes(routine, LM_ENTRY_HOOK)) {
    return `the JSL at $05D8B1 reaches $${hex6(at)}, which is not Lunar Magic's high-byte routine.`
  }
  return { threshold: routine![17]!, bias: routine![21]! }
}

/** The operands of the code that maps a translevel to a slot: translevels at or
 *  above `threshold` are biased by `bias`. The high byte is `submapHigh` on a
 *  submap tile for stock code, and at or above the threshold for the hook. */
export interface TranslevelBias {
  threshold: number
  bias: number
  submapHigh: number
  high: 'submap' | 'translevel'
}

export type TranslevelBiasSite = ({ ok: true } & TranslevelBias) | { ok: false; reason: string }

/** CODE_05D8A2's operands, stock or through the recognized hook. */
export function readEntrySite(rom: RomFile): TranslevelBiasSite {
  const stock = stockCodeMismatch(rom, [ENTRY_SITE])
  if (stock) {
    const hook = lmEntryHook(rom)
    if (typeof hook === 'string') {
      return { ok: false, reason: `${stock} Nor is it Lunar Magic's hook: ${hook}` }
    }
    return { ok: true, ...hook, submapHigh: 1, high: 'translevel' }
  }
  const submapHigh = readSubmapHigh(rom, 0x05d8b4)
  if (typeof submapHigh === 'string') return { ok: false, reason: submapHigh }
  const threshold = rom.readByte(0x05d8a3)!
  const bias = rom.readByte(0x05d8a8)!
  return { ok: true, threshold, bias, submapHigh, high: 'submap' }
}

/** `TranslevelBias` once the path into CODE_05D8A2 is stock. */
export function readTranslevelBias(
  rom: RomFile,
  spanFingerprints?: readonly string[],
): TranslevelBiasSite {
  const path = stockCodeMismatch(rom, ENTRY_PATH, spanFingerprints)
  return path ? { ok: false, reason: path } : readEntrySite(rom)
}

/** The recognized code's formula. `layout` (which buffer half assigned the
 *  translevel) decides the stock high byte; the hook ignores it. */
export function translevelToPointerIndex(
  mapping: TranslevelBias,
  translevel: number,
  layout: 0 | 1,
): number {
  const over = translevel >= mapping.threshold
  const biased = over ? (translevel - mapping.bias) & 0xff : translevel
  const high = mapping.high === 'translevel' ? over : layout === 1
  return high ? (mapping.submapHigh << 8) | biased : biased
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
