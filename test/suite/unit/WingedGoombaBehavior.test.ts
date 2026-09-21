/**
 * WingedGoombaBehavior - synthetic branch coverage.
 * ($10 WingedGoomba handler, bank_01.asm:1934-1988)
 *
 * Complements WingedGoombaBehavior.priority.test.ts (priority-1 passthrough)
 * and WingedGoombaBehavior.fixture.test.ts (Mesen terrain regression).
 * These tests use synthetic flat/walled levels to lock the branches inside
 * `computeBouncePolyline` that the priority tests don't reach:
 *   - s.ground → true (landing on real floor, bounceCount increments)
 *   - bounceCount === 4 → GOOMBA_TALL_VY (4th bounce taller than 1-3)
 *   - s.blocked === direction → wall flip
 *   - getL1 absent → collision = undefined
 *   - spawnX > marioSpawnX → dir = 1 vs dir = 0
 *
 * Test tree:
 *   kind
 *   computeBouncePolyline
 *     - without getL1 → returns points, openEnd:true
 *     - with getL1 → same result shape
 *     - dir=1 when spawnX > marioSpawnX (face left)
 *     - dir=0 when spawnX <= marioSpawnX (face right)
 *     - bounceCount 1→2→3→4 cycle: 4th bounce apex clearly above short bounces
 *     - wall flip: sprite stays inside walled corridor
 *     - openEnd:true when sprite exits level
 */

import { describe, expect, it } from 'vitest'
import { WingedGoombaBehavior } from '../../../src/rom/model/sprites/behaviors/WingedGoombaBehavior'
import { buildSolidity } from './fixtures/buildSolidity'

const GROUND = { actsLike: 0x130 }
const WALL = { actsLike: 0x130 }
const BODY = 16

describe('WingedGoombaBehavior - kind', () => {
  it('kind === winged_goomba', () => {
    expect(new WingedGoombaBehavior().kind).toBe('winged_goomba')
  })
})

