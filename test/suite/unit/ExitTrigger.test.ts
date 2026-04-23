import { describe, it, expect } from 'vitest'
import { screenHasExitTrigger } from '../../../src/rom/SmwRom'
import { TILE_EMPTY } from '../../../src/rom/ObjectExpander'

// Tile ID constants matching the sets defined in SmwRom.ts
const PIPE_TILE_P0 = 0x0A      // standard pipe body/top (page 0)
const PIPE_TILE_P0_FUSED = 0x19 // fused adjacent-pipe corner (page 0)
const PIPE_TILE_P1 = 0x196      // pipe lip tile (page 1 variant, $180-$1FF range)
const DOOR_TILE = 0x7A          // ghost-house door tile (page 0, ext $4D)
const SOLID_TILE = 0x30         // arbitrary solid non-exit tile

function makeGrid(rows: number, cols: number, fill = TILE_EMPTY): number[][] {
  return Array.from({ length: rows }, () => new Array(cols).fill(fill))
}

function solidFloor(grid: number[][], cols: number): void {
  const lastRow = grid.length - 1
  for (let c = 0; c < cols; c++) grid[lastRow][c] = SOLID_TILE
}

describe('screenHasExitTrigger', () => {
  it('returns false for a solid-floor screen with no pipes, doors, or pits', () => {
    const grid = makeGrid(27, 16, TILE_EMPTY)
    solidFloor(grid, 16)
    expect(screenHasExitTrigger(grid, 0, false)).toBe(false)
  })

  it('returns true for a screen containing a page-0 pipe tile', () => {
    const grid = makeGrid(27, 16, TILE_EMPTY)
    solidFloor(grid, 16)
    grid[10][5] = PIPE_TILE_P0
    expect(screenHasExitTrigger(grid, 0, false)).toBe(true)
  })

  it('returns true for a screen containing a fused-pipe corner tile', () => {
    const grid = makeGrid(27, 16, TILE_EMPTY)
    solidFloor(grid, 16)
    grid[8][3] = PIPE_TILE_P0_FUSED
    expect(screenHasExitTrigger(grid, 0, false)).toBe(true)
  })

  it('returns true for a screen containing a page-1 pipe tile', () => {
    const grid = makeGrid(27, 16, TILE_EMPTY)
    solidFloor(grid, 16)
    grid[5][7] = PIPE_TILE_P1
    expect(screenHasExitTrigger(grid, 0, false)).toBe(true)
  })

  it('returns true for a screen containing a ghost-house door tile', () => {
    const grid = makeGrid(27, 16, TILE_EMPTY)
    solidFloor(grid, 16)
    grid[12][8] = DOOR_TILE
    expect(screenHasExitTrigger(grid, 0, false)).toBe(true)
  })

  it('returns true for a screen with at least one open-bottom column (pit)', () => {
    const grid = makeGrid(27, 16, TILE_EMPTY)
    solidFloor(grid, 16)
    grid[26][7] = TILE_EMPTY   // punch a hole in the floor
    expect(screenHasExitTrigger(grid, 0, false)).toBe(true)
  })

  it('checks the correct screen in a multi-screen grid (column offset)', () => {
    // 3-screen grid: pipe only on screen 1 (cols 16-31)
    const grid = makeGrid(27, 48, TILE_EMPTY)
    solidFloor(grid, 48)
    grid[10][20] = PIPE_TILE_P0   // col 20 = screen 1

    expect(screenHasExitTrigger(grid, 0, false)).toBe(false)
    expect(screenHasExitTrigger(grid, 1, false)).toBe(true)
    expect(screenHasExitTrigger(grid, 2, false)).toBe(false)
  })

  it('handles vertical levels (row-based screen partitioning)', () => {
    // Vertical level: 32 cols × 2 screens × 16 rows = 32 rows total.
    // Pipe on screen 1 (rows 16-31).
    const grid = makeGrid(32, 32, TILE_EMPTY)
    // No pit: fill last row of each screen with solid
    for (let c = 0; c < 32; c++) {
      grid[15][c] = SOLID_TILE  // screen 0 last row
      grid[31][c] = SOLID_TILE  // screen 1 last row
    }
    grid[20][5] = PIPE_TILE_P0   // row 20 = screen 1 (rows 16-31)

    expect(screenHasExitTrigger(grid, 0, true)).toBe(false)
    expect(screenHasExitTrigger(grid, 1, true)).toBe(true)
  })
})
