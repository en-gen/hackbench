import { describe, expect, it } from 'vitest'
import { createGrid } from '../../../src/rom/ObjectExpander'
import {
  compareRun,
  hex6,
  portDigestOf,
  recordedGrid,
  sameScreen,
  sameWritten,
  type DiffRun,
} from '../support/l1Differential'
import {
  KNOWN_DISAGREEMENTS,
  KNOWN_REFUSALS,
  aggregate,
  tally,
  type Known,
  type KnownRefusal,
} from '../support/l1AllowList'

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
  writtenDiffers: false,
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

  // One row whose pinned counts and interpreter digest match the run, so only the
  // port digest can trigger the line.
  const single = (over: Partial<Known>): Known => ({
    routine: LEAF,
    when: () => true,
    why: 440,
    expect: [1, 1, aggregate(['aa']), aggregate(['pp'])],
    ...over,
  })
  const LINE = '$0DB49E (#440): port output differs from the pinned digest'

  it('reports a planted port change under a non-#300 row', () => {
    const row = single({})
    expect(tally([run({})], name, [row], []).unexpected).toEqual([])
    expect(portLines(tally([run({ portDigest: 'planted' })], name, [row], []).unexpected)).toEqual([
      LINE,
    ])
  })

  it('reports a planted port change in the #300 row off-screen spill', () => {
    const row = single({ why: 300, offScreenOnly: true })
    const t = tally([run({ ownScreenDiffers: false, portDigest: 'planted' })], name, [row], [])
    expect(t.unexpected).toEqual([LINE.replace('#440', '#300')])
  })

  it('absorbs a run whose port aggregate matches the pinned value', () => {
    const row: Known = {
      routine: LEAF,
      when: () => true,
      why: 1,
      expect: [1, 1, aggregate(['aa']), aggregate(['pp'])],
    }
    expect(tally([run({})], name, [row], []).unexpected).toEqual([])
    expect(tally([run({ portDigest: 'qq' })], name, [row], []).unexpected).toHaveLength(1)
  })

  it('emits the port aggregate as the fourth element, empty when nothing is absorbed', () => {
    const t = tally([], name)
    expect(t.disagreements.every(d => d.expect[3] === '')).toBe(true)
    expect(aggregate([])).toBe('')
  })

  it('flags a bogus port digest under every disagreement row (swept over all rows)', () => {
    const sizes = Array.from({ length: 256 }, (_v, i) => i)
    for (const k of KNOWN_DISAGREEMENTS) {
      const candidates = [0, 3, 15].flatMap(col =>
        [true, false].flatMap(fits =>
          sizes.map(size =>
            run({
              leaf: k.routine,
              top: k.routine,
              col,
              fits,
              size,
              ...(k.emptyTilesOnly && { differs: false, writtenDiffers: true }),
            }),
          ),
        ),
      )
      const absorbed = candidates.find(r => k.when(r))
      expect(absorbed, `no synthetic run reaches $${k.routine.toString(16)}`).toBeDefined()
      const t = tally([{ ...absorbed!, portDigest: 'bogus' }], name)
      // The first row matching the run is the one that absorbs it (tally uses findIndex).
      const owner = KNOWN_DISAGREEMENTS.findIndex(
        o =>
          o.routine === k.routine && !o.emptyTilesOnly === !k.emptyTilesOnly && o.when(absorbed!),
      )
      const label = `$${k.routine.toString(16)} ${String(k.why)}`
      expect(t.disagreements[owner].expect[3], label).toBe(aggregate(['bogus']))
      expect(
        portLines(t.unexpected).some(l => l.startsWith(hex6(k.routine))),
        label,
      ).toBe(true)
    }
  })
})

