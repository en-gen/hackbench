/**
 * Stage A of #653: which standard leaves the interpreter agrees on, and how
 * that holds up on a hack ROM. Test-only; nothing is routed through the
 * interpreter here.
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { hasRom, freshRom, VANILLA, INVICTUS } from '../support/corpus'
import { sweep, type DiffRun } from '../support/l1Differential'
import { groupLeaves, agreeingStandardLeaves, formatTable } from '../support/leafGrouping'

type Row = Pick<DiffRun, 'kind' | 'leaf' | 'top' | 'refusal' | 'differs'>
const row = (leaf: number, o: Partial<Row> = {}): Row => ({
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
    expect(g.get(1)).toEqual({ cases: 2, refused: {}, differs: 0, agrees: 2 })
    expect(g.get(2)).toEqual({ cases: 2, refused: { 'unknown opcode': 1 }, differs: 0, agrees: 1 })
    expect(g.get(3)).toEqual({ cases: 3, refused: {}, differs: 2, agrees: 1 })
    expect(g.has(4)).toBe(false)
    expect(agreeingStandardLeaves(rows)).toEqual([1])
  })
  it('folds the $80 bank mirror into one leaf', () => {
    const g = groupLeaves([row(0x0da8c3), row(0x8da8c3, { differs: true })])
    expect(g.get(0x0da8c3)).toEqual({ cases: 2, refused: {}, differs: 1, agrees: 1 })
  })
  it('renders no-cases leaves explicitly', () => {
    expect(formatTable(groupLeaves(rows), [1, 9])).toContain('9\tno cases')
  })
})

// Leaf routines are 24-bit addresses; print them as hex in the table.
const hexLeaves = (ls: readonly number[]) => ls.map(l => l.toString(16).padStart(6, '0'))

describe.skipIf(!hasRom(VANILLA) || !hasRom(INVICTUS))('agreeing leaves across ROMs (#653)', () => {
  it('vanilla has 61 agreeing standard leaves; Invictus sample table', () => {
    const vanilla = sweep(freshRom(VANILLA))
    const leaves = agreeingStandardLeaves(vanilla)
    console.log(`vanilla agreeing leaves: ${leaves.length}\n${hexLeaves(leaves).join(' ')}`)
    expect(leaves.length).toBe(61)

    // Invictus: the most divergent engine in the corpus, so the leaves most likely to move.
    const table = formatTable(groupLeaves(sweep(freshRom(INVICTUS))), leaves)
      .split('\n')
      .map((l, i) => l.replace(/^\d+/, hexLeaves(leaves)[i]))
      .join('\n')
    console.log(table)
    if (process.env.LEAF_SWEEP_OUT) writeFileSync(process.env.LEAF_SWEEP_OUT, table)
  }, 1_800_000)
})

// The full-CORPUS run is left out until the owner signs off on the Invictus sample.
