/**
 * The stock code a static model of a slot's high byte depends on. The high
 * byte comes from `LDA OWPlayerSubmap,Y / BEQ +`, not from any table, so a
 * model is right only while that code, and the path into it, is stock.
 *
 * The four edited corpus ROMs replace both BEQs with a JSL (6 ROMs, one
 * machine): empirical, not an ASM claim. A mismatch means code HackBench does
 * not decode, so callers decline rather than assume the stock rule.
 *
 * The overworld entry path is checked as the JMP target's digest (CODE_05D83E through the index
 * computation and three branch displacements, with the two instructions a Lunar Magic hook replaces
 * masked), then the guard's, the table load's and CODE_05D8A2's instructions one opcode at a time
 * (#1061): single named ISA constants, with the operands the model uses read from the ROM. The
 * guard and the load each also accept a recognized hook.
 */
import type { RomFile } from './RomFile'
import { WILD, matchesBytes, type BytePattern } from './BytePattern'
import { fingerprint } from './Fingerprint'
import { le24 } from './bytes'
import { formatAddr, mirror } from './addressing'
import { jslTarget, type FastRoutine } from './GfxDecompressor'
import { hex6, hexs } from './hex'

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
  /** Offsets zeroed before hashing: operands the caller reads and checks itself. Offsets here and in
   *  `lmSiteOmit` run over `addr`'s bytes, then `also`'s, in order. */
  mask?: readonly number[]
  /** Offset dropped from the hash when the LM site hook is recognized. */
  lmSiteOmit?: number
  /** Further [address, length] runs hashed after the first, in the same digest (FINGERPRINT MINIMUM rule 6). */
  also?: readonly (readonly [number, number])[]
  what: string
  cite: string
}

/** ISA opcodes, one named constant each: the checks below compare single instructions, never runs. */
const OP = {
  LDA_IMM: 0xa9,
  LDA_ABS: 0xad,
  LDA_ABS_Y: 0xb9,
  LDA_LONG_X: 0xbf,
  STA_DP: 0x85,
  STA_ABS: 0x8d,
  CMP_IMM: 0xc9,
  SBC_IMM: 0xe9,
  SEC: 0x38,
  BCC: 0x90,
  BEQ: 0xf0,
  BNE: 0xd0,
  JSL: 0x22,
} as const

/**
 * The seven RAM addresses the entry path's instructions name, one constant each, cited to SMWDisX
 * rammap.asm. A named exception to the no-hardcoded-ROM-values rule for this block only (D185,
 * docs/decisions/2026-11-05-d126-exception-entry-site-ram.md): opcodes and these addresses are named;
 * the threshold, bias, high byte and branch displacements stay read from the ROM. A hack that keeps the
 * opcodes but repoints a store would otherwise read as stock and yield a confidently wrong slot.
 */
export const ENTRY_RAM = Object.freeze({
  OverworldOverride: 0x0109, // rammap.asm:1036
  TranslevelNo: 0x13bf, // rammap.asm:1445
  LoadingLevelNumber: 0x17bb, // rammap.asm:1796
  OWPlayerSubmap: 0x1f11, // rammap.asm:2049
  OWLayer1Translevel: 0x7ed000, // rammap.asm:2115
  _E: 0x0e, // rammap.asm:23
  _F: 0x0f, // rammap.asm:24
})
export type RamKey = keyof typeof ENTRY_RAM
export type RamTable = Readonly<Record<RamKey, number>>

/** The span-fingerprint override a synthetic ROM passes; it may also carry its own RAM table. */
export type EntryFingerprints = readonly string[] & { readonly ram?: RamTable }

/** One instruction's opcode and, for a RAM operand, its key in the RAM table (never the value). A branch's
 *  displacement is not named: it sits in a digest (OVERWORLD_INDEX_BODY). */
export interface StockOp {
  addr: number
  op: number
  ram?: RamKey
  what: string
  cite: string
}

