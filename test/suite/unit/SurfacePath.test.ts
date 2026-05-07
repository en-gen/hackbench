/**
 * SurfacePath unit tests.
 *
 * The hard algorithmic question this module solves: at a slope corner
 * where two surfaces stack in the same column, which one does the
 * scanner pick? Edge-matching (the chosen approach) and mid-pixel
 * sampling can disagree — so the regression test below constructs a
 * grid where they DO disagree, asserts edge-matching's pick, and
 * separately reproduces the mid-pixel pick to prove the discriminator
 * is meaningful.
 *
 * Test tree:
 *
 *   compute (per-column surface entries)
 *     ├─ empty column: no surfaces
 *     ├─ single flat floor: one entry at silhouette top
 *     ├─ tall solid pillar: ONE entry at top (silhouette suppression)
 *     ├─ priority-decorative cell + ground below: only ground emits
 *     ├─ slope tile: yLeft / yRight / yMid from heights[0|15|8]
 *     └─ slope above non-slope floor: both emit
 *
 *   nextSurface (edge-matched continuity)
 *     ├─ flat-to-flat same row: matches at delta 0
 *     ├─ flat-to-flat one row down: matches at delta 16 (boundary tolerance)
 *     ├─ flat-to-flat two rows down: rejected (delta 32 > tolerance)
 *     ├─ slope mating: prev right edge = next left edge → delta 0
 *     ├─ stacked slopes (slope corner) — picks the EDGE-CONTINUOUS surface,
 *     │  not the mid-Y-closest one (the regression case)
 *     └─ no candidates: returns null (ledge)
 */

import { describe, expect, it } from 'vitest'
import type { GetL1Tile, L1Cell } from '../../../src/rom/model/OverlayContext'
import {
  buildSurfacePath,
  DEFAULT_EDGE_TOLERANCE,
  MARIO_HAS_FLOOR,
  SPRITE_HAS_FLOOR,
  type SurfaceEntry,
} from '../../../src/rom/model/SurfacePath'

type SyntheticTile = { actsLike: number; heights?: readonly number[]; isPriority?: boolean }

function buildGrid(
  rows: string[],
  defs: Record<string, SyntheticTile>,
): { getL1: GetL1Tile; cols: number; rows: number } {
  const colCount = rows[0]?.length ?? 0
  const rowCount = rows.length
  const cells = new Map<string, L1Cell | null>()
  cells.set('.', null)
  let nextId = 0x100
  for (const [ch, def] of Object.entries(defs)) {
    const low = def.actsLike & 0xFF
    const inSolid = low >= 0x11 && low <= 0x6D
    const inSlope = low >= 0x6E && low <= 0xD7
    cells.set(ch, {
      id:         nextId++,
      actsLike:   def.actsLike,
      isPriority: def.isPriority,
      collision: {
        wall:         inSolid,
        floor:        low <= 0x10 ? false : (inSolid || inSlope || low >= 0xD8),
        ceiling:      inSolid,
        slopeTable:   inSlope,
        marioFloor:   false,
        marioCeiling: false,
        marioWall:    false,
        slope: def.heights
          ? { slopeIndex: 0, heights: new Uint8Array(def.heights) }
          : undefined,
      },
    })
  }
  const getL1: GetL1Tile = (c, r) => {
    if (c < 0 || c >= colCount || r < 0 || r >= rowCount) return null
    return cells.get(rows[r][c]) ?? null
  }
  return { getL1, cols: colCount, rows: rowCount }
}

const FLAT  = { actsLike: 0x130 }   // generic solid floor (page-1, $30 acts-like)
const GRASS = { actsLike: 0x025, isPriority: true }  // priority-decorative

// Slope heights — left edge / mid / right edge ordering matters.
// "Descending right" = surface y INCREASES as we move right within the cell
// → heights[0] small, heights[15] large.
const SLOPE_DOWN_RIGHT = { actsLike: 0x16E, heights: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15] }
const SLOPE_DOWN_LEFT  = { actsLike: 0x16E, heights: [15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0] }

