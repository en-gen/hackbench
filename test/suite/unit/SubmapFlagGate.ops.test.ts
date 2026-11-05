/**
 * #1061: the overworld entry path and the level-start gate state far less stock code (REACH and the JMP
 * literal remain, for #1109). Single opcodes are checked one at a time (rule 7), the rest by digests of
 * at least 24 unknown bytes. Synthetic ROMs only;
 * the digests are the cart's own (SYNTHETIC_FINGERPRINTS), so nothing here needs the corpus. Each case
 * sweeps its whole range: all 256 values of an opcode, every offset of a digest.
 */
import { describe, expect, it } from 'vitest'
import { hasRom, romPath, VANILLA } from '../support/corpus'
import { loadVanillaBytes, vanillaHits, windowSet } from '../support/vanillaWindows'
import {
  LEVEL_START_Y,
  LM_ENTRY_SITE_OPS,
  OVERWORLD_ENTRY,
  OVERWORLD_INDEX_BODY,
  entryPathMismatches,
  readTranslevelBias,
  stockCodeMismatch,
  type StockOp,
  type StockSpan,
} from '../../../src/rom/SubmapFlagGate'
import { formatAddr, loromToOffset } from '../../../src/rom/addressing'
import { RomFile } from '../../../src/rom/RomFile'
import { OP } from '../support/asm65'
import { blankStockRom, flip, SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'

const OPS = OVERWORLD_ENTRY.filter((c): c is StockOp => 'op' in c)
const SPANS = [...OVERWORLD_ENTRY, ...LEVEL_START_Y].filter((c): c is StockSpan => 'fingerprints' in c) // prettier-ignore
const bad = (rom: ReturnType<typeof blankStockRom>): (string | null)[] =>
  entryPathMismatches(rom, SYNTHETIC_FINGERPRINTS.entry, [], [])

// Written by hand from bank_05.asm (instruction sizes summed from each label) with the independent opcode
// names in asm65.ts, so a wrong or deleted entry in the source goes red with no corpus. Fields: address,
// opcode, and for a branch where it lands.
// prettier-ignore
const HAND: readonly (readonly [number, number, number?])[] = [
  [0x05d842, OP.LDA_ABS], [0x05d845, OP.BNE, 0x05d8a2],
  [0x05d89b, OP.LDA_LONGX], [0x05d89f, OP.STA_ABS],
  [0x05d8a2, OP.CMP_IMM], [0x05d8a4, OP.BCC, 0x05d8a9], [0x05d8a6, OP.SEC], [0x05d8a7, OP.SBC_IMM],
  [0x05d8a9, OP.STA_ABS], [0x05d8ac, OP.STA_DP], [0x05d8ae, OP.LDA_ABSY],
  [0x05d8b1, OP.BEQ, 0x05d8b5], [0x05d8b3, OP.LDA_IMM], [0x05d8b5, OP.STA_DP],
]
const triple = (c: { addr: number; op: number; lands?: number }): number[] => [c.addr, c.op, c.lands ?? 0] // prettier-ignore
const hand = (h: typeof HAND): number[][] => h.map(([a, o, l = 0]) => [a, o, l])

describe('named-opcode checks on the overworld entry path', () => {
  it('are exactly the hand-written instructions: addresses, opcodes and branch landings', () => {
    expect(OPS.map(triple)).toEqual(hand(HAND))
    // The first seven site instructions, a JSL in place of the BEQ and the LDA, then the stock store to _F.
    const lm = [...HAND.slice(4, 11), [0x05d8b1, OP.JSL], [0x05d8b5, OP.STA_DP]] as typeof HAND
    expect(LM_ENTRY_SITE_OPS.map(triple)).toEqual(hand(lm))
    expect(OVERWORLD_INDEX_BODY).toMatchObject({
      addr: 0x05d83e,
      length: 93,
      mask: [4, 5, 6, 7, 8],
    })
  })

  it.each([0x05d846, 0x05d8b2])('a branch displacement flipped at %i is refused', at => {
    const rom = blankStockRom()
    flip(rom, at)
    expect(readTranslevelBias(rom, SYNTHETIC_FINGERPRINTS.entry).ok).toBe(false)
  })

  // Instruction lengths by hand: an image cut one byte short of the whole instruction is refused, whole is not.
  const LEN = new Map([[OP.SEC, 1], [OP.BCC, 2], [OP.BEQ, 2], [OP.BNE, 2], [OP.LDA_IMM, 2], [OP.CMP_IMM, 2], [OP.SBC_IMM, 2], [OP.STA_DP, 2], [OP.LDA_ABS, 3], [OP.LDA_ABSY, 3], [OP.STA_ABS, 3], [OP.LDA_LONGX, 4], [OP.JSL, 4]]) // prettier-ignore
  it.each([...OPS, LM_ENTRY_SITE_OPS[7]!].map(o => [o.what, o] as const))(
    '%s: an image ending inside the instruction is not readable, ending after it is',
    (_w, o) => {
      const rom = blankStockRom()
      const at = loromToOffset(o.addr, rom.romSize)!
      const cut = (n: number): RomFile => new RomFile('cut.sfc', Buffer.from(rom.readAtFileOffset(0, at + n)!)) // prettier-ignore
      expect(stockCodeMismatch(cut(LEN.get(o.op)! - 1), [o])).toContain('not readable')
      expect(stockCodeMismatch(cut(LEN.get(o.op)!), [o]) ?? '').not.toContain('not readable')
    },
  )

  it('covers the guard, the table load and the whole CODE_05D8A2 block', () => {
    expect(OPS.length).toBe(14)
    expect(bad(blankStockRom()).every(r => r === null)).toBe(true)
  })

  it.each(OPS.map(o => [o.what, o] as const))(
    '%s: only its own opcode passes, of all 256',
    (_w, o) => {
      for (let v = 0; v < 0x100; v++) {
        const rom = blankStockRom()
        rom.writeAt(o.addr, [v])
        expect(stockCodeMismatch(rom, [o]) === null, `value ${v}`).toBe(v === o.op)
      }
    },
  )

  it.each(OPS.filter(o => o.lands !== undefined).map(o => [o.what, o] as const))(
    '%s: a branch aimed anywhere but its stock landing is refused, of all 256 displacements',
    (_w, o) => {
      for (let d = 0; d < 0x100; d++) {
        const rom = blankStockRom()
        rom.writeAt(o.addr + 1, [d])
        const landing = o.addr + 2 + ((d << 24) >> 24)
        expect(stockCodeMismatch(rom, [o]) === null, `disp ${d}`).toBe(landing === o.lands)
      }
    },
  )

  it('a read past the end of the image is a refusal, not a pass', () => {
    const rom = blankStockRom()
    for (let addr = 0xffffe0; addr <= 0xffffff; addr++) {
      expect(stockCodeMismatch(rom, [{ ...OPS[0]!, addr }]), formatAddr(addr)).toContain('not readable') // prettier-ignore
    }
  })
})

describe('the digests', () => {
  it.each(SPANS.map(s => [s.what, s] as const))('%s: at least 24 unknown bytes', (_w, s) => {
    // Known bytes subtracted, counted conservatively: the index span 4 (MIDWAY_HOOK_SITE); the exit span 22
    // (BONUS_PRIMARY 13, the DATA_05F800 load 3, BONUS_LOAD_JMP 3, 3 position-read opcodes); the main span 9
    // (5 position-read opcodes, 4 more bytes the cart plants). Leaves 84, 84 and 263.
    const known = new Map([[0x05d83e, 4], [0x05d7d4, 22], [0x05d907, 9]]) // prettier-ignore
    expect(s.length - (s.mask?.length ?? 0) - known.get(s.addr)!).toBeGreaterThanOrEqual(84)
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

  it('the level-start gate is the reach call plus two merged spans, contiguous with the old ranges', () => {
    const spans = LEVEL_START_Y.filter((c): c is StockSpan => 'fingerprints' in c)
    expect(LEVEL_START_Y.length).toBe(3)
    expect(spans.map(s => [s.addr, s.length])).toEqual([
      [0x05d7d4, 0x05d83e - 0x05d7d4],
      [0x05d907, 0x05da17 - 0x05d907],
    ])
  })
})

// Corpus-gated: the game's own bytes are the oracle. Scoped to this PR's plants (the opcodes and the span
// heads, $05:D83E-$05:D8B6) so the cart's older fixtures are not reported.
describe.skipIf(!hasRom(VANILLA))('the planted stock cart against the game, window width 5', () => {
  it('has only the known windows at the entry site: a ratchet, not an approval', () => {
    const cart = Uint8Array.from(blankStockRom().readAtFileOffset(0, 0x80000)!)
    const hits = vanillaHits(cart, windowSet(loadVanillaBytes(romPath(VANILLA)), 5), 5)
    const mine = hits.filter(h => h >= '$05:D83E' && h <= '$05:D8B6' && h.startsWith('$05:D8'))
    // The threshold and bias are invented, so the D8A2 windows are gone. The high byte the cart must keep
    // at 0 or 1 still equals the game's: that is what leaves D8B0 and D8B1.
    expect(mine).toEqual(['$05:D8B0', '$05:D8B1'])
  })
})