const op = (
  addr: number,
  code: number,
  what: string,
  cite: string,
  extra: { ram?: RamKey } = {},
): StockOp => Object.freeze({ addr, op: code, what, cite, ...extra })

const REACH: StockCode = {
  addr: 0x0096f4,
  bytes: [0x22, 0x96, 0xd7, 0x05],
  bankAt: 3,
  what: 'JSL CODE_05D796',
  cite: 'bank_00.asm:2644',
}

/** LDA OverworldOverride / BNE; the STZ _F and LDY #0 before them, and the BNE's displacement, are in the digest below. */
export const OVERWORLD_INDEX_GUARD: readonly StockOp[] = Object.freeze([
  op(0x05d842, OP.LDA_ABS, "CODE_05D83E's OverworldOverride test", 'bank_05.asm:7167', {
    ram: 'OverworldOverride',
  }),
  op(0x05d845, OP.BNE, "CODE_05D83E's BNE", 'bank_05.asm:7168'),
])

/**
 * CODE_05D83E from its first instruction through the index computation, to the table load, with the
 * displacements of the three branches the ops do not name (no distance is stated). Vanilla only, measured. ONE StockSpan, one
 * digest per path (#1061, FINGERPRINT MINIMUM rule 6, D191 187B). Spans: the 93 bytes $05D83E-$05D89A
 * (bank_05.asm:7164-7213, holding the guard's BNE displacement at $05D846), the BCC displacement at $05D8A5
 * (:7218) and the BEQ displacement at $05D8B2 (:7224). 4 masked (the guard's LDA and BNE opcode, which the
 * midway hook replaces; the ops check them), 4 already stated (MIDWAY_HOOK_SITE). The BNE displacement is
 * unmasked: 23 of 23 SMW-based midway-hooked corpus ROMs keep it (one machine).
 * Unknown-byte count, treating the 3 displacements as known because the op addresses let a reader derive
 * them (D191, #1109): fingerprints[0], stock: 95 bytes - 4 masked - 4 stated - 3 derivable = 84 unknown.
 * fingerprints[1], LM site: Lunar Magic's site hook overwrites $05D8B2 with its JSL address, so that byte
 * is omitted (`lmSiteOmit`), 94 - 4 - 4 - 3 = 83 unknown. Omitted, not zeroed, so a stock-site ROM whose
 * $05D8B2 happens to be 0 cannot hash to the LM value; the LM digest is tried only once the site hook is
 * recognized (entryPathMismatches).
 */
export const OVERWORLD_INDEX_BODY: StockSpan = Object.freeze({
  addr: 0x05d83e,
  length: 93,
  mask: Object.freeze([4, 5, 6, 7]),
  also: Object.freeze([
    Object.freeze([0x05d8a5, 1] as const),
    Object.freeze([0x05d8b2, 1] as const),
  ]),
  lmSiteOmit: 94,
  fingerprints: Object.freeze([
    // stock
    '8325c1cad42dd3525170a655b526c6d51c7da7e3a454aaf97381911241d6ee5d',
    // LM site hook ($05D8B2 omitted)
    '00a2f9f9d0fd33630c6a24dcfc7f3721246e9baba88ea0136b39fb79d9e85f0f',
  ]),
  what: 'CODE_05D83E, the OWLayer1Translevel index and three branch displacements',
  cite: 'bank_05.asm:7164-7213, 7218, 7224',
})

/** LDA.L OWLayer1Translevel,X / STA TranslevelNo; a JSL replaces the first (the second stays). */
export const OVERWORLD_INDEX_LOAD: readonly StockOp[] = Object.freeze([
  op(0x05d89b, OP.LDA_LONG_X, 'the OWLayer1Translevel load', 'bank_05.asm:7214', {
    ram: 'OWLayer1Translevel',
  }),
  op(0x05d89f, OP.STA_ABS, 'the store to TranslevelNo', 'bank_05.asm:7215', {
    ram: 'TranslevelNo',
  }),
])

