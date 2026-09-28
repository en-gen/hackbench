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
 * `STA _F`: CODE_05D83E's index as a fingerprint between its literal
 * OverworldOverride test and table load, then CODE_05D8A2 literally. The test
 * and the load each also accept a recognized hook.
 */
import type { RomFile } from './RomFile'
import { WILD, matchesBytes, type BytePattern } from './BytePattern'
import { fingerprint } from './Fingerprint'
import { long } from './GfxArena'
import { jslTarget, type FastRoutine } from './GfxDecompressor'
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

/** STZ _F / LDY #0 / LDA OverworldOverride / BNE CODE_05D8A2. */
export const OVERWORLD_INDEX_GUARD: StockCode = {
  addr: 0x05d83e,
  bytes: [0x64, 0x0f, 0xa0, 0x00, 0xad, 0x09, 0x01, 0xd0, 0x5b],
  what: "CODE_05D83E's OverworldOverride test",
  cite: 'bank_05.asm:7164-7168',
}

/** The index computation up to the table load. Vanilla only, measured. */
export const OVERWORLD_INDEX_BODY: StockSpan = Object.freeze({
  addr: 0x05d847,
  length: 0x54,
  fingerprints: Object.freeze(['ab9d13cbee1de3f1f850dc3a60d98f23db85ea307afe430922ada36ac2aee7ed']),
  what: 'CODE_05D83E, the OWLayer1Translevel index',
  cite: 'bank_05.asm:7169-7213',
})

/** LDA.L OWLayer1Translevel,X / STA TranslevelNo. */
export const OVERWORLD_INDEX_LOAD: StockCode = {
  addr: 0x05d89b,
  bytes: [0xbf, 0x00, 0xd0, 0x7e, 0x8d, 0xbf, 0x13],
  what: 'the OWLayer1Translevel load',
  cite: 'bank_05.asm:7214-7215',
}

