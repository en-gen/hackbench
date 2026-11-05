/**
 * #1061: the overworld entry path and the level-start gate hold no stock-code bytes. Single opcodes are
 * checked one at a time (rule 7), the rest by digests of at least 24 unknown bytes. Synthetic ROMs only;
 * the digests are the cart's own (SYNTHETIC_FINGERPRINTS), so nothing here needs the corpus. Each case
 * sweeps its whole range: all 256 values of an opcode, every offset of a digest.
 */
import { describe, expect, it } from 'vitest'
import {
  LEVEL_START_Y,
  OVERWORLD_ENTRY,
  OVERWORLD_INDEX_BODY,
  entryPathMismatches,
  stockCodeMismatch,
  type StockOp,
  type StockSpan,
} from '../../../src/rom/SubmapFlagGate'
import { blankStockRom, flip, SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'

const OPS = OVERWORLD_ENTRY.filter((c): c is StockOp => 'op' in c)
const SPANS = [...OVERWORLD_ENTRY, ...LEVEL_START_Y].filter((c): c is StockSpan => 'fingerprints' in c) // prettier-ignore
const bad = (rom: ReturnType<typeof blankStockRom>): (string | null)[] =>
  entryPathMismatches(rom, SYNTHETIC_FINGERPRINTS.entry, [], [])

describe('named-opcode checks on the overworld entry path', () => {
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
    expect(stockCodeMismatch(rom, [{ ...OPS[0]!, addr: 0xffffff }])).toContain('not readable')
  })
})

describe('the digests', () => {
  it.each(SPANS.map(s => [s.what, s] as const))('%s: at least 24 unknown bytes', (_w, s) => {
    // 4 bytes of margin for those the repo already states (MIDWAY_HOOK_SITE, BONUS_PRIMARY, SCREEN_EXIT).
    expect(s.length - (s.mask?.length ?? 0) - 16).toBeGreaterThanOrEqual(24)
  })

  it('the index digest refuses a change at every offset that is not masked, and only those', () => {
    const s = OVERWORLD_INDEX_BODY
    for (let off = 0; off < s.length; off++) {
      const rom = blankStockRom()
      flip(rom, s.addr + off)
      const refused = bad(rom).some(r => r !== null && r.startsWith('$' + s.addr.toString(16).toUpperCase().padStart(6, '0')) && r.includes('recognized build')) // prettier-ignore
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