/**
 * CODE_05D8A2 (bank_05.asm:7217-7226), one opcode at a time. The operands the model uses
 * (threshold, bias, high byte) are read by `readEntrySite`.
 */
const A2 = 'CODE_05D8A2'
export const ENTRY_SITE_OPS: readonly StockOp[] = Object.freeze([
  op(0x05d8a2, OP.CMP_IMM, `${A2}'s threshold compare`, 'bank_05.asm:7217'),
  op(0x05d8a4, OP.BCC, `${A2}'s BCC`, 'bank_05.asm:7218'),
  op(0x05d8a6, OP.SEC, `${A2}'s SEC`, 'bank_05.asm:7219'),
  op(0x05d8a7, OP.SBC_IMM, `${A2}'s bias subtract`, 'bank_05.asm:7220'),
  op(0x05d8a9, OP.STA_ABS, `${A2}'s store of the level number`, 'bank_05.asm:7221', {
    ram: 'LoadingLevelNumber',
  }),
  op(0x05d8ac, OP.STA_DP, `${A2}'s store to _E`, 'bank_05.asm:7222', { ram: '_E' }),
  op(0x05d8ae, OP.LDA_ABS_Y, `${A2}'s read of the submap flag`, 'bank_05.asm:7223', {
    ram: 'OWPlayerSubmap',
  }),
  op(0x05d8b1, OP.BEQ, `${A2}'s BEQ`, 'bank_05.asm:7224'),
  op(0x05d8b3, OP.LDA_IMM, `${A2}'s high byte`, 'bank_05.asm:7225'),
  op(0x05d8b5, OP.STA_DP, `${A2}'s store to _F`, 'bank_05.asm:7226', { ram: '_F' }),
])

