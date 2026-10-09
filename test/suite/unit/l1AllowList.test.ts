import { describe, expect, it } from 'vitest'
import { createGrid } from '../../../src/rom/ObjectExpander'
import { sameScreen, type DiffRun } from '../support/l1Differential'
import { KNOWN_DISAGREEMENTS, tally } from '../support/l1AllowList'

// Synthetic grids and runs only: no ROM, so this runs in CI. Screen 5 is the
// screen the sweep places objects on (columns 80-95, rows 0-26).
const SCREEN = 5
const FIRST = SCREEN * 16

const pair = () => [createGrid(8), createGrid(8)] as const

describe('sameScreen', () => {
  it('is true for identical grids', () => {
    const [a, b] = pair()
    expect(sameScreen(a, b, SCREEN)).toBe(true)
  })

  it.each([
    ['first cell', 0, FIRST],
    ['column 15, row 26 (last cell)', 26, FIRST + 15],
    ['column 15, row 0', 0, FIRST + 15],
    ['column 0, row 26', 26, FIRST],
  ])('is false for a difference at the %s of the screen', (_n, row, col) => {
    const [a, b] = pair()
    b[row][col] = 0x77
    expect(sameScreen(a, b, SCREEN)).toBe(false)
  })

  it.each([
    ['the column before', 10, FIRST - 1],
    ['the column after', 10, FIRST + 16],
    ['a far screen', 10, 3],
  ])('ignores a difference in %s', (_n, row, col) => {
    const [a, b] = pair()
    b[row][col] = 0x77
    expect(sameScreen(a, b, SCREEN)).toBe(true)
  })

  it('ignores a difference in the first row past the screen', () => {
    // The real grid has exactly 27 rows, so build one with a spare row.
    const [a, b] = [createGrid(8), createGrid(8)].map(g => [...g, [...g[0]]])
    b[27][FIRST] = 0x77
    expect(sameScreen(a, b, SCREEN)).toBe(true)
  })
})

const LEAF = 0x0db49e
const run = (over: Partial<DiffRun>): DiffRun => ({
  kind: 'standard',
  tileset: 0,
  obj: 1,
  size: 0x05,
  col: 3,
  row: 2,
  fits: true,
  leaf: LEAF,
  top: LEAF,
  refusal: null,
  differs: true,
  ownScreenDiffers: false,
  digest: 'aa',
  ...over,
})
const name = () => 'run'

describe('tally and offScreenOnly', () => {
  it('flags only the #300 row', () => {
    const flagged = KNOWN_DISAGREEMENTS.filter(k => k.offScreenOnly)
    expect(flagged.map(k => [k.routine, k.why])).toEqual([[LEAF, 300]])
  })

  it('absorbs an off-screen-only difference on the flagged row', () => {
    const t = tally([run({})], name)
    expect(t.unexpected).toEqual([])
    expect(t.disagreements.find(d => d.why === 300)?.expect[0]).toBe(1)
  })

  it('refuses an own-screen difference on the flagged row', () => {
    const t = tally([run({ ownScreenDiffers: true })], name)
    expect(t.unexpected).toHaveLength(1)
    expect(t.unexpected[0]).toContain('own screen differs')
    expect(t.disagreements.find(d => d.why === 300)?.expect[0]).toBe(0)
  })

  it('still absorbs an own-screen difference on an unflagged row', () => {
    const t = tally([run({ leaf: 0x0dadeb, ownScreenDiffers: true })], name)
    expect(t.unexpected).toEqual([])
  })
})
