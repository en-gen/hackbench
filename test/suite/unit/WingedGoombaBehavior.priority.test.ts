/**
 * Priority-1 (foreground decorative) tile passthrough for sprite collision.
 *
 * Layer-1 tiles whose Map16 subtiles all carry the priority bit render in
 * front of sprites and pass through sprite collision (per CODE_01928E /
 * CODE_0192C9 — page-0 BEQ skip + the priority overlay rule). The
 * `solidV` / `solidH` predicates already filter `cell.isPriority` to
 * false, but several sprite-side fall-back paths read `cell.collision`
 * fields directly to recover slope / floor info — those paths must apply
 * the same priority filter or sprites end up "landing on" foreground
 * decorations like the priority leaves in level $11E.
 *
 * These tests construct a 1-cell-wide priority slope sitting in mid-air
 * with no real floor below. A correctly-implemented sim drops the goomba
 * past the priority cell off the playfield (`openEnd: true`, no point
 * resting on the priority row).
 */
import { describe, expect, it } from 'vitest'
import type { GetL1Tile, L1Cell } from '../../../src/rom/model/OverlayContext'
import { solidityFromL1 } from '../../../src/rom/model/sprites/MovementBehavior'
import { WingedGoombaBehavior } from '../../../src/rom/model/sprites/behaviors/WingedGoombaBehavior'

const TILE = 16

/**
 * Build a tiny grid where row 4 is air everywhere except the column
 * specified, which holds a priority-1 cell with full slope-tile collision.
 * Row 5+ is air → no real ground exists. The goomba should fall through
 * the entire column.
 */
function priorityOnlyGrid(priorityCol: number, cols = 8, rows = 16): {
  getL1: GetL1Tile
  solidH: ReturnType<typeof solidityFromL1>['solidH']
  solidV: ReturnType<typeof solidityFromL1>['solidV']
  cols: number
  rows: number
} {
  const prioritySlopeCell: L1Cell = {
    id: 0x1AF,
    actsLike: 0x1AF,            // low byte $AF → slope range $6E-$D7
    isPriority: true,            // foreground decorative → passable
    collision: {
      // Mirrors what TileFactory.classify produces for a slope tile —
      // the bug is that priority-1 slopes still have these fields set,
      // and direct slope readers used to consume them.
      floor: true,
      wall: false,
      ceiling: false,
      marioFloor: false,
      marioCeiling: false,
      marioWall: false,
      slopeTable: true,
      slope: { slopeIndex: 0, heights: new Uint8Array(16) },
    },
  }
  const getL1: GetL1Tile = (c, r) => {
    if (c < 0 || c >= cols || r < 0 || r >= rows) return null
    if (r === 4 && c === priorityCol) return prioritySlopeCell
    return null
  }
  const { solidH, solidV } = solidityFromL1(getL1)
  return { getL1, solidH, solidV, cols, rows }
}

describe('WingedGoombaBehavior — priority-1 tile passthrough', () => {
  it('does not anchor restingY on a priority-1 slope tile', () => {
    // Spawn directly above the priority slope. Without the fix, the
    // groundRow scan picks up the slope (via collision.slope) and the
    // simulation starts as if resting on row 4. With the fix, the scan
    // skips the priority cell, no ground is found, the sprite falls.
    const grid = priorityOnlyGrid(3)
    const beh = new WingedGoombaBehavior()
    const spawnX = 3 * TILE
    const spawnY = 1 * TILE
    const { points, openEnd } = beh.computeBouncePolyline(
      spawnX, spawnY, grid.solidH, grid.solidV, grid.cols, grid.rows, /*marioSpawnX*/ 0, grid.getL1, /*frames*/ 64,
    )
    // Open end (sprite leaves the playfield) — no real floor exists.
    expect(openEnd).toBe(true)
    // The priority slope is at row 4 (top edge y=64). A sprite that
    // landed on it would have its center y near `4*16 - 8 = 56` (sprite
    // resting on the row-4 surface). If the bug were present, many
    // points would cluster at that y. With the fix, the sprite passes
    // through and the path's max-y monotonically increases past row 4.
    const maxY = Math.max(...points.map(p => p.y))
    expect(maxY, 'sprite should fall well past the priority row').toBeGreaterThan(5 * TILE)
  })

  it('sittingOnFloor reports false directly above a priority slope', () => {
    // Drive applyYSpeed's sittingOnFloor branch by spawning the sprite
    // already at the row above the priority cell. With vy=0 the sim
    // calls sittingOnFloor on frame 0 — it must not return true.
    const grid = priorityOnlyGrid(3)
    const beh = new WingedGoombaBehavior()
    const spawnX = 3 * TILE
    const spawnY = 3 * TILE   // bottom edge at row 4 — directly atop the priority slope
    const { points, openEnd } = beh.computeBouncePolyline(
      spawnX, spawnY, grid.solidH, grid.solidV, grid.cols, grid.rows, 0, grid.getL1, 32,
    )
    expect(openEnd).toBe(true)
    // First-frame Y should not stay pinned at the priority row's surface.
    // With the bug, point[0].y equals the slope-surface center; with the
    // fix, the sprite immediately starts falling.
    const last = points[points.length - 1]
    expect(last.y, 'should have descended past the priority row').toBeGreaterThan(5 * TILE)
  })
})