export const OVERWORLD_ENTRY: readonly (StockCode | StockSpan | StockOp)[] = [
  REACH,
  { addr: 0x05d7b0, bytes: [0x4c, 0x3e, 0xd8], what: 'JMP CODE_05D83E', cite: 'bank_05.asm:7093' },
  ...OVERWORLD_INDEX_GUARD,
  OVERWORLD_INDEX_BODY,
  ...OVERWORLD_INDEX_LOAD,
  ...ENTRY_SITE_OPS,
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
 * The level load's start-position code the map view's L2 height reads tables through (#505):
 * the secondary entrance block, and CODE_05D8B7 from the index setup at bank_05.asm:7265 to CODE_05DA17 (the
 * settings, ScreenMode, primary rows, midway branch and high bytes). Vanilla only, measured; on
 * the 4 corpus hacks both spans differ, so their heights are unverified.
 */
export const LEVEL_START_Y: readonly (StockCode | StockSpan)[] = [
  REACH,
  {
    // ONE digest each (#1061). First: the secondary-exit branch and its _E index (bank_05.asm:7111-7119,
    // 22 bytes) merged with the FA00/FC00 position reads (:7120-7162, 84 bytes) it was adjacent to:
    // 106 bytes, none masked. Counted known inside it: 19 (BONUS_PRIMARY 13, SCREEN_EXIT's DATA_05F800
    // load 3, BONUS_LOAD_JMP 3) and 3 opcodes the position-read test names, so 84 unknown at least.
    addr: 0x05d7d4,
    length: 0x05d83e - 0x05d7d4,
    fingerprints: ['112f553172e14efb4f44c504f9412871556fd8a16f22c705d43660e5aef134fb'],
    what: 'the secondary-exit branch, its _E index and the secondary entrance position reads',
    cite: 'bank_05.asm:7111-7162',
  },
  {
    // Second: the index every F000..F600 read goes through (:7265-7267, 6 bytes) merged with the level
    // start positions (:7268-7395, 266 bytes): 272 bytes, none masked. Counted known inside it: 9 bytes
    // (the 5 position-read opcodes and the 4 further bytes of the two reads the synthetic cart plants),
    // so 263 unknown at least. The
    // pointer setup before it (:7227-7264) is not covered: it writes only the layer pointers, the
    // sprite header settings and Y, which :7267 overwrites.
    addr: 0x05d907,
    length: 0x05da17 - 0x05d907,
    fingerprints: ['ba2eb7bf0ee4a1d48876b8ab9763d1adef412f49ad4ebb18c660ee3757cd8c61'],
    what: 'the index for the main entrance position reads and the level start positions',
    cite: 'bank_05.asm:7265-7395',
  },
]

/**
 * Why the entrance-position readers (`readInitialLayer1YPos`, `readInitialLayer2YPos`: F400/F600,
 * FA00/FC00 through DATA_05D708/D70C) may not describe this ROM, or null when the code reading
 * them is stock. Covers, in order, the REACH call, the secondary-exit branch and index
 * (bank_05.asm:7111-7119), the FA00/FC00 reads (:7120-7162), the index and widths (:7265-7267) and
 * every F000-F600 read through the end of the start code (:7268-7395, to CODE_05DA17).
 * Not covered: the screen-exit lookup before :7111 (the exit graph's own gate), CODE_05D83E to
 * $05D8B6 (the overworld path, `readEntrySite`, where a Lunar Magic save hooks $05D8B1
 * legitimately), and the pointer setup :7227-7264, which touches no position input. Callers draw
 * the value anyway and say it is unverified.
 */
export const entrancePositionGate = (rom: RomFile, spans = LEVEL_START_Y): string | null =>
  stockCodeMismatch(rom, spans)

/**
 * The high byte `LDA #imm` at `at` loads for a submap, or a refusal: the
 * pointer table has $200 slots, so only 0 and 1 name one.
 */
export function readSubmapHigh(rom: RomFile, at: number): number | string {
  const high = rom.readByte(at)!
  if (high <= 1) return high
  return (
    `${formatAddr(at)} loads submap high byte ` +
    `${hexs(high)}, which names no slot: the pointer table ends at $1FF.`
  )
}

const ENTRY_PATH = OVERWORLD_ENTRY.slice(0, -ENTRY_SITE_OPS.length)
/** The stock site's `LDA OWPlayerSubmap,Y` is its seventh instruction; the hook's JSL follows. */
const SITE_KEPT = 7
const JSL_AT = 0x05d8b1

/** CODE_05D8A2 as Lunar Magic leaves it: the first seven instructions, then a JSL, then the last. */
export const LM_ENTRY_SITE_OPS: readonly StockOp[] = Object.freeze([
  ...ENTRY_SITE_OPS.slice(0, SITE_KEPT),
  op(JSL_AT, OP.JSL, "CODE_05D8A2's high-byte JSL", 'bank_05.asm:7224'),
  ENTRY_SITE_OPS[ENTRY_SITE_OPS.length - 1]!,
])

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
function lmEntryHook(
  rom: RomFile,
  spanFingerprints?: EntryFingerprints,
): { threshold: number; bias: number } | string {
  const site = stockCodeMismatch(rom, LM_ENTRY_SITE_OPS, spanFingerprints)
  if (site) return site
  const b = rom.readAt(JSL_AT + 1, 3)!
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
export function readEntrySite(
  rom: RomFile,
  spanFingerprints?: EntryFingerprints,
): TranslevelBiasSite {
  const stock = stockCodeMismatch(rom, ENTRY_SITE_OPS, spanFingerprints)
  if (stock) {
    const hook = lmEntryHook(rom, spanFingerprints)
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
export const MIDWAY_HOOK_SITE: BytePattern = [0x64, 0x0f, 0xa0, 0x00, 0x5c, WILD, WILD, WILD]

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
  const site = rom.readAt(OVERWORLD_INDEX_BODY.addr, MIDWAY_HOOK_SITE.length)
  if (!matchesBytes(site, MIDWAY_HOOK_SITE)) return '$05D83E holds no STZ _F / LDY #0 / JML.'
  const at = le24(site!, 5)
  for (const b of builds) {
    const code = rom.readAt(at, b.length)
    const mask = [
      b.helperAt + 1,
      b.helperAt + 2,
      ...[b.indexAt, b.overrideAt].flatMap(e => [e + 1, e + 2, e + 3]),
    ]
    if (spanFingerprint(code, mask) !== b.fingerprint) continue
    if (
      mirror(le24(code!, b.indexAt + 1)) !== 0x05d847 ||
      mirror(le24(code!, b.overrideAt + 1)) !== 0x05d8a2
    ) {
      return `the hook at $${hex6(at)} does not return to $05D847 and $05D8A2.`
    }
    const helper = (at & 0xff0000) | code![b.helperAt + 1]! | (code![b.helperAt + 2]! << 8)
    const known = helpers.some(h => spanFingerprint(rom.readAt(helper, h.length)) === h.fingerprint)
    return known ? null : `its helper at $${hex6(helper)} is not a recognized build.`
  }
  return `the JML reaches $${hex6(at)}, which is not a recognized build of the hook.`
}

/** JSL loader / STA TranslevelNo: a hook in place of the table load. */
// The store's operand is checked as an op, so the pattern stops at its opcode.
const LOAD_HOOK_SITE: BytePattern = [OP.JSL, WILD, WILD, WILD, OP.STA_ABS]

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
  const at = jslTarget(rom, OVERWORLD_INDEX_LOAD[0]!.addr)
  const site = rom.readAt(OVERWORLD_INDEX_LOAD[0]!.addr, LOAD_HOOK_SITE.length)
  if (at === null || !matchesBytes(site, LOAD_HOOK_SITE)) {
    return '$05D89B holds no JSL before STA TranslevelNo.'
  }
  if (LOAD_HOOKS.some(p => matchesBytes(rom.readAt(at, p.length), p))) return null
  return `the JSL reaches $${hex6(at)}, which is not a recognized loader.`
}

/** The recognized hooks each stock check also accepts, and what to call them. */
const midway = [
  "Lunar Magic's midway hook",
  (rom: RomFile, h: Hooks) => midwayHookMismatch(rom, ...h),
] as const
const HOOKS = new Map<object, readonly [string, (rom: RomFile, h: Hooks) => string | null]>([
  ...OVERWORLD_INDEX_GUARD.map(c => [c, midway] as const),
  [OVERWORLD_INDEX_LOAD[0]!, ['a recognized load hook', rom => loadHookMismatch(rom)]],
])
type Hooks = [builds?: readonly MidwayHookBuild[], helpers?: readonly FastRoutine[]]

/** Each check on the path into CODE_05D8A2 on its own: null where it holds. */
export function entryPathMismatches(
  rom: RomFile,
  spanFingerprints?: EntryFingerprints,
  ...hooks: Hooks
): (string | null)[] {
  return ENTRY_PATH.map(c => {
    let stock = stockCodeMismatch(rom, [c], spanFingerprints)
    // The LM site hook overwrites the BEQ displacement in the body digest: try its variant only then.
    if (stock && 'lmSiteOmit' in c) {
      const lm = lmEntryHook(rom, spanFingerprints)
      if (typeof lm === 'string') stock += ` Nor is it Lunar Magic's hook: ${lm}`
      else stock = stockCodeMismatch(rom, [c], spanFingerprints, true)
    }
    const hook = HOOKS.get(c)
    const why = stock && hook ? hook[1](rom, hooks) : null
    return hook ? why && `${stock} Nor is it ${hook[0]}: ${why}` : stock
  })
}

/** `TranslevelBias` once the path into CODE_05D8A2 is stock or recognized. */
export function readTranslevelBias(
  rom: RomFile,
  spanFingerprints?: EntryFingerprints,
): TranslevelBiasSite {
  const path = entryPathMismatches(rom, spanFingerprints).find(r => r !== null)
  return path ? { ok: false, reason: path } : readEntrySite(rom, spanFingerprints)
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

/** A span's bytes as hashed: its own run, then each `also` run; null if any is unreadable. */
export function spanBytes(rom: RomFile, c: StockSpan, lmSite = false): Uint8Array | null {
  const runs = [[c.addr, c.length] as const, ...(c.also ?? [])].map(([a, n]) => rom.readAt(a, n))
  if (!runs.every(r => r !== null)) return null
  const all = runs.flatMap(r => [...r!])
  return Uint8Array.from(lmSite ? all.filter((_, i) => i !== c.lmSiteOmit) : all)
}

const hex = (bytes: Iterable<number>): string =>
  [...bytes].map(b => (b === WILD ? '??' : b.toString(16).padStart(2, '0'))).join(' ')

/** Bytes per instruction at the 8-bit widths the stock site runs in, so a read covers the operand too. */
const SIZE: Readonly<Record<number, number>> = {
  [OP.SEC]: 1,
  [OP.LDA_IMM]: 2,
  [OP.CMP_IMM]: 2,
  [OP.SBC_IMM]: 2,
  [OP.STA_DP]: 2,
  [OP.BCC]: 2,
  [OP.BEQ]: 2,
  [OP.BNE]: 2,
  [OP.LDA_ABS]: 3,
  [OP.LDA_ABS_Y]: 3,
  [OP.STA_ABS]: 3,
  [OP.LDA_LONG_X]: 4,
  [OP.JSL]: 4,
}

/** Operand bytes of an instruction: its size less the opcode. */
export const operandBytes = (code: number): number => SIZE[code]! - 1

/** Why the instruction at `c.addr` is not the stock one, or null: its opcode and, for a RAM operand, its
 *  address against `ram`. The whole instruction must be readable: an operand past the end of the image
 *  is a refusal. */
function opMismatch(rom: RomFile, c: StockOp, ram: RamTable): string | null {
  const at = rom.readAt(c.addr, SIZE[c.op]!)
  const name = `${formatAddr(c.addr)} (${c.what}, ${c.cite})`
  if (!at) return `${name} is not readable.`
  if (at[0] !== c.op) return `${name} holds opcode ${hexs(at[0]!)}, not the stock ${hexs(c.op)}.`
  if (c.ram !== undefined) {
    const found = at.subarray(1).reduce((v, b, i) => v | (b << (8 * i)), 0)
    const want = ram[c.ram]
    const show = (v: number): string => hexs(v, 2 * operandBytes(c.op))
    if (found !== want) return `${name} addresses ${show(found)}, not ${c.ram} at ${show(want)}.`
  }
  return null
}

/**
 * A sentence naming the first run that is not stock, or null when all are.
 *
 * @param spanFingerprints Replaces every span's own list; for a synthetic ROM. Its `ram`, if any,
 *   replaces ENTRY_RAM the same way.
 */
export function stockCodeMismatch(
  rom: RomFile,
  checks: readonly (StockCode | StockSpan | StockOp)[],
  spanFingerprints?: EntryFingerprints,
  lmSite = false,
): string | null {
  for (const c of new Set(checks)) {
    if ('op' in c) {
      const why = opMismatch(rom, c, spanFingerprints?.ram ?? ENTRY_RAM)
      if (why) return why
      continue
    }
    if ('fingerprints' in c) {
      const fp = spanFingerprint(spanBytes(rom, c, lmSite), c.mask)
      if (fp !== null && (spanFingerprints ?? c.fingerprints).includes(fp)) continue
      return (
        `${formatAddr(c.addr)} (${c.what}, ${c.cite}) is ` +
        `${fp ? 'not a recognized build of that code' : 'not readable'}.`
      )
    }
    const found = rom.readAt(c.addr, c.bytes.length)
    const same = (b: number, i: number): boolean =>
      b === WILD ? true : i === c.bankAt ? ((found![i]! ^ b) & 0x7f) === 0 : found![i] === b
    if (found && c.bytes.every(same)) continue
    return (
      `${formatAddr(c.addr)} (${c.what}, ${c.cite}) holds ` +
      `${found ? hex(found) : 'nothing readable'}, not the stock ${hex(c.bytes)}.`
    )
  }
  return null
}
