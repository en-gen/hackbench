/**
 * Stage A of #653: which standard leaves the interpreter agrees on, and how
 * that holds up on a hack ROM. Test-only; nothing is routed through the
 * interpreter here.
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasRom, freshRom, VANILLA, CORPUS } from '../support/corpus'
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
    expect(formatTable(groupLeaves(rows), [1, 9])).toContain('000009\tno cases')
  })
})

// Report only (#653): the hacks assert nothing, the table is the product. The leaf set is
// vanilla's, so every case needs the vanilla ROM too.
let vanillaRuns: DiffRun[] | undefined
const vanillaLeaves = () => agreeingStandardLeaves((vanillaRuns ??= sweep(freshRom(VANILLA))))

for (const name of CORPUS) {
  describe.skipIf(!hasRom(name) || !hasRom(VANILLA))(`${name}: agreeing leaves (#653)`, () => {
    it('tabulates the vanilla-agreeing leaves', () => {
      const leaves = vanillaLeaves()
      if (name === VANILLA) expect(leaves.length).toBe(61)
      const runs = name === VANILLA ? vanillaRuns! : sweep(freshRom(name))
      const table = formatTable(groupLeaves(runs), leaves)
      console.log(`${name}
${table}`)
      const dir = process.env.LEAF_SWEEP_OUT
      if (dir) writeFileSync(join(dir, `${name}.tsv`), table)
    }, 600_000)
  })
}
