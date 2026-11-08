/**
 * #1061: the overworld entry path and the level-start gate state far less stock code (REACH and the JMP
 * literal remain, for #1109). Single opcodes are checked one at a time (rule 7), the rest by digests of
 * at least 24 unknown bytes. Synthetic ROMs only; the digests are the cart's own
 * (SYNTHETIC_FINGERPRINTS), so nothing here needs the corpus. Each case sweeps its whole range: all
 * 256 values of an opcode, every offset of a digest.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasRom, romPath, VANILLA } from '../support/corpus'
import { loadVanillaBytes, vanillaHits, windowSet } from '../support/vanillaWindows'
import {
  LEVEL_START_Y,
  ENTRY_RAM,
  LM_ENTRY_SITE_OPS,
  OVERWORLD_ENTRY,
  OVERWORLD_INDEX_BODY,
  entryPathMismatches,
  operandBytes,
  readTranslevelBias,
  stockCodeMismatch,
  type StockOp,
  type StockSpan,
} from '../../../src/rom/SubmapFlagGate'
import { formatAddr, loromToOffset } from '../../../src/rom/addressing'
import { RomFile } from '../../../src/rom/RomFile'
import { OP } from '../support/asm65'
import {
  blankStockRom,
  flip,
  SYNTHETIC_DISP,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'

const OPS = OVERWORLD_ENTRY.filter((c): c is StockOp => 'op' in c)
const SPANS = [...OVERWORLD_ENTRY, ...LEVEL_START_Y].filter(
  (c): c is StockSpan => 'fingerprints' in c,
)
const bad = (rom: ReturnType<typeof blankStockRom>): (string | null)[] =>
  entryPathMismatches(rom, SYNTHETIC_FINGERPRINTS.entry, [], [])

// Written by hand from bank_05.asm (instruction sizes summed from each label) with the independent opcode
// names in asm65.ts, so a wrong or deleted entry in the source goes red with no corpus. Fields: address,
// opcode and, for a RAM operand, the address it names (0 if none), from SMWDisX rammap.asm. No branch
// displacement is named: those sit in a digest (D191 187B). Known limit (D185): with no ROM this is the
// table checked against a second hand-written copy of itself; only the corpus test in
// SubmapFlagGate.ram.test.ts reads the ROM's own operands.
const HAND: readonly (readonly [number, number, number?])[] = [
  [0x05d842, OP.LDA_ABS, 0x0109],
  [0x05d845, OP.BNE],
  [0x05d89b, OP.LDA_LONGX, 0x7ed000],
  [0x05d89f, OP.STA_ABS, 0x13bf],
  [0x05d8a2, OP.CMP_IMM],
  [0x05d8a4, OP.BCC],
  [0x05d8a6, OP.SEC],
  [0x05d8a7, OP.SBC_IMM],
  [0x05d8a9, OP.STA_ABS, 0x17bb],
  [0x05d8ac, OP.STA_DP, 0x0e],
  [0x05d8ae, OP.LDA_ABSY, 0x1f11],
  [0x05d8b1, OP.BEQ],
  [0x05d8b3, OP.LDA_IMM],
  [0x05d8b5, OP.STA_DP, 0x0f],
]
const triple = (c: { addr: number; op: number; ram?: keyof typeof ENTRY_RAM }): number[] => [
  c.addr,
  c.op,
  c.ram === undefined ? 0 : ENTRY_RAM[c.ram],
]
const hand = (h: typeof HAND): number[][] => h.map(([a, o, r = 0]) => [a, o, r])

describe('named-opcode checks on the overworld entry path', () => {
  it('are exactly the hand-written instructions: addresses, opcodes and RAM operands', () => {
    expect(OPS.map(triple)).toEqual(hand(HAND))
    // The first seven site instructions, a JSL in place of the BEQ and the LDA, then the stock store to _F.
    const lm = [
      ...HAND.slice(4, 11),
      [0x05d8b1, OP.JSL],
      [0x05d8b5, OP.STA_DP, 0x0f],
    ] as typeof HAND
    expect(LM_ENTRY_SITE_OPS.map(triple)).toEqual(hand(lm))
    expect(OVERWORLD_INDEX_BODY).toMatchObject({
      addr: 0x05d83e,
      length: 93,
      mask: [4, 5, 6, 7],
      also: [
        [0x05d8a5, 1],
        [0x05d8b2, 1],
      ],
      lmSiteOmit: 94,
    })
  })

  it('name no branch landing: the source has no `lands` field on an op, and no code reads one', () => {
    for (const o of OPS) expect(Object.keys(o), o.what).not.toContain('lands')
    const src = readFileSync(join(__dirname, '../../../src/rom/SubmapFlagGate.ts'), 'utf8')
    expect(src).not.toMatch(/\blands\s*[?:]|\.lands\b/)
  })

  it.each(OPS.map(o => [o.what, o] as const))(
    '%s: only its own opcode passes, of all 256',
    (_w, o) => {
      for (let v = 0; v < 0x100; v++) {
        const rom = blankStockRom()
        rom.writeAt(o.addr, [v])
        expect(
          stockCodeMismatch(rom, [o], SYNTHETIC_FINGERPRINTS.entry) === null,
          `value ${v}`,
        ).toBe(v === o.op)
      }
    },
  )

  // The three displacements, by literal address (bank_05.asm:7168, 7218, 7224): each of all 256 values, and
  // only the cart's invented one passes, refused by the digest ("recognized build"), not by an op.
  it.each([
    ['BNE after the OverworldOverride test', 0x05d846, SYNTHETIC_DISP.bne],
    ['BCC over the bias', 0x05d8a5, SYNTHETIC_DISP.bcc],
    ['BEQ over the high byte', 0x05d8b2, SYNTHETIC_DISP.beq],
  ])('%s: only the cart displacement passes, of all 256, by the digest', (_w, at, invented) => {
    for (let d = 0; d < 0x100; d++) {
      const rom = blankStockRom()
      rom.writeAt(at, [d])
      const r = readTranslevelBias(rom, SYNTHETIC_FINGERPRINTS.entry)
      expect(r.ok, `disp ${d}`).toBe(d === invented)
      if (!r.ok) expect(r.reason, `disp ${d}`).toContain('not a recognized build of that code')
    }
  })

  // Hand lengths, so a wrong SIZE in the source goes red: cut inside the instruction is refused, whole is not.
  const LEN = new Map([
    [OP.SEC, 1],
    [OP.BCC, 2],
    [OP.BEQ, 2],
    [OP.BNE, 2],
    [OP.LDA_IMM, 2],
    [OP.CMP_IMM, 2],
    [OP.SBC_IMM, 2],
    [OP.STA_DP, 2],
    [OP.LDA_ABS, 3],
    [OP.LDA_ABSY, 3],
    [OP.STA_ABS, 3],
    [OP.LDA_LONGX, 4],
    [OP.JSL, 4],
  ])
  it.each([...OPS, LM_ENTRY_SITE_OPS[7]!].map(o => [o.what, o] as const))(
    '%s: an image cut inside the instruction is refused',
    (_w, o) => {
      const rom = blankStockRom()
      const cut = (n: number): RomFile =>
        new RomFile(
          'cut.sfc',
          Buffer.from(rom.readAtFileOffset(0, loromToOffset(o.addr, rom.romSize)! + n)!),
        )
      for (let n = 1; n < LEN.get(o.op)!; n++)
        expect(stockCodeMismatch(cut(n), [o]), `${n} bytes`).toContain('not readable')
      expect(stockCodeMismatch(cut(LEN.get(o.op)!), [o]) ?? '').not.toContain('not readable')
    },
  )
})

describe('the digests', () => {
  it.each(SPANS.map(s => [s.what, s] as const))('%s: at least 24 unknown bytes', (_w, s) => {
    // Known bytes subtracted, counted conservatively: the index span 4 (MIDWAY_HOOK_SITE); the exit span 22
    // (BONUS_PRIMARY 13, the DATA_05F800 load 3, BONUS_LOAD_JMP 3, 3 position-read opcodes); the main span 9
    // (5 position-read opcodes, 4 more bytes the cart plants). Leaves 86 (87 with the BEQ displacement), 84 and 263.
    const known = new Map([
      [0x05d83e, 4],
      [0x05d7d4, 22],
      [0x05d907, 9],
    ])
    const total = s.length + (s.also ?? []).reduce((n, [, len]) => n + len, 0)
    expect(total - (s.mask?.length ?? 0) - known.get(s.addr)!).toBeGreaterThanOrEqual(84)
  })

  it('the index digest refuses a change at every offset that is not masked, and only those', () => {
    const s = OVERWORLD_INDEX_BODY
    for (let off = 0; off < s.length; off++) {
      const rom = blankStockRom()
      flip(rom, s.addr + off)
      const refused = bad(rom).some(
        r => r?.startsWith(formatAddr(s.addr)) && r.includes('recognized build'),
      )
      expect(refused, `offset ${off}`).toBe(!s.mask!.includes(off))
    }
  })
})

// Corpus-gated: the game's own bytes are the oracle. Scoped to this PR's plants (the opcodes and the span
// heads, $05:D83E-$05:D8B6) so the cart's older fixtures are not reported.
describe.skipIf(!hasRom(VANILLA))('the planted stock cart against the game, window width 5', () => {
  it('has no vanilla window at the entry site (D191, entry-site scope)', () => {
    const cart = Uint8Array.from(blankStockRom().readAtFileOffset(0, 0x80000)!)
    const hits = vanillaHits(cart, windowSet(loadVanillaBytes(romPath(VANILLA)), 5), 5)
    const mine = hits.filter(h => h >= '$05:D83E' && h <= '$05:D8B6' && h.startsWith('$05:D8'))
    // The threshold, bias, RAM operands and the three branch displacements are invented, so the D8A2 windows
    // are gone, D8B0 with them (its window held the vanilla submap-flag operand), and D8B1 (its window held
    // the vanilla BEQ displacement; the high byte the cart keeps at 0 or 1 is not enough to match). D191
    // condition 2, entry-site scope: the rest of the built ROM is #1109's.
    expect(mine).toEqual([])
  })
})

describe('operandBytes', () => {
  it('refuses an opcode with no known size, naming it, instead of returning NaN', () => {
    expect(() => operandBytes(0x00)).toThrow(/opcode \$00/)
  })

  it('names the stock op whose opcode has no known size', () => {
    const o: StockOp = { ...OPS[0]!, op: 0x00, what: 'a planted op' }
    expect(() => stockCodeMismatch(blankStockRom(), [o])).toThrow(/opcode \$00 at .*a planted op/)
  })

  it('knows the size of every opcode the stock ops name', () => {
    for (const o of [...OPS, ...LM_ENTRY_SITE_OPS])
      expect(Number.isInteger(operandBytes(o.op)), formatAddr(o.addr)).toBe(true)
  })
})