describe('WingedGoombaBehavior - computeBouncePolyline basic', () => {
  it('returns non-empty points and openEnd:true without getL1 (collision=undefined path)', () => {
    // Exercises the `getL1 ? spriteCollisionFromL1(getL1) : undefined` false branch.
    const level = Array(3).fill('..........').concat(['##########'])
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new WingedGoombaBehavior()
    const { points, openEnd } = beh.computeBouncePolyline(
      5 * BODY,
      2 * BODY,
      solidH,
      solidV,
      cols,
      rows,
    )
    expect(points.length).toBeGreaterThan(0)
    expect(openEnd).toBe(true)
  })

  it('returns non-empty points with getL1 provided (collision truthy path)', () => {
    const level = Array(3).fill('..........').concat(['##########'])
    const { solidH, solidV, getL1, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new WingedGoombaBehavior()
    const { points, openEnd } = beh.computeBouncePolyline(
      5 * BODY,
      2 * BODY,
      solidH,
      solidV,
      cols,
      rows,
      0,
      getL1,
    )
    expect(points.length).toBeGreaterThan(0)
    expect(openEnd).toBe(true)
  })

  it('dir=1 when spawnX > marioSpawnX (face left)', () => {
    // spawnX=5*BODY=80 > marioSpawnX=0 → dir=1; first horizontal step is leftward.
    const level = Array(5).fill('....................').concat(['####################'])
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new WingedGoombaBehavior()
    const { points } = beh.computeBouncePolyline(10 * BODY, 4 * BODY, solidH, solidV, cols, rows, 0)
    // After a few frames moving left, center X should drop below spawn center
    const spawnCenterX = 10 * BODY + BODY / 2
    expect(points.at(-1)!.x).toBeLessThan(spawnCenterX)
  })

  it('dir=0 when spawnX <= marioSpawnX (face right)', () => {
    // spawnX=5*BODY=80 <= marioSpawnX=10*BODY=160 → dir=0; center X rises.
    const level = Array(5).fill('....................').concat(['####################'])
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new WingedGoombaBehavior()
    const { points } = beh.computeBouncePolyline(
      5 * BODY,
      4 * BODY,
      solidH,
      solidV,
      cols,
      rows,
      10 * BODY,
    )
    const spawnCenterX = 5 * BODY + BODY / 2
    expect(points.at(-1)!.x).toBeGreaterThan(spawnCenterX)
  })

  it('openEnd:true when sprite walks off the level edge', () => {
    // 1-col, 2-row level; dir=0 (right) → immediately exits after launch.
    const level = ['.', '#']
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new WingedGoombaBehavior()
    // marioSpawnX=2*BODY > spawnX=0 → dir=0 (right) → exits col ≥ 1
    const { openEnd } = beh.computeBouncePolyline(0, 0, solidH, solidV, cols, rows, 2 * BODY)
    expect(openEnd).toBe(true)
  })
})

describe('WingedGoombaBehavior - bounce counter cycle (s.ground + bounceCount)', () => {
  it('full 256-frame budget runs without crash and produces 256 points', () => {
    // 5 air rows + 1 ground, 20 cols wide. dir=1 (left), spawnX=10*BODY=160.
    // In 256 frames at -0.5px/frame: travels ~128 px left → x≈32, still in bounds.
    // GOOMBA_TALL_VY=-48 → apex ≈ 36 px up from y=64; level is 96 px tall → fits.
    // Exercises s.ground → true on each landing and bounceCount values 1-4.
    const level = Array(5).fill('....................').concat(['####################'])
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new WingedGoombaBehavior()
    const { points, openEnd } = beh.computeBouncePolyline(
      10 * BODY,
      4 * BODY,
      solidH,
      solidV,
      cols,
      rows,
      0,
      undefined,
      256,
    )
    expect(points).toHaveLength(256) // full budget - no premature offgrid exit
    expect(openEnd).toBe(true)
  })

  it('4th bounce (bounceCount=4) reaches clearly higher apex than short bounces', () => {
    // GOOMBA_TALL_VY=-48 yields an apex ~36 px above ground; short=-16 yields ~4 px.
    // Use a wide level (20 cols) so the leftward sprite doesn't exit before bounce 4.
    const level = Array(5).fill('....................').concat(['####################'])
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new WingedGoombaBehavior()
    // spawnX=10*BODY > marioSpawnX=0 → dir=1 (left); 10 cols of headroom to the left.
    const { points } = beh.computeBouncePolyline(
      10 * BODY,
      4 * BODY,
      solidH,
      solidV,
      cols,
      rows,
      0,
      undefined,
      256,
    )
    // Ground resting center Y = (5*16 - 16) + 8 = 64+8 = 72
    const groundCenterY = 5 * BODY - BODY + BODY / 2
    // The tall bounce apex must be more than 20 px above resting center
    const minY = Math.min(...points.map(p => p.y))
    expect(minY).toBeLessThan(groundCenterY - 20)
  })
})

describe('WingedGoombaBehavior - wall flip (s.blocked)', () => {
  it('wall flip keeps sprite inside walled corridor', () => {
    // Wall at col 1 (left), wall at col 8 (right). Ground at row 2.
    // dir=1 (left): spawnX=5*BODY=80 > marioSpawnX=0 → sprite walks left,
    // hits left wall, s.blocked='left' → flip to dir=0 → bounces back right.
    const level = ['.W.......W', '.W.......W', '##########']
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND, W: WALL })
    const beh = new WingedGoombaBehavior()
    const { points } = beh.computeBouncePolyline(
      5 * BODY,
      1 * BODY,
      solidH,
      solidV,
      cols,
      rows,
      0,
      undefined,
      128,
    )
    // All path points must stay within the interior corridor (cols 2-8, x in [32,144])
    const minX = Math.min(...points.map(p => p.x))
    const maxX = Math.max(...points.map(p => p.x))
    expect(minX).toBeGreaterThanOrEqual(2 * BODY)
    expect(maxX).toBeLessThanOrEqual(9 * BODY)
  })

  it('flip body executes: hitting wall sets s.blocked, condition fires, dir/vx/blocked updated', () => {
    // 3-row, 4-col level. Ground row uses actsLike=0x100 (floor=true, wall=false) so
    // the ground row does NOT block horizontal movement - only the explicit 'W' col does.
    // spawnX=2*BODY=32 > marioSpawnX=0 → dir=1 (left). On the first non-zero-vx frame
    // applyXSpeed hits the wall at col 1 (x=[16,32)) and sets s.blocked='left'.
    // Flip condition s.blocked==='left'===( dir===0?'right':'left' ) fires:
    //   s.dir 1→0, s.vx negated −8→+8, s.blocked cleared.
    // Sprite then moves right and eventually exits the 4-col level.
    const FLOOR_ONLY = { actsLike: 0x100 } // floor=true wall=false: landable, not a horizontal barrier
    const level = ['.W..', '.W..', '####']
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': FLOOR_ONLY, W: WALL })
    const beh = new WingedGoombaBehavior()
    const { points, openEnd } = beh.computeBouncePolyline(
      2 * BODY,
      1 * BODY,
      solidH,
      solidV,
      cols,
      rows,
      0,
      undefined,
      50,
    )
    // After the flip the sprite moves rightward and exits the level.
    // Final recorded center-x must be past the starting center-x of 40 (x=32+8).
    expect(points.at(-1)!.x).toBeGreaterThan(3 * BODY)
    expect(openEnd).toBe(true)
  })
})
