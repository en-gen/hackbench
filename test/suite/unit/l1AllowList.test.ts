import { describe, expect, it } from 'vitest'
import { createGrid } from '../../../src/rom/ObjectExpander'
import { compareRun, hex6, sameScreen, type DiffRun } from '../support/l1Differential'
import { KNOWN_DISAGREEMENTS, aggregate, tally, type Known } from '../support/l1AllowList'

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
    // Guards the loop bound: the real grid has exactly 27 rows, so build one with a spare row.
    const [a, b] = [createGrid(8), createGrid(8)].map(g => [...g, [...g[0]]])
    b[27][FIRST] = 0x77
    expect(sameScreen(a, b, SCREEN)).toBe(true)
  })
})

describe('compareRun', () => {
  it('reports identical grids as false/false', () => {
    const [a, b] = pair()
    expect(compareRun(a, b)).toEqual({ differs: false, ownScreenDiffers: false })
  })
  it('reports a difference on the object screen as true/true', () => {
    const [a, b] = pair()
    b[4][FIRST + 2] = 0x77
    expect(compareRun(a, b)).toEqual({ differs: true, ownScreenDiffers: true })
  })
  it('reports a difference only on the next screen as true/false', () => {
    const [a, b] = pair()
    b[4][(SCREEN + 1) * 16] = 0x77
    expect(compareRun(a, b)).toEqual({ differs: true, ownScreenDiffers: false })
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
  portDigest: 'pp',
  ...over,
})
const name = () => 'run'
/** Port-pin lines are covered below; these older tests look at the screen verdict only. */
const screenLines = (u: string[]) => u.filter(l => !l.includes('port output'))

describe('tally and offScreenOnly', () => {
  it('flags only the #300 row', () => {
    const flagged = KNOWN_DISAGREEMENTS.filter(k => k.offScreenOnly)
    expect(flagged.map(k => [k.routine, k.why])).toEqual([[LEAF, 300]])
  })

  it('absorbs an off-screen-only difference on the flagged row', () => {
    const t = tally([run({})], name)
    expect(screenLines(t.unexpected)).toEqual([])
    expect(t.disagreements.find(d => d.why === 300)?.expect[0]).toBe(1)
  })

  it('refuses an own-screen difference on the flagged row', () => {
    const t = tally([run({ ownScreenDiffers: true })], name)
    expect(screenLines(t.unexpected)).toHaveLength(1)
    expect(t.unexpected[0]).toContain('own screen differs')
    expect(t.disagreements.find(d => d.why === 300)?.expect[0]).toBe(0)
  })

  it('still absorbs an own-screen difference on an unflagged row', () => {
    const t = tally([run({ leaf: 0x0dadeb, ownScreenDiffers: true })], name)
    expect(screenLines(t.unexpected)).toEqual([])
  })
})

describe('tally pins the port output (#751)', () => {
  const portLines = (u: string[]) => u.filter(l => l.includes('port output differs'))

  it('reports a planted port change under a non-#300 row', () => {
    const t = tally([run({ leaf: 0x0dadeb, top: 0x0dadeb, portDigest: 'planted' })], name)
    // The other rows absorb nothing in this synthetic list, so they differ from their pins too.
    expect(portLines(t.unexpected)).toContain(
      '$0DADEB (#440): port output differs from the pinned digest',
    )
  })

  it('reports a planted port change in the #300 row off-screen spill', () => {
    const t = tally([run({ ownScreenDiffers: false, portDigest: 'planted' })], name)
    expect(portLines(t.unexpected)).toContain(
      '$0DB49E (#300): port output differs from the pinned digest',
    )
  })

  it('absorbs a run whose port aggregate matches the pinned value', () => {
    const row: Known = {
      routine: LEAF,
      when: () => true,
      why: 1,
      expect: [1, 1, aggregate(['aa']), aggregate(['pp'])],
    }
    expect(tally([run({})], name, [row]).unexpected).toEqual([])
    expect(tally([run({ portDigest: 'qq' })], name, [row]).unexpected).toHaveLength(1)
  })

  it('emits the port aggregate as the fourth element, empty when nothing is absorbed', () => {
    const t = tally([], name)
    expect(t.disagreements.every(d => d.expect[3] === '')).toBe(true)
    expect(aggregate([])).toBe('')
  })

  it('flags a bogus port digest under every row (swept over all rows)', () => {
    const sizes = Array.from({ length: 256 }, (_v, i) => i)
    for (const k of KNOWN_DISAGREEMENTS) {
      const candidates = [0, 3, 15].flatMap(col =>
        [true, false].flatMap(fits =>
          sizes.map(size => run({ leaf: k.routine, top: k.routine, col, fits, size })),
        ),
      )
      const absorbed = candidates.find(r => k.when(r))
      expect(absorbed, `no synthetic run reaches $${k.routine.toString(16)}`).toBeDefined()
      const t = tally([{ ...absorbed!, portDigest: 'bogus' }], name)
      // The first row matching the run is the one that absorbs it (tally uses findIndex).
      const owner = KNOWN_DISAGREEMENTS.findIndex(o => o.routine === k.routine && o.when(absorbed!))
      const label = `$${k.routine.toString(16)} ${String(k.why)}`
      expect(t.disagreements[owner].expect[3], label).toBe(aggregate(['bogus']))
      expect(
        portLines(t.unexpected).some(l => l.startsWith(hex6(k.routine))),
        label,
      ).toBe(true)
    }
  })
})
