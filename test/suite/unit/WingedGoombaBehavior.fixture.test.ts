/**
 * Para-Goomba bounce simulation against a Mesen-recorded level $006
 * fixture (Donut Plains 4). Reproduces real-terrain bugs that synthetic
 * grids miss: in particular, ascending arcs that cross a rising slope's
 * row and were getting snapped DOWN by the ceiling branch in
 * `applyYSpeed`, then falling indefinitely.
 *
 * Goomba placement: tile-grid (c225, r21), on a small flat platform
 * (row 22 = solid `100`). Bounces toward Mario (left). To the left, a
 * slope rises up-and-left:
 *
 *   r19  c220 = 1af (slope tile)
 *   r20  c221 = 1af
 *   r21  c222 = 1af   ← directly left of platform's left edge
 *
 * The tall (4th) bounce launches the goomba upward through the slope's
 * row - the regression target.
 *
 * The fixture itself is NOT in this repo (Mesen captures of game ROM
 * data aren't redistributable). Set `HACKBENCH_FIXTURES_DIR` to the
 * directory containing per-level subdirs (e.g. `<dir>/006/map16.txt`)
 * to enable this test locally - it skips silently otherwise.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WingedGoombaBehavior } from '../../../src/rom/model/sprites/behaviors/WingedGoombaBehavior'
import { loadMesenFixture } from './fixtures/loadMesenFixture'

const FIXTURES_DIR = process.env.HACKBENCH_FIXTURES_DIR
const FIXTURE = FIXTURES_DIR ? join(FIXTURES_DIR, '006', 'map16.txt') : null
const TILE = 16
const skipIfNoFixture = FIXTURE && existsSync(FIXTURE) ? describe : describe.skip

skipIfNoFixture('WingedGoombaBehavior - level $006 fixture', () => {
  const fix = FIXTURE && existsSync(FIXTURE) ? loadMesenFixture(FIXTURE) : null
  // Mario spawns at the left edge of horizontal levels; precise X
  // doesn't matter - anything < goomba.x produces dir=1 (face left).
  const marioSpawnX = 0

  it('parses the fixture and finds the platform under the goomba', () => {
    if (!fix) return
    // Sanity: c225 r22 should be a solid tile (the platform), and c225 r21
    // should be air-or-decorative (the goomba's body row).
    const platform = fix.grid[22]?.[225]
    const headRow = fix.grid[21]?.[225]
    expect(platform, 'c225 r22 should be a solid floor tile').not.toBe(null)
    expect(fix.solidV(225, 22)).toBe(true)
    // c225 r21 holds the green-tuft decoration ($074, page-0). Page-0
    // tiles are passthrough for sprites - the goomba's body is in air.
    if (headRow !== null && headRow !== undefined) {
      expect(fix.solidV(225, 21)).toBe(false)
    }
  })

  it('bounce arc never descends below the lowest solid floor below the goomba', () => {
    if (!fix) return
    const beh = new WingedGoombaBehavior()
    const spawnX = 225 * TILE
    const spawnY = 21 * TILE
    const { points, openEnd } = beh.computeBouncePolyline(
      spawnX,
      spawnY,
      fix.solidH,
      fix.solidV,
      fix.cols,
      fix.rows,
      marioSpawnX,
      fix.getL1,
    )
    expect(points.length).toBeGreaterThan(8)

    // Find the first solid row at or below the goomba's spawn for every
    // column the path visits. Any path point whose center-Y is more than
    // half a tile BELOW its column's first solid row indicates the sprite
    // has fallen through a floor.
    const tooLow: { x: number; y: number; col: number; floorRow: number }[] = []
    for (const p of points) {
      const col = Math.floor(p.x / TILE)
      if (col < 0 || col >= fix.cols) continue
      let floorRow = -1
      for (let r = 21; r < fix.rows; r++) {
        if (fix.solidV(col, r) || fix.getL1(col, r)?.collision?.slope) {
          floorRow = r
          break
        }
      }
      if (floorRow < 0) continue // no floor in this column - open pit, OK to fall
      // Center-Y of a sprite resting on row `floorRow` is `floorRow*TILE - TILE/2`.
      // Allow a half-tile tolerance for sub-pixel accumulation.
      const restCenterY = floorRow * TILE - TILE / 2
      if (p.y > restCenterY + TILE) {
        tooLow.push({ x: p.x, y: p.y, col, floorRow })
      }
    }
    // The polyline should track the bounce arc without dipping below any
    // column's floor. `openEnd` is `true` whenever the trajectory has more
    // to come (frame budget exhausted OR sprite left the playfield); both
    // are valid here - what matters is that no point fell through terrain.
    expect(tooLow, 'path points fell below the floor in their columns').toEqual([])
    expect(openEnd).toBe(true)
  })

  it('ascending arc passes through a rising slope (no ceiling-snap)', () => {
    if (!fix) return
    // Verify the slope is where we expect it - defensive sanity so a
    // fixture re-record doesn't silently invalidate the test.
    const slopeId = fix.grid[21]?.[222]
    expect(slopeId, 'c222 r21 should be a slope tile').toBe(0x1af)
    expect(
      fix.getL1(222, 21)?.collision?.slope,
      'c222 r21 should resolve to slope info',
    ).toBeDefined()
    expect(fix.getL1(222, 21)?.collision?.ceiling, 'slopes are NOT ceilings').toBe(false)

    const beh = new WingedGoombaBehavior()
    const spawnX = 225 * TILE
    const spawnY = 21 * TILE
    const { points } = beh.computeBouncePolyline(
      spawnX,
      spawnY,
      fix.solidH,
      fix.solidV,
      fix.cols,
      fix.rows,
      marioSpawnX,
      fix.getL1,
    )
    // The tall bounce apex must reach above row 21's top (y < 21*16). If
    // the ceiling-snap bug is present, the sprite gets stopped at the top
    // of row 21 and never ascends further - the apex stays at y >= 21*16.
    const apexY = Math.min(...points.map(p => p.y))
    expect(apexY, 'tall bounce should ascend above the platform row').toBeLessThan(21 * TILE)
  })
})
