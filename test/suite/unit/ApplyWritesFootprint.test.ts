/**
 * The footprint of the interpreter write path (#1237 review, major 6): `applyWrites` records every
 * cell it stores when given a collector, and nothing when it is not.
 */
import { describe, it, expect } from 'vitest'
import { applyWrites } from '../../../src/rom/objectHandlers/interpret'
import { createGrid } from '../../../src/rom/ObjectExpander'
import type { Footprint } from '../../../src/rom/objectHandlers/cursor'

const BUF_LO = 0x7ec800
const BUF_HI = 0x7fc800

describe('applyWrites footprint', () => {
  const writes = [
    { addr: BUF_LO + 3, value: 0x41 }, // row 0, col 3, low byte
    { addr: BUF_HI + 3, value: 0x01 }, // the same cell, high byte
    { addr: BUF_LO + 16 + 2, value: 0x42 }, // row 1... one screen is 16 wide: offset 18 is row 1, col 2
  ]

  it('records each stored cell for its owner, in write order, with the whole tile after the write', () => {
    const grid = createGrid(1)
    const fp: Footprint = []
    applyWrites(grid, writes, null, 7, fp)
    expect(fp.map(f => f.owner)).toEqual([7, 7, 7])
    expect(fp.map(f => [f.row, f.col])).toEqual([[0, 3], [0, 3], [1, 2]]) // prettier-ignore
    expect(fp[1]!.tile).toBe(grid[0]![3])
    expect(fp[1]!.tile).toBe(0x141)
  })

  it('records nothing and draws the same grid without a collector', () => {
    const a = createGrid(1)
    const b = createGrid(1)
    applyWrites(a, writes, null, 7)
    applyWrites(b, writes, null, 7, [])
    expect(a).toEqual(b)
  })
})
