import { describe, it, expect } from 'vitest'
import { expandLevel, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { createGrid, TileCursor } from '../../../src/rom/TileCursor'
import { LevelObject } from '../../../src/rom/LevelParser'

function makeObj(objectType: number, param: number, x = 0, y = 14, screen = 0): LevelObject {
  return { type: objectType === 0 ? 'extended' : 'standard', screen, x, y, objectType, param, raw: [0, 0, param] }
}

describe('createGrid', () => {
  it('fills with TILE_EMPTY ($25)', () => {
    const grid = createGrid(1)
    expect(grid.length).toBe(27)
    expect(grid[0].length).toBe(16)
    expect(grid[0][0]).toBe(0x25)
  })
})

describe('TileCursor', () => {
  it('writes tile at correct position', () => {
    const grid = createGrid(1)
    const c = new TileCursor(grid)
    c.setPosition(0, 14, 5)
    c.writeTile(0x42)
    expect(grid[14][5]).toBe(0x42)
  })

  it('advances column correctly', () => {
    const grid = createGrid(1)
    const c = new TileCursor(grid)
    c.setPosition(0, 10, 3)
    c.writeTileAdvanceCol(0xAA)
    c.writeTileAdvanceCol(0xBB)
    expect(grid[10][3]).toBe(0xAA)
    expect(grid[10][4]).toBe(0xBB)
  })

  it('advances row and restores column', () => {
    const grid = createGrid(1)
    const c = new TileCursor(grid)
    c.setPosition(0, 10, 2)
    c.saveCol()
    c.writeTileAdvanceCol(0x11)
    c.writeTileAdvanceCol(0x12)
    c.restoreCol()
    c.advanceRow()
    c.writeTileAdvanceCol(0x21)
    expect(grid[10][2]).toBe(0x11)
    expect(grid[10][3]).toBe(0x12)
    expect(grid[11][2]).toBe(0x21)
  })

  it('handles page 1 tiles', () => {
    const grid = createGrid(1)
    const c = new TileCursor(grid)
    c.setPosition(0, 5, 0)
    c.setPage1()
    c.writeTile(0x53)
    expect(grid[5][0]).toBe(0x153)
  })
})

describe('expandLevel', () => {
  it('produces grid filled with $25', () => {
    const grid = expandLevel([], 1)
    expect(grid[0][0]).toBe(0x25)
    expect(grid[26][15]).toBe(0x25)
  })
})
