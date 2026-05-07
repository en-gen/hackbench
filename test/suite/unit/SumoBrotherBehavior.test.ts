/**
 * SumoBrotherBehavior — branch coverage.
 * ($9A Sumo Brother patrol + lightning geometry, bank_02.asm:12286–12578)
 *
 * Test tree:
 *   getPatrolRange
 *     - centered on sprite, unclipped
 *     - sprite near left edge → leftX clamped to 0
 *     - sprite near right edge → rightX clamped to levelCols*16
 *   getLightningFall
 *     - floor found below startRow → hasFloor=true, groundY = blockerRow*16
 *     - no floor anywhere → hasFloor=false, groundY = levelRows*16
 *     - surfacePoints non-empty when floor tiles are in the fire band
 *     - fallTopY = spriteY + 16
 *   getClusterFireXs
 *     - all 5 fires within a wide level
 *     - some fires clipped on a narrow level
 *   getLightningSpawnX
 *     - returns spriteX + 4
 */

import { describe, it, expect } from 'vitest'
import {
  SumoBrotherBehavior,
  PATROL_HALF_PX,
} from '../../../src/rom/model/sprites/behaviors/SumoBrotherBehavior'
import { buildSolidity } from './fixtures/buildSolidity'
import type { GetL1Tile } from '../../../src/rom/model/OverlayContext'

const GROUND = { actsLike: 0x130 }  // page-1 $30 — solid floor/wall
const BODY   = 16

// ── getPatrolRange ────────────────────────────────────────────────────────────

describe('SumoBrotherBehavior.getPatrolRange', () => {
  const beh = new SumoBrotherBehavior()

  it('returns correct bounds centered on the sprite (unclipped)', () => {
    // spriteX=80, center=88; range = [88-16, 88+16] = [72, 104]
    const { leftX, rightX } = beh.getPatrolRange(80, 20)
    expect(leftX).toBe(88 - PATROL_HALF_PX)
    expect(rightX).toBe(88 + PATROL_HALF_PX)
  })

  it('clips leftX to 0 when sprite is near the left edge', () => {
    // spriteX=0, center=8; raw leftX = 8-16 = -8 → clamped to 0
    const { leftX } = beh.getPatrolRange(0, 10)
    expect(leftX).toBe(0)
  })

  it('clips rightX to levelCols*16 when sprite is near the right edge', () => {
    // spriteX at far right: center near levelPixels → raw rightX > levelPixels
    const levelCols = 5                        // 80 px wide
    const spriteX   = levelCols * BODY - 8    // 72, center=80
    const { rightX } = beh.getPatrolRange(spriteX, levelCols)
    expect(rightX).toBe(levelCols * BODY)
  })
})

// ── getLightningFall ──────────────────────────────────────────────────────────