describe('recordedGrid and portDigestOf (written cells, $25 included, #759)', () => {
  const at = (row: number, col: number) => row * 0x10000 + col
  const base = () => {
    const g = recordedGrid(8)
    g.grid[3][FIRST + 2] = 0x41
    return g
  }

  it('records a $25 write onto a $25 cell, which the grid itself cannot show', () => {
    const g = recordedGrid(8)
    g.grid[3][FIRST + 2] = 0x25
    expect(g.raw[3][FIRST + 2]).toBe(0x25)
    expect(g.written.get(at(3, FIRST + 2))).toBe(0x25)
    expect(g.written.size).toBe(1)
  })
  it('keeps the last value written to a cell, and records appended cells', () => {
    const g = recordedGrid(8)
    g.grid[0][5] = 0x41
    g.grid[0][5] = 0x42
    g.grid[0][g.grid[0].length] = 0x43 // grows the row, like writeTile padding past the end
    expect([...g.written.values()]).toEqual([0x42, 0x43])
  })
  it('does not change reads: the proxied rows read like the raw ones', () => {
    const g = base()
    expect(g.grid[3][FIRST + 2]).toBe(0x41)
    expect(g.grid[3][0]).toBe(0x25)
    expect(g.grid[3].length).toBe(g.raw[3].length)
    expect(g.grid.map(r => [...r])).toEqual(g.raw.map(r => [...r]))
    expect(g.written.size).toBe(1) // reads recorded nothing
  })
  it('is stable for identical writes', () => {
    expect(portDigestOf(base().written)).toBe(portDigestOf(base().written))
    expect(portDigestOf(base().written)).toMatch(/^[0-9a-f]{12}$/)
  })
  it('does not depend on the order cells were written in', () => {
    const [a, b] = [recordedGrid(8), recordedGrid(8)]
    a.grid[1][1] = 0x41
    a.grid[2][2] = 0x42
    b.grid[2][2] = 0x42
    b.grid[1][1] = 0x41
    expect(portDigestOf(a.written)).toBe(portDigestOf(b.written))
  })
  it('changes when a $25 write is added (and so back when it is removed)', () => {
    const withEmpty = base()
    withEmpty.grid[4][FIRST] = 0x25
    expect(portDigestOf(withEmpty.written)).not.toBe(portDigestOf(base().written))
    withEmpty.written.delete(at(4, FIRST))
    expect(portDigestOf(withEmpty.written)).toBe(portDigestOf(base().written))
  })
  it('changes when a cell changes value, moves, or spills onto screen 6', () => {
    const v = base()
    v.grid[3][FIRST + 2] = 0x42
    const m = recordedGrid(8)
    m.grid[3][FIRST + 3] = 0x41
    const spill = base()
    spill.grid[10][(SCREEN + 1) * 16 + 1] = 0x41
    for (const g of [v, m, spill])
      expect(portDigestOf(g.written)).not.toBe(portDigestOf(base().written))
  })
  it('sameWritten sees a $25-only difference that compareRun cannot', () => {
    const [a, b] = [base(), base()]
    expect(sameWritten(a.written, b.written)).toBe(true)
    b.grid[4][FIRST] = 0x25
    expect(sameWritten(a.written, b.written)).toBe(false)
    expect(compareRun(a.raw, b.raw)).toEqual({ differs: false, ownScreenDiffers: false })
  })
})