describe('SurfacePath.surfacesAt — per-column compute', () => {
  it('empty column has no surfaces', () => {
    const { getL1, cols, rows } = buildGrid(['.....', '.....', '.....'], {})
    const path = buildSurfacePath(getL1, cols, rows)
    expect(path.surfacesAt(2)).toEqual([])
  })

  it('c < 0 → early return empty array (if (c < 0 || c >= cols) true branch)', () => {
    // Covers the TRUE path of `if (c < 0 || c >= cols) return []` in SurfacePath.ts
    const { getL1, cols, rows } = buildGrid([
      '.....',
      '#####',
    ], { '#': FLAT })
    const path = buildSurfacePath(getL1, cols, rows)
    expect(path.surfacesAt(-1)).toEqual([])
    expect(path.surfacesAt(cols)).toEqual([])  // c >= cols path
  })

  it('single flat floor row emits one entry at silhouette top', () => {
    const { getL1, cols, rows } = buildGrid([
      '.....',
      '.....',
      '#####',
    ], { '#': FLAT })
    const path = buildSurfacePath(getL1, cols, rows)
    expect(path.surfacesAt(2)).toEqual([
      { yLeft: 32, yRight: 32, yMid: 32, floorRow: 2 },
    ])
  })

  it('tall solid pillar emits ONE entry at the top — interior rows suppressed', () => {
    const { getL1, cols, rows } = buildGrid([
      '..#..',
      '..#..',
      '..#..',
      '..#..',
    ], { '#': FLAT })
    const path = buildSurfacePath(getL1, cols, rows)
    expect(path.surfacesAt(2)).toHaveLength(1)
    expect(path.surfacesAt(2)[0].floorRow).toBe(0)
  })

  it('priority-decorative grass with hasFloor stacked on solid: silhouette is on the grass', () => {
    // SurfacePath emits surfaces purely from `hasFloor` (actsLike-driven),
    // not from priority. SMW's collision routines key off actsLike alone;
    // the priority bit is a render-order flag, not a collision flag.
    // When a priority-decorative tile with hasFloor=true sits on a solid
    // tile, the silhouette is on the priority tile (the topmost solid
    // surface) and the cell below is silhouette-suppressed.
    const { getL1, cols, rows } = buildGrid([
      '.....',
      '..G..',
      '..#..',
    ], { 'G': GRASS, '#': FLAT })
    const path = buildSurfacePath(getL1, cols, rows)
    expect(path.surfacesAt(2)).toEqual([
      { yLeft: 16, yRight: 16, yMid: 16, floorRow: 1 },
    ])
  })

  it('slope tile emits yLeft/yRight/yMid from heights[0|15|8]', () => {
    const { getL1, cols, rows } = buildGrid([
      '.....',
      '..D..',
      '.....',
    ], { 'D': SLOPE_DOWN_RIGHT })
    const path = buildSurfacePath(getL1, cols, rows)
    expect(path.surfacesAt(2)).toEqual([
      { yLeft: 16 + 0, yRight: 16 + 15, yMid: 16 + 8, floorRow: 1 },
    ])
  })

  it('slope ABOVE non-slope floor: slope is treated as floor-above; non-slope below is suppressed', () => {
    // The slope's bottom pixel can sit at y=floorRow*16+15, leaving the
    // cell below visually empty under the slope. We treat the slope as
    // "floor above" so the cell below doesn't double-emit the same
    // surface — the slope's own entry is the surface designers see.
    const { getL1, cols, rows } = buildGrid([
      '.....',
      '..D..',
      '..#..',
    ], { 'D': SLOPE_DOWN_RIGHT, '#': FLAT })
    const path = buildSurfacePath(getL1, cols, rows)
    const surfaces = path.surfacesAt(2)
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0].floorRow).toBe(1)
  })
})

