/**
 * Stage A of #653, synthetic half: the leaf grouping and table formatting.
 * The per-ROM sweep is L1Interpret.leafSweep.nightly.test.ts (`npm run test:corpus`).
 */
import { describe, it, expect } from 'vitest'
import {
  groupLeaves,
  agreeingStandardLeaves,
  formatTable,
  formatHeader,
  type LeafRow,
} from '../support/leafGrouping'

const NL = String.fromCharCode(10)
const TAB = String.fromCharCode(9)
const row = (leaf: number, o: Partial<LeafRow> = {}): LeafRow => ({
  kind: 'standard',
  leaf,
  top: 1,
  refusal: null,
  differs: false,
  ...o,
})

describe('leaf grouping (synthetic)', () => {
  const rows = [
    row(1),
    row(1),
    row(2),
    row(2, { refusal: 'unknown opcode', differs: null }),
    row(3),
    row(3, { differs: true }),
    row(3, { differs: true }),
    row(4, { kind: 'extended' }),
  ]
  it('marks a leaf with a refused or differing case as not agreeing, with exact counts', () => {
    const g = groupLeaves(rows)
    expect(g.get(1)).toEqual({ cases: 2, refused: {}, differs: 0, agrees: 2, notRun: 0 })
    expect(g.get(2)).toEqual({
      cases: 2,
      refused: { 'unknown opcode': 1 },
      differs: 0,
      agrees: 1,
      notRun: 0,
    })
    expect(g.get(3)).toEqual({ cases: 3, refused: {}, differs: 2, agrees: 1, notRun: 0 })
    expect(g.has(4)).toBe(false)
    expect(agreeingStandardLeaves(rows)).toEqual([1])
  })
  it('folds the $80 bank mirror into one leaf', () => {
    const g = groupLeaves([row(0x0da8c3), row(0x8da8c3, { differs: true })])
    expect(g.get(0x0da8c3)).toEqual({ cases: 2, refused: {}, differs: 1, agrees: 1, notRun: 0 })
  })
  it('keeps $0d8000 and $4d8000 as two keys', () => {
    expect([...groupLeaves([row(0x0d8000), row(0x4d8000)]).keys()]).toEqual([0x0d8000, 0x4d8000])
  })
  it('does not count a completed case with no port run as agreeing', () => {
    const r = [row(5), row(5, { differs: null })]
    expect(groupLeaves(r).get(5)).toEqual({
      cases: 2,
      refused: {},
      differs: 0,
      agrees: 1,
      notRun: 1,
    })
    expect(agreeingStandardLeaves(r)).toEqual([])
  })
  it('renders no-cases leaves and one full row exactly', () => {
    const t = formatTable(groupLeaves(rows), [2, 9]).split(NL)
    expect(t).toEqual([
      ['000002', '2', 'refused unknown opcode: 1', 'differs 0', 'agrees 1', 'not run 0'].join(TAB),
      ['000009', 'no cases'].join(TAB),
    ])
  })
  it('header totals include key 0 and keys outside the set', () => {
    const r = [
      row(0, { refusal: 'jml', differs: null }),
      row(0x8d0001),
      row(7, { refusal: 'x', differs: null }),
      row(0x10, { refusal: 'y', differs: null }),
      row(0x11, { differs: true }),
      row(0x12, { differs: null }),
    ]
    expect(formatHeader(groupLeaves(r), [7])).toBe(
      [
        'leaf keys are folded (bank bit 23 cleared)',
        'standard cases 6; refused by reason: jml: 1; x: 1; y: 1',
        'refused before any leaf dispatch (key 000000): 1',
        'cases on keys outside the vanilla set: 4 across 4 keys',
        'outside outcomes: refused 1; differs 1; agrees 1; not run 1',
      ].join(NL),
    )
  })
})
