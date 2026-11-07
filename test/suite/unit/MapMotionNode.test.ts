/**
 * The node side of Play on synthetic maps (no ROM): the refusals before the strip, the reply cache, and the
 * Layer 2 strip below the screen. The run itself is stubbed; MapMotion.test.ts proves it.
 */
import { describe, expect, it } from 'vitest'
import type { MotionResult } from '../../../src/rom/MapMotion'
import type { L2Inputs } from '../../../src/rom/model/L2Model'
import { mapMotion } from '../../../theia/extension/src/node/map-motion'
import { drawL2Strip, type MapInputs } from '../../../theia/extension/src/node/map-screen'
import { hGrid, inputs, px, sub, tile, vGrid } from '../support/mapInputs'

const solid = tile(1, [sub(1), sub(1), sub(1), sub(1)])
const prio = tile(1, [sub(1, 0, true), sub(1, 0, true), sub(1, 0, true), sub(1, 0, true)])
const blank = (rows: number, cols: number) =>
  Array.from({ length: rows }, () => new Array<number | null>(cols).fill(null))
const l2Of = (grid: (number | null)[][], t = solid, dy = 0): L2Inputs => ({
  kind: 'objects',
  grid,
  tiles: [undefined, t] as L2Inputs['tiles'],
  dy,
})
/** A map model with Layer 2 `l2` (or none), as the model cache would hand it out. */
const modelOf = (l2: L2Inputs | undefined, vertical = false) => {
  const base = inputs(vertical ? vGrid(2) : hGrid(2), vertical, 2)
  return {
    ok: true as const,
    inputs: { ...base, l2: l2 && { ok: true as const, l2 } } as MapInputs,
  }
}
const cacheOf = (built: ReturnType<typeof modelOf>) => ({ get: () => built })

const frames = (n: number, l1y = 192, l2y = 192) => ({
  l1x: new Array<number>(n).fill(0),
  l1y: new Array<number>(n).fill(l1y),
  l2x: new Array<number>(n).fill(0),
  l2y: Array.from({ length: n }, (_, i) => l2y - i),
})
const runOf = (n = 4, l1y = 192, l2y = 192): MotionResult => ({
  status: 'ok',
  kind: 'own-motion',
  frames: frames(n, l1y, l2y),
  shiftY: Array.from({ length: n }, (_, i) => i),
  cameraMoved: false,
  end: 'settled',
})
const bytes = () => new Uint8Array(4)
const reply = (built: ReturnType<typeof modelOf>, run: MotionResult, index = 1) =>
  mapMotion(cacheOf(built), bytes(), 'x.sfc', index, () => run)

describe('mapMotion refusals', () => {
  const l2 = l2Of(blank(32, 32), solid, 0)

  it('a run with Layer 2 at rest gives the offsets and a strip per screen', () => {
    const r = reply(modelOf(l2), runOf())
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.shiftY).toEqual([0, 1, 2, 3])
      expect(r.strips).toHaveLength(2)
      expect(r.stripRows).toBe(80)
    }
  })

  it('no routine is none, and the run is not asked for a model', () => {
    let asked = false
    const r = mapMotion({ get: () => ((asked = true), modelOf(l2)) }, bytes(), 'x', 1, () => ({
      status: 'none',
      kind: 'no-routine',
    }))
    expect(r).toEqual({ status: 'none' })
    expect(asked).toBe(false)
  })

  it("a refused run is unavailable with the core's reason", () => {
    const r = reply(modelOf(l2), {
      status: 'refused',
      kind: 'sideways',
      reason: 'Layer 2 sideways.',
    })
    expect(r).toEqual({ status: 'unavailable', reason: 'Layer 2 sideways.' })
  })

  it('a map with no Layer 2 has nothing to move', () => {
    const r = reply(modelOf(undefined), runOf())
    expect(r).toMatchObject({
      status: 'unavailable',
      reason: expect.stringMatching(/Layer 2 is not drawn/),
    })
  })

  it("a Layer 2 whose rest position is not the load state's is not shifted", () => {
    // At load Layer 2 sits 92 rows above the camera (192 - 100); the picture at rest says 0.
    const r = reply(modelOf(l2), runOf(4, 192, 100))
    expect(r).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/differs/) })
    // The same run is played when the picture at rest is that position.
    expect(reply(modelOf(l2Of(blank(32, 32), solid, 92)), runOf(4, 192, 100)).status).toBe('ok')
  })

  it('a vertical map is not played', () => {
    const v = l2Of(blank(32, 32))
    expect(reply(modelOf(v, true), runOf())).toMatchObject({
      status: 'unavailable',
      reason: expect.stringMatching(/horizontal/),
    })
  })

  it('replies are kept per map of the same bytes, and a refusal of one is not the other', () => {
    let calls = 0
    const b = bytes()
    const cache = cacheOf(modelOf(l2))
    const runner = (_: unknown, index: number): MotionResult => (
      calls++,
      runOf(index === 1 ? 3 : 5)
    )
    const a = mapMotion(cache, b, 'x', 1, runner)
    const c = mapMotion(cache, b, 'x', 2, runner)
    expect(a.status === 'ok' && a.shiftY.length).toBe(3)
    expect(c.status === 'ok' && c.shiftY.length).toBe(5)
    expect(mapMotion(cache, b, 'x', 1, runner)).toBe(a)
    expect(calls).toBe(2)
    // New bytes (an edit) run again.
    mapMotion(cache, bytes(), 'x', 1, runner)
    expect(calls).toBe(3)
  })
})