export const OVERWORLD_ENTRY: readonly (StockCode | StockSpan)[] = [
  REACH,
  { addr: 0x05d7b0, bytes: [0x4c, 0x3e, 0xd8], what: 'JMP CODE_05D83E', cite: 'bank_05.asm:7093' },
  OVERWORLD_INDEX_GUARD,
  OVERWORLD_INDEX_BODY,
  OVERWORLD_INDEX_LOAD,
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

/** A build of Lunar Magic's midway hook: offsets of its JSR and of the JMLs
 *  that leave for the index and for CODE_05D8A2, all masked from `fingerprint`. */
export interface MidwayHookBuild {
  length: number
  helperAt: number
  indexAt: number
  overrideAt: number
  fingerprint: string
}

// prettier-ignore
export const MIDWAY_BUILDS: readonly MidwayHookBuild[] = [
  { length: 83, helperAt: 15, indexAt: 51, overrideAt: 55, fingerprint: '68a4ef896c9733c485c8d324623a63bd02aeb0710307264c5d78abde8a345d9a' },
  { length: 91, helperAt: 23, indexAt: 59, overrideAt: 63, fingerprint: '992b39151651c1909d6817595de7d23b0edb01b0a38f03d7930760917e65fc07' },
  { length: 112, helperAt: 44, indexAt: 80, overrideAt: 84, fingerprint: '40bd680d20247be983bad917e8510595a94b10ebca7fd0c264ade1f651af7862' },
  { length: 115, helperAt: 15, indexAt: 72, overrideAt: 76, fingerprint: '293008f1233ad979f3bb176a5d838100f8ae9f7a788f2f6f7e5c711d2d0533fc' },
  { length: 108, helperAt: 48, indexAt: 84, overrideAt: 36, fingerprint: '37e3b1095ba0e2387d0bfee5a0c11a3f4b8853e9c404b8f02ab7f957cbd7307d' },
  { length: 125, helperAt: 48, indexAt: 101, overrideAt: 36, fingerprint: '666ae121229d3d6b1ca989657470ab3d4ed0a460e663d8da189f78caf35871f5' },
]

/** The JSR'd helper that looks up TranslevelNo, run on the default path. */
// prettier-ignore
export const MIDWAY_HELPERS: readonly FastRoutine[] = [
  { length: 55, fingerprint: 'bd376469488b88004a0560305a4204240f228b197666c6931ca136f066a0d25e' },
  { length: 72, fingerprint: 'd59a371c9deb23c7fc60c827fb8a8a40a9db3ac8426d302f108ce347daccbf43' },
]

/** STZ _F / LDY #0 / JML: Lunar Magic's midway hook in place of the OverworldOverride test. */
const MIDWAY_HOOK_SITE: BytePattern = [0x64, 0x0f, 0xa0, 0x00, 0x5c, WILD, WILD, WILD]

/**
 * Why $05D842 is not Lunar Magic's midway hook, or null when it is. Its midway
 * branch depends on game state (OWLevelTileSettings bit 6); the editor shows
 * the non-midway entry by design, a runtime-state default.
 */
function midwayHookMismatch(
  rom: RomFile,
  builds: readonly MidwayHookBuild[] = MIDWAY_BUILDS,
  helpers: readonly FastRoutine[] = MIDWAY_HELPERS,
): string | null {
  const site = rom.readAt(OVERWORLD_INDEX_GUARD.addr, MIDWAY_HOOK_SITE.length)
  if (!matchesBytes(site, MIDWAY_HOOK_SITE)) return '$05D83E holds no STZ _F / LDY #0 / JML.'
  const at = long(site!, 5)
  for (const b of builds) {
    const code = rom.readAt(at, b.length)
    const mask = [
      b.helperAt + 1,
      b.helperAt + 2,
      ...[b.indexAt, b.overrideAt].flatMap(e => [e + 1, e + 2, e + 3]),
    ]
    if (spanFingerprint(code, mask) !== b.fingerprint) continue
    if (long(code!, b.indexAt + 1) !== 0x05d847 || long(code!, b.overrideAt + 1) !== 0x05d8a2) {
      return `the hook at $${hex6(at)} does not return to $05D847 and $05D8A2.`
    }
    const helper = (at & 0xff0000) | code![b.helperAt + 1]! | (code![b.helperAt + 2]! << 8)
    const known = helpers.some(h => spanFingerprint(rom.readAt(helper, h.length)) === h.fingerprint)
    return known ? null : `its helper at $${hex6(helper)} is not a recognized build.`
  }
  return `the JML reaches $${hex6(at)}, which is not a recognized build of the hook.`
}

/** JSL loader / STA TranslevelNo: a hook in place of the table load. */
const LOAD_HOOK_SITE: BytePattern = [0x22, WILD, WILD, WILD, 0x8d, 0xbf, 0x13]

/** Loaders that return OWLayer1Translevel,X. The second returns save byte $70035C for translevel
 *  1; first boot sets it to 1 at $A0F20F, the table's value, the runtime-state default. */
// prettier-ignore
export const LOAD_HOOKS: readonly BytePattern[] = [
  [0x08, 0xc2, 0x30, 0xbf, 0x00, 0xd0, 0x7e, 0x29, 0xff, 0x00, 0x8d, 0xbf, 0x13, 0x28, 0x6b],
  [0x8b, 0x4b, 0xab, 0xbf, 0x00, 0xd0, 0x7e, 0xc9, 0x01, 0xd0, 0x0a, 0xaf, 0x5c, 0x03, 0x70,
    0xd0, 0x04, 0xbf, 0x00, 0xd0, 0x7e, 0xab, 0x6b],
]

/** Why $05D89B is not a recognized load hook, or null when it is. */
function loadHookMismatch(rom: RomFile): string | null {
  const at = jslTarget(rom, OVERWORLD_INDEX_LOAD.addr)
  const site = rom.readAt(OVERWORLD_INDEX_LOAD.addr, LOAD_HOOK_SITE.length)
  if (at === null || !matchesBytes(site, LOAD_HOOK_SITE)) {
    return '$05D89B holds no JSL before STA TranslevelNo.'
  }
  if (LOAD_HOOKS.some(p => matchesBytes(rom.readAt(at, p.length), p))) return null
  return `the JSL reaches $${hex6(at)}, which is not a recognized loader.`
}

/** The recognized hooks each stock check also accepts, and what to call them. */
const HOOKS = new Map<StockCode | StockSpan, [string, (rom: RomFile, h: Hooks) => string | null]>([
  [OVERWORLD_INDEX_GUARD, ["Lunar Magic's midway hook", (rom, h) => midwayHookMismatch(rom, ...h)]],
  [OVERWORLD_INDEX_LOAD, ['a recognized load hook', rom => loadHookMismatch(rom)]],
])
type Hooks = [builds?: readonly MidwayHookBuild[], helpers?: readonly FastRoutine[]]

/** Each check on the path into CODE_05D8A2 on its own: null where it holds. */
export function entryPathMismatches(
  rom: RomFile,
  spanFingerprints?: readonly string[],
  ...hooks: Hooks
): (string | null)[] {
  return ENTRY_PATH.map(c => {
    const stock = stockCodeMismatch(rom, [c], spanFingerprints)
    const hook = HOOKS.get(c)
    const why = stock && hook ? hook[1](rom, hooks) : null
    return hook ? why && `${stock} Nor is it ${hook[0]}: ${why}` : stock
  })
}

/** `TranslevelBias` once the path into CODE_05D8A2 is stock or recognized. */
export function readTranslevelBias(
  rom: RomFile,
  spanFingerprints?: readonly string[],
): TranslevelBiasSite {
  const path = entryPathMismatches(rom, spanFingerprints).find(r => r !== null)
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