describe('tally pins the port output under refusal entries (#759)', () => {
  const REASON = 'write outside the tile buffer'
  const TOP = 0x0db604
  const refusal = (over: Partial<DiffRun> = {}) =>
    run({
      leaf: 0,
      top: TOP,
      refusal: `${REASON} $7ec800`,
      differs: null,
      ownScreenDiffers: null,
      writtenDiffers: null,
      portDigest: 'pp',
      ...over,
    })
  const single: KnownRefusal[] = [{ reason: REASON, top: TOP, count: 1, port: aggregate(['pp']) }]
  const portLines = (u: string[]) => u.filter(l => l.includes('port output differs'))

  it('accepts a refusal whose port digest matches the pin', () => {
    expect(tally([refusal()], name, [], single).unexpected).toEqual([])
  })
  it('reports a planted port change under the $0DB604 refusal entry', () => {
    const t = tally([refusal({ portDigest: 'planted' })], name, [], single)
    expect(portLines(t.unexpected)).toEqual([
      `refusal ${hex6(TOP)} "${REASON}": port output differs from the pinned digest`,
    ])
    expect(t.refusals[0].port).toBe(aggregate(['planted']))
  })
  it('reports a refused case that has no port digest', () => {
    const t = tally([refusal({ portDigest: null })], name, [], single)
    expect(portLines(t.unexpected)).toHaveLength(1)
  })
  it('reports a bogus port digest under every refusal entry (swept over all entries)', () => {
    for (const k of KNOWN_REFUSALS) {
      const r = refusal({ top: k.top, refusal: `${k.reason} x`, portDigest: 'bogus' })
      const t = tally([r], name)
      const label = `${hex6(k.top)} ${k.reason}`
      expect(
        portLines(t.unexpected).some(l => l.startsWith(`refusal ${hex6(k.top)} "${k.reason}"`)),
        label,
      ).toBe(true)
    }
  })
  it('pins a port digest on every refusal entry', () => {
    expect(KNOWN_REFUSALS.every(k => /^[0-9a-f]{10}$/.test(k.port))).toBe(true)
  })
})

describe('tally and writes of the empty tile $25 (#759)', () => {
  const emptyOnly = (over: Partial<Known> = {}): Known => ({
    routine: LEAF,
    when: () => true,
    why: 'test',
    emptyTilesOnly: true,
    expect: [1, 1, aggregate(['aa']), aggregate(['pp'])],
    ...over,
  })
  const emptyRun = (over: Partial<DiffRun> = {}) =>
    run({ differs: false, writtenDiffers: true, ...over })
  const LINE = 'run leaf $0DB49E: empty-tile writes differ'

  it('reports an agreeing run whose written cells differ when no row absorbs it', () => {
    expect(tally([emptyRun()], name, [], []).unexpected).toEqual([LINE])
  })
  it('does not report an agreeing run whose written cells match', () => {
    expect(tally([run({ differs: false })], name, [], []).unexpected).toEqual([])
  })
  it('absorbs it under an emptyTilesOnly row of the same leaf, and pins both digests', () => {
    const t = tally([emptyRun()], name, [emptyOnly()], [])
    expect(t.unexpected).toEqual([])
    expect(t.disagreements[0].expect).toEqual([1, 1, aggregate(['aa']), aggregate(['pp'])])
  })
  it('reports a planted port change under that row', () => {
    const t = tally([emptyRun({ portDigest: 'planted' })], name, [emptyOnly()], [])
    expect(t.unexpected).toHaveLength(1)
    expect(t.unexpected[0]).toContain('port output differs')
  })
  it('does not absorb it under a row for another leaf or without emptyTilesOnly', () => {
    const other = tally([emptyRun()], name, [emptyOnly({ routine: 0x0daaaa })], [])
    expect(other.unexpected).toContain(LINE)
    expect(other.disagreements[0].expect[0]).toBe(0)
    const plain = emptyOnly({ emptyTilesOnly: false })
    expect(tally([emptyRun()], name, [plain], []).unexpected).toContain(LINE)
  })
  it('an emptyTilesOnly row never absorbs a case whose grids differ', () => {
    const t = tally([run({ differs: true })], name, [emptyOnly()], [])
    expect(t.unexpected).toContain(`run leaf ${hex6(LEAF)}`)
    expect(t.disagreements[0].expect[0]).toBe(0)
  })
  it('the real allow-list has emptyTilesOnly rows only for the three measured extended leaves', () => {
    expect(KNOWN_DISAGREEMENTS.filter(k => k.emptyTilesOnly).map(k => k.routine)).toEqual([
      0x0da71b, 0x0da760, 0x0dc2e9,
    ])
  })
})
