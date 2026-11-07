/**
 * #1034: Layer 1 tiles written past the map's edge land where the game's linear Map16 buffer puts
 * them, or the object is marked. Synthetic: made-up grids and a zeroed ROM, no vanilla bytes.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  OFF_BUFFER_REASON,
  OWNER_NONE,
  clearPageKeepLow,
  makeCursor,
  writeTile,
  type Cursor,
} from '../../../src/rom/objectHandlers/cursor'
import { applyWrites } from '../../../src/rom/objectHandlers/interpret'
import { refusedCellsOf } from '../../../src/rom/model/RefusedCells'
import {
  beyondResult,
  screenResult,
  type MapInputs,
} from '../../../theia/extension/src/node/map-screen'
import { hGrid, inputs, px, vGrid } from '../support/mapInputs'

const ROM = new RomFile('m.smc', Buffer.alloc(0x1000, 0))
const BUF_LO = 0x7ec800
const noOwners = (g: number[][]) => g.map(r => new Array<number>(r.length).fill(OWNER_NONE))

/** A cursor at (row, col) on `grid`, as object 7, collecting refusals. */
function at(grid: number[][], row: number, col: number, vertical = false): Cursor {
  const cur = makeCursor(grid, ROM, 0, col, row, 0, 0, noOwners(grid), 7, undefined, vertical)
  cur.refusals = []
  return cur
}

describe('a write past the bottom row of a horizontal map', () => {
  it('lands on the next screen at the same column, keeping 27 rows', () => {
    const grid = hGrid(2)
    const cur = at(grid, 27, 5)
    writeTile(cur, 0x41)
    expect(grid[0]![16 + 5]).toBe(0x41)
    cur.row = 29
    writeTile(cur, 0x42)
    expect(grid[2]![16 + 5]).toBe(0x42)
    expect(grid).toHaveLength(27)
    expect(cur.owners![0]![21]).toBe(7)
    expect(cur.refusals).toEqual([])
  })

  it('on the last screen lands one past it, where a column write would also land', () => {
    const grid = hGrid(1)
    writeTile(at(grid, 27, 3), 0x41)
    expect(grid[0]![19]).toBe(0x41)
    const same = hGrid(1)
    writeTile(at(same, 0, 19), 0x41)
    expect(same).toEqual(grid)
  })

  it('agrees with the interpreter path on the cell, the tile and the owner', () => {
    for (const [row, col] of [
      [27, 0],
      [28, 15],
      [26, 15],
      [54, 3],
      [30, 37],
      [0, 17],
    ] as const) {
      const a = hGrid(4)
      const cur = at(a, row, col)
      writeTile(cur, 0x41)
      const b = hGrid(4)
      const owners = noOwners(b)
      const addr = BUF_LO + (col >> 4) * 0x1b0 + row * 16 + (col & 15)
      expect(applyWrites(b, [{ addr, value: 0x41 }], owners, 7)).toBe(0)
      expect(b, `${row},${col}`).toEqual(a)
      expect(owners, `${row},${col}`).toEqual(cur.owners)
    }
  })
})

describe('a write past the bottom row of a vertical map', () => {
  it('grows the grid and the owners by whole rows, 32 wide, and draws there', () => {
    const grid = vGrid(2)
    const cur = at(grid, 35, 4, true)
    writeTile(cur, 0x41)
    expect(grid).toHaveLength(36)
    expect(grid.every(r => r.length === 32)).toBe(true)
    expect(grid[35]![4]).toBe(0x41)
    expect(cur.owners).toHaveLength(36)
    expect(cur.owners![35]![4]).toBe(7)
    expect(cur.owners![34]![4]).toBe(OWNER_NONE)
  })
})

describe('a write outside the buffer marks its object, once, in plain words', () => {
  const outside: [string, number, number, boolean][] = [
    ['past the 32-screen end', 0, 0x200, false],
    ['before the buffer start', 0, -1, false],
    ['above the first row of screen 0', -1, 0, false],
    ['below the last vertical screen', 512, 0, true],
    ['left of a vertical map', 0, -1, true],
  ]
  it.each(outside)('%s', (_why, row, col, vertical) => {
    const grid = vertical ? vGrid(2) : hGrid(2)
    const before = JSON.stringify(grid)
    const cur = at(grid, row, col, vertical)
    writeTile(cur, 0x41)
    clearPageKeepLow(cur)
    writeTile(cur, 0x41)
    expect(JSON.stringify(grid)).toBe(before)
    expect(cur.refusals).toEqual([{ objectIndex: 7, handler: 0, reason: OFF_BUFFER_REASON }])
    const obj = { type: 'standard', objectNumber: 1, x: 1, y: 2 }
    const [cell] = refusedCellsOf(cur.refusals!, [...Array(7).fill(obj), obj] as never)
    expect(cell!.reasons).toEqual([OFF_BUFFER_REASON])
    expect(OFF_BUFFER_REASON).toMatch(/outside the level/)
  })

  it('an interpreter write outside the buffer is counted, not lost', () => {
    const grid = hGrid(1)
    const writes = [
      { addr: BUF_LO - 1, value: 1 },
      { addr: BUF_LO + 32 * 0x1b0, value: 1 },
      { addr: BUF_LO, value: 2 },
    ]
    expect(applyWrites(grid, writes)).toBe(2)
    expect(grid[0]![0]).toBe(2)
  })
})

describe('Layer 1 cells past the last screen reach the off-map band', () => {
  const map = (grid: number[][], vertical: boolean, screens: number): MapInputs =>
    inputs(grid, vertical, screens) as MapInputs
  const ok = (r: ReturnType<typeof beyondResult>) => {
    if (r.status !== 'ok') throw new Error(r.status)
    return r
  }
  const plane = (b64: string | null) => new Uint8ClampedArray(Buffer.from(b64 ?? '', 'base64'))

  it('a wrapped horizontal write draws on the first screen past the map, at its cell', () => {
    const grid = hGrid(1)
    writeTile(at(grid, 27, 3), 1) // made-up tile 1: column 19 of the strip, row 0
    const r = ok(beyondResult(map(grid, false, 1), 1))
    expect(r.planes.l1Low).not.toBeNull()
    expect(px(plane(r.planes.l1Low), 256, 3 * 16 + 1, 1)[3]).toBeGreaterThan(0)
    expect(px(plane(r.planes.l1Low), 256, 4 * 16 + 1, 1)[3]).toBe(0)
    expect(ok(screenResult(map(grid, false, 1), 0)).planes.l1Low).toBeNull()
  })

  it('a vertical write past the last screen draws on the screen below the map', () => {
    const grid = vGrid(2)
    writeTile(at(grid, 33, 4, true), 1)
    const r = ok(beyondResult(map(grid, true, 2), 2))
    expect(r.planes.l1Low).not.toBeNull()
    expect(px(plane(r.planes.l1Low), 512, 4 * 16 + 1, 16 + 1)[3]).toBeGreaterThan(0)
  })

  it('a screen past the map where the grid holds nothing stays empty', () => {
    expect(ok(beyondResult(map(hGrid(2), false, 2), 2)).planes.l1Low).toBeNull()
  })
})
