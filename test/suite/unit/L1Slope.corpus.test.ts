/**
 * #342 on vanilla: map $1E0's cloud slope (object $12, size $E5, CODE_0DADEB,
 * bank_0D.asm:2671) is a staircase from (8,8) to (68,23), where the cursor ends:
 * four columns right per row, fifteen lips, then a last row of body. It was a
 * 4-wide column under (8,8) while the port drew it.
 * Asserts structure, not tile numbers: each row's lip is the first row's four
 * tiles, its body sits under the previous lip, fill runs left of the body.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildL1Inputs } from '../../../src/rom/model/L1Model'
import { SWITCH_FLAGS_UNCLEARED } from '../../../src/rom/ObjectExpander'
import { freshRom, hasRom, VANILLA } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('cloud slope on map $1E0, vanilla (#342)', () => {
  let grid: number[][] = []
  let animNote: string | undefined
  beforeAll(() => {
    const built = buildL1Inputs(new SmwRom(freshRom(VANILLA)), 0x1e0, SWITCH_FLAGS_UNCLEARED)
    if (!built.ok) throw new Error(built.reason)
    ;({ grid, animNote } = built.inputs)
  })
  const at = (x: number, y: number) => grid[y][x]
  const lip = () => [8, 9, 10, 11].map(x => at(x, 8))

  it('draws a lip four columns right and one row down, fifteen times', () => {
    expect(new Set(lip()).size).toBe(4)
    for (let k = 0; k < 15; k++)
      expect([0, 1, 2, 3].map(c => at(8 + 4 * k + c, 8 + k))).toEqual(lip())
  })

  it('draws one lip per row, and none on the last row, which is body and fill', () => {
    for (let k = 0; k < 15; k++)
      expect(grid[8 + k].filter(t => t === lip()[0]).length, `row ${8 + k}`).toBe(1)
    expect(grid[23].filter(t => t === lip()[0]).length).toBe(0)
    for (let c = 0; c < 4; c++) expect(at(64 + c, 23)).toBe(at(8 + c, 9))
  })

  it('has body under each lip and fill, not body, two rows below the first lip', () => {
    for (let c = 0; c < 4; c++) expect(at(12 + c, 10)).toBe(at(8 + c, 9))
    // The defect drew body down the whole column under (8,8).
    expect(at(8, 9)).not.toBe(at(8, 10))
    expect(at(8, 10)).toBe(at(8, 20))
  })

  it('notes nothing: the interpreter read this ROM without refusing', () => {
    expect(animNote ?? '').not.toMatch(/0DADEB/)
  })
})