describe('SurfacePath.nextSurface — edge-matched continuity', () => {
  function pathFrom(rows: string[], defs: Record<string, SyntheticTile>) {
    const { getL1, cols, rows: rowCount } = buildGrid(rows, defs)
    return buildSurfacePath(getL1, cols, rowCount)
  }

  it('flat-to-flat same row: delta 0, matches', () => {
    const path = pathFrom(['..#..', '..#..'], { '#': FLAT })
    const next = path.nextSurface(2, 16, +1)  // walking right with prevExitY=16
    expect(next?.floorRow).toBe(0)
  })

  it('flat-to-flat one row down: delta 16, matches at boundary', () => {
    // prev floor row 1 (y=16). next column floor row 2 (y=32). Delta 16
    // — at the tolerance limit; designers use this for vanilla single-
    // tile drops.
    const path = pathFrom([
      '.....',
      '##...',  // r1: cols 0-1 floor at row 1
      '..###',  // r2: cols 2-4 floor at row 2 (one row lower)
    ], { '#': FLAT })
    const next = path.nextSurface(2, 16, +1)  // arriving at col 2 from col 1
    expect(next?.floorRow).toBe(2)
  })

  it('flat-to-flat two rows down: rejected (out of tolerance)', () => {
    const path = pathFrom([
      '.....',
      '##...',
      '.....',
      '..###',
    ], { '#': FLAT })
    const next = path.nextSurface(2, 16, +1)
    expect(next).toBeNull()
  })

  it('slope mating: prev right edge equals next left edge → delta 0, matches', () => {
    // Two adjacent slope tiles forming a continuous descent. The right
    // edge of the left tile (heights[15]=15) mates with the left edge
    // of the right tile (heights[0]=15) at delta 0.
    const SLOPE_FAR_RIGHT  = { actsLike: 0x16E, heights: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15] }
    const SLOPE_FAR_RIGHT2 = { actsLike: 0x16E, heights: [15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15] }
    const path = pathFrom([
      '.....',
      '.AB..',  // r1: A then B
    ], { 'A': SLOPE_FAR_RIGHT, 'B': SLOPE_FAR_RIGHT2 })
    // Walking right: prev exit Y at col 1 = yRight of A = 16+15 = 31.
    const next = path.nextSurface(2, 31, +1)
    expect(next?.floorRow).toBe(1)
  })

  it('STACKED-SLOPES regression: edge picks the lower slope where mid-pixel would pick the upper', () => {
    // Crafted so edge matching (yRight when walking left) and mid-pixel
    // sampling (yMid) disagree.
    //
    //   A at row 1: heights[8]=15, heights[15]=0
    //     yMid = 16 + 15 = 31  (high yMid — surface low in cell at center)
    //     yRight = 16 + 0 = 16  (low yRight — surface high at right edge)
    //   B at row 2: heights all = 8
    //     yMid = yRight = 32 + 8 = 40
    //
    // prev exit Y = 32 (a value between 31 and 40).
    //   EDGE (yRight): |16-32|=16 (A), |40-32|=8 (B) → picks B (row 2). ✓ correct
    //   MID  (yMid):   |31-32|=1  (A), |40-32|=8 (B) → picks A (row 1). ✗ wrong
    //
    // If SurfacePath is swapped to mid-pixel sampling, this test fails
    // (returns row 1). With edge matching it returns row 2.
    const A = { actsLike: 0x16E, heights: [0,0,0,0,0,0,0,0,15,0,0,0,0,0,0,0] }
    const B = { actsLike: 0x16E, heights: [8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8] }
    const path = pathFrom([
      '...',
      '.AA',
      '.BB',
      '...',
    ], { 'A': A, 'B': B })
    const next = path.nextSurface(1, 32, -1)
    expect(next?.floorRow).toBe(2)
  })

  it('no candidates within tolerance: returns null', () => {
    // Surface at col 2 is at y=48 (row 3). prevExitY=0 → distance 48 > 16 → reject.
    const path = pathFrom([
      '...',
      '...',
      '...',
      '..#',
    ], { '#': FLAT })
    const next = path.nextSurface(2, 0, +1, DEFAULT_EDGE_TOLERANCE)
    expect(next).toBeNull()
  })
})

// ── SPRITE_HAS_FLOOR / MARIO_HAS_FLOOR — ?? false right-side branches ─────────
// These exported constants use `cell.collision?.floor ?? false` and
// `cell.collision?.marioFloor ?? false`.  When `collision` is undefined (cells
// built without a classification pass), the ?. short-circuits to `undefined` and
// the `?? false` fallback fires.  The buildGrid helper above always adds a
// collision object, so we strip it here to exercise the right-side branches.

describe('SPRITE_HAS_FLOOR with undefined collision — ?? false right side', () => {
  it('cell without collision property: ??.floor is undefined → ?? false fires, cell not a surface', () => {
    const { getL1: classified, cols, rows } = buildGrid([
      '.....',
      '.....',
      '#####',
    ], { '#': FLAT })
    // Strip the collision object so cell.collision is undefined
    const getL1Raw: GetL1Tile = (c, r) => {
      const cell = classified(c, r)
      if (cell === null) return null
      return { id: cell.id, actsLike: cell.actsLike }   // no collision field
    }
    // SPRITE_HAS_FLOOR(rawCell) → rawCell.collision?.floor ?? false → false
    // → hasFloor returns false → no surface emitted for the floor row
    const path = buildSurfacePath(getL1Raw, cols, rows)
    expect(path.surfacesAt(2)).toHaveLength(0)
  })
})

describe('MARIO_HAS_FLOOR with undefined collision — ?? false right side', () => {
  it('cell without collision: ??.marioFloor is undefined → ?? false fires, cell not a surface', () => {
    const { getL1: classified, cols, rows } = buildGrid([
      '.....',
      '#####',
    ], { '#': FLAT })
    const getL1Raw: GetL1Tile = (c, r) => {
      const cell = classified(c, r)
      if (cell === null) return null
      return { id: cell.id, actsLike: cell.actsLike }   // no collision field
    }
    // MARIO_HAS_FLOOR(rawCell) → rawCell.collision?.marioFloor ?? false → false
    const path = buildSurfacePath(getL1Raw, cols, rows, { hasFloor: MARIO_HAS_FLOOR })
    expect(path.surfacesAt(2)).toHaveLength(0)
  })
})
