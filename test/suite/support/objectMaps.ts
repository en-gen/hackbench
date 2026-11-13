/**
 * Synthetic maps for the Object finder (#1237): stored pieces stamped in list order into a Map16 grid,
 * the owner grid and the per-piece footprint, the way the expander records them. No ROM, no ROM bytes.
 */
import type { Footprint, OwnerGrid, TileGrid } from '../../../src/rom/objectHandlers/cursor'
import type { FinderDefinition } from '../../../src/rom/objects/Recognize'

export const EMPTY = 0x25

/** A rectangular stored piece: `tile` is one tile, or a function of the cell for a piece with a top row. */
export interface Piece {
  x: number
  y: number
  w: number
  h: number
  tile: number | ((row: number, col: number) => number)
}

export interface SyntheticMap {
  grid: TileGrid
  owners: OwnerGrid
  footprint: Footprint
  tileset: number
}

/** Stamp the pieces in order: a later piece overwrites an earlier one, and both stay in the footprint. */
export function stamp(
  pieces: readonly Piece[],
  width: number,
  height: number,
  tileset = 0,
): SyntheticMap {
  // prettier-ignore
  const grid: TileGrid = Array.from({ length: height }, () => new Array<number>(width).fill(EMPTY))
  const owners: OwnerGrid = Array.from({ length: height }, () => new Array<number>(width).fill(-1))
  const footprint: Footprint = []
  pieces.forEach((p, owner) => {
    for (let r = p.y; r < p.y + p.h; r++)
      for (let c = p.x; c < p.x + p.w; c++) {
        const tile = typeof p.tile === 'number' ? p.tile : p.tile(r, c)
        grid[r]![c] = tile
        owners[r]![c] = owner
        footprint.push({ owner, row: r, col: c, tile })
      }
  })
  return { grid, owners, footprint, tileset }
}

/** A map drawn tile by tile with no stored pieces: only the visible path can find anything. */
export function visibleOnly(grid: TileGrid, tileset = 0): SyntheticMap {
  return {
    grid: grid.map(r => [...r]),
    owners: grid.map(r => r.map(() => -1)),
    footprint: [],
    tileset,
  }
}

export const def = (over: Partial<FinderDefinition> & Pick<FinderDefinition, 'edge' | 'fill'>): FinderDefinition => ({ id: 'd', name: 'Ground', tileset: 0, ...over }) // prettier-ignore