describe('SumoBrotherBehavior.getLightningFall — floor detection', () => {
  it('hasFloor=true when a floor tile exists at startRow (spriteRow + 4)', () => {
    // Sprite at y=0 (row 0): startRow = 0 + 1 + 3 = 4.
    // Floor at row 4 → found immediately on first scan step.
    const level = [
      '.....',  // row 0 — sprite here (y=0)
      '.....',  // row 1
      '.....',  // row 2
      '.....',  // row 3
      '#####',  // row 4 — ground  (startRow = 4)
    ]
    const { getL1, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new SumoBrotherBehavior()
    const result = beh.getLightningFall(0, 0, getL1, cols, rows)
    expect(result.hasFloor).toBe(true)
    expect(result.groundY).toBe(4 * BODY)  // top of blocker row
  })

  it('hasFloor=false when level has no solid floor', () => {
    const level = ['.....', '.....', '.....', '.....', '.....']
    const { getL1, cols, rows } = buildSolidity(level, {})
    const beh = new SumoBrotherBehavior()
    const result = beh.getLightningFall(0, 0, getL1, cols, rows)
    expect(result.hasFloor).toBe(false)
    expect(result.groundY).toBe(rows * BODY)  // fallback: level bottom
  })

  it('fallTopY is always spriteY + 16 (sprite bottom edge)', () => {
    // ASM: GenSumoLightning (bank_02.asm:12417) uses SpriteYPos unchanged.
    const level = [
      '.......',  // row 0
      '.......',  // row 1
      '.......',  // row 2
      '.......',  // row 3
      '#######',  // row 4
    ]
    const { getL1, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new SumoBrotherBehavior()
    const result = beh.getLightningFall(16, 32, getL1, cols, rows)
    expect(result.fallTopY).toBe(32 + BODY)
  })
})

describe('SumoBrotherBehavior.getLightningFall — surfacePoints', () => {
  it('surfacePoints is non-empty when floor tiles cover the fire band', () => {
    // Wide enough level for the full ±36px fire band around the lightning.
    // spriteX=80, spriteY=0 → lightningX=84, startRow=4.
    // Fire band: left=max(0,84-36)=48, right=min(176,128)=128.
    const level = [
      '...........', // row 0 (y=0)
      '...........', // row 1
      '...........', // row 2
      '...........', // row 3
      '###########', // row 4 (ground)
    ]
    const { getL1, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new SumoBrotherBehavior()
    const result = beh.getLightningFall(80, 0, getL1, cols, rows)
    expect(result.hasFloor).toBe(true)
    expect(result.surfacePoints.length).toBeGreaterThan(0)
  })

  it('surfacePoints is empty when no floor exists', () => {
    const level = ['.....', '.....', '.....', '.....', '.....']
    const { getL1, cols, rows } = buildSolidity(level, {})
    const beh = new SumoBrotherBehavior()
    const result = beh.getLightningFall(0, 0, getL1, cols, rows)
    expect(result.surfacePoints).toHaveLength(0)
  })
})

// ── getClusterFireXs ──────────────────────────────────────────────────────────

describe('SumoBrotherBehavior.getClusterFireXs', () => {
  const beh = new SumoBrotherBehavior()

  it('returns all 5 fires on a wide level (DATA_02DF22: −4,+12,−20,+28,−36)', () => {
    // lightningX = spriteX + 4 = 204. Level = 20 cols = 320 px.
    // All fires: 200, 216, 184, 232, 168 → all within [0, 304].
    const xs = beh.getClusterFireXs(200, 20)
    expect(xs).toHaveLength(5)
  })

  it('filters fires that would extend past the right level edge', () => {
    // lightningX = 44 (spriteX=40). Level = 5 cols = 80 px.
    // fire at dx=+28: x=72, right edge=88 > 80 → filtered.
    const xs = beh.getClusterFireXs(40, 5)
    expect(xs.length).toBeLessThan(5)
  })

  it('filters fires at negative x (fx >= 0 false branch — && short-circuit)', () => {
    // lightningX = spriteX + 4 = 4.
    // DATA_02DF22 offsets: -4→0, +12→16, -20→-16, +28→32, -36→-32.
    // Two fires land below 0 (dx=-20 → fx=-16, dx=-36 → fx=-32) — the
    // `&&` left-side check `fx >= 0` fires false, short-circuiting the
    // right side and covering the previously-missed && branch.
    const xs = beh.getClusterFireXs(0, 20)
    expect(xs.length).toBeLessThan(5)
  })
})

// ── getLightningSpawnX ────────────────────────────────────────────────────────

describe('SumoBrotherBehavior.getLightningSpawnX', () => {
  it('returns spriteX + 4 (ASM: bank_02.asm:12417)', () => {
    const beh = new SumoBrotherBehavior()
    expect(beh.getLightningSpawnX(100)).toBe(104)
    expect(beh.getLightningSpawnX(0)).toBe(4)
  })
})

// ── getLightningFall — slope at blocker row ───────────────────────────────────

describe('SumoBrotherBehavior.getLightningFall — slope at blocker row', () => {
  it('slope at fallCol,blockerRow: groundY refined from heights (if slope true branch)', () => {
    // spriteX=80: fallX=84, fallCol=floor((84+8)/16)=5, startRow=4.
    // Heights all 4 → px = (84 - 5*16 + 16) % 16 = 4
    // groundY = 4*16 + (heights[4] & 0x0F) = 64 + 4 = 68.
    const heights = new Uint8Array(16).fill(4)
    const level = [
      '...........', // row 0
      '...........', // row 1
      '...........', // row 2
      '...........', // row 3
      '###########', // row 4 — ground; col 5 overridden to slope below
    ]
    const { getL1: flatGetL1, cols, rows } = buildSolidity(level, { '#': GROUND })
    const slopeGetL1: GetL1Tile = (c, r) => {
      if (c === 5 && r === 4) {
        return {
          id: 0x180, actsLike: 0x16E,
          collision: {
            wall: false, floor: true, ceiling: false, slopeTable: true,
            marioFloor: true, marioCeiling: false, marioWall: false,
            slope: { heights },
          },
        }
      }
      return flatGetL1(c, r)
    }
    const beh = new SumoBrotherBehavior()
    const result = beh.getLightningFall(80, 0, slopeGetL1, cols, rows)
    expect(result.hasFloor).toBe(true)
    expect(result.groundY).toBe(68)
  })
})

// ── computeFireSurface — slope tile in fire band ──────────────────────────────

describe('SumoBrotherBehavior.getLightningFall — slope in fire band (computeFireSurface slope branch)', () => {
  it('slope tile in fire band yields more surfacePoints than all-flat floor', () => {
    // spriteX=80: fallX=84, fireLeftX=48, fireRightX=128.
    // startCol=3, endCol=8 → col 5 (fallCol) is inside the band.
    // Flat tile: 2 pts. Slope tile (px=0..16 step 2): 9 pts.
    // Total points with slope > total without slope.
    const heights = new Uint8Array(16).fill(4)
    const level = [
      '...........', // row 0
      '...........', // row 1
      '...........', // row 2
      '...........', // row 3
      '###########', // row 4
    ]
    const { getL1: flatGetL1, cols, rows } = buildSolidity(level, { '#': GROUND })
    const slopeGetL1: GetL1Tile = (c, r) => {
      if (c === 5 && r === 4) {
        return {
          id: 0x180, actsLike: 0x16E,
          collision: {
            wall: false, floor: true, ceiling: false, slopeTable: true,
            marioFloor: true, marioCeiling: false, marioWall: false,
            slope: { heights },
          },
        }
      }
      return flatGetL1(c, r)
    }
    const beh = new SumoBrotherBehavior()
    const flatResult  = beh.getLightningFall(80, 0, flatGetL1,  cols, rows)
    const slopeResult = beh.getLightningFall(80, 0, slopeGetL1, cols, rows)
    // One slope tile replaces 2 flat points with 9 slope points (+7 net).
    expect(slopeResult.surfacePoints.length).toBeGreaterThan(flatResult.surfacePoints.length)
  })
})