describe('mapMotion strips on the wire', () => {
  it('a screen with nothing below it sends null, one with ink sends it in the plane it belongs to', () => {
    const grid = blank(32, 32)
    grid[28]![16] = 1 // screen 1 only, below the screen
    const plain = reply(modelOf(l2Of(grid, solid)), runOf())
    const high = reply(modelOf(l2Of(grid, prio)), runOf())
    if (plain.status !== 'ok' || high.status !== 'ok') throw new Error('expected ok')
    expect(plain.strips[0]).toBeNull()
    expect(plain.strips[1]!.high).toBeNull()
    expect(plain.strips[1]!.low).toEqual(expect.any(String))
    expect(high.strips[0]).toBeNull()
    expect(high.strips[1]!.low).toBeNull()
    expect(high.strips[1]!.high).toEqual(expect.any(String))
  })
})

describe('drawL2Strip', () => {
  const model = inputs(hGrid(2), false, 2)
  const W = 256

  it('holds the 80 rows below the 432 px screen, and a tile there lands at its own row', () => {
    const grid = blank(32, 32)
    grid[28]![0] = 1 // y 448..463 of the 512 px plane = strip rows 16..31
    const s = drawL2Strip(model, l2Of(grid), 0)!
    expect(s.rows).toBe(80)
    expect(s.planes.l2Low).toHaveLength(W * 80 * 4)
    expect(px(s.planes.l2Low!, W, 3, 15)[3]).toBe(0)
    expect(px(s.planes.l2Low!, W, 3, 16)[3]).toBe(255)
    expect(px(s.planes.l2Low!, W, 3, 31)[3]).toBe(255)
    expect(px(s.planes.l2Low!, W, 3, 32)[3]).toBe(0)
    expect(s.planes.l2High).toBeNull()
  })

  it('keeps only what is below the screen: a tile on the screen leaves no strip', () => {
    const grid = blank(32, 32)
    grid[0]![0] = 1
    grid[26]![0] = 1 // the last screen row, 416..431
    const s = drawL2Strip(model, l2Of(grid), 0)!
    expect(s.planes).toEqual({ l2Low: null, l2High: null })
  })

  it('sends a priority tile in the high plane and a plain one in the low plane', () => {
    const grid = blank(32, 32)
    grid[28]![0] = 1
    const high = drawL2Strip(model, l2Of(grid, prio), 0)!
    expect([high.planes.l2Low, high.planes.l2High === null]).toEqual([null, false])
    const low = drawL2Strip(model, l2Of(grid, solid), 0)!
    expect([low.planes.l2Low === null, low.planes.l2High]).toEqual([false, null])
  })

  it('draws the screen asked for, from the grid columns of that screen', () => {
    const grid = blank(32, 32)
    grid[28]![16] = 1 // screen 1, column 0
    expect(drawL2Strip(model, l2Of(grid), 0)!.planes.l2Low).toBeNull()
    expect(drawL2Strip(model, l2Of(grid), 1)!.planes.l2Low).not.toBeNull()
  })

  it('wraps rows shifted past the period into the strip', () => {
    const grid = blank(32, 32)
    grid[0]![0] = 1
    // Row 0 shifted up 100 lands at 412 of 512, then another row 0 shifted down by 500 at 500..515 wraps.
    const s = drawL2Strip(model, l2Of(grid, solid, 500), 0)!
    expect(px(s.planes.l2Low!, W, 3, 500 - 432)[3]).toBe(255)
  })

  it('is not drawn for a vertical map', () => {
    expect(drawL2Strip(inputs(vGrid(2), true, 2), l2Of(blank(32, 32)), 0)).toBeNull()
    const image: L2Inputs = { ...l2Of(blank(32, 32)), kind: 'image' }
    expect(drawL2Strip(inputs(vGrid(2), true, 2), image, 0)).toBeNull()
  })
})
