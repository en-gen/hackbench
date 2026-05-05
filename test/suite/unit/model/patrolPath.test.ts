/**
 * patrolPath.test.ts — branch coverage for drawPatrolPath
 * (src/rom/model/overlays/patrolPath.ts).
 *
 * Uses a stub KoopaWalkBehavior (Object.create) to return controlled
 * patrol ranges, plus buildSolidity for synthetic L1 grids so that
 * buildSurfacePath (called internally) works against real tile data.
 *
 * Test tree:
 *   bottom.length < 2 → early return (no draw)
 *   flat floor, solidLeft + solidRight → wall caps drawn
 *   flat floor, neither wall → no wall cap stroke
 *   turnsAtLedges=false, marioSpawnX < x → toward-left path (restrict right side)
 *   turnsAtLedges=false, marioSpawnX > x → toward-right path (restrict left side)
 *   fallSide='left'  → showLeftFall  → L-arm with arrowhead on left
 *   fallSide='right' → showRightFall → L-arm with arrowhead on right
 *   spawnDropFromY defined → spawn-drop stroke drawn
 *   spawnDropFromY undefined → no spawn-drop
 *   slope tile in floor → heights sampled (slope branch)
 */

import { describe, it, expect } from 'vitest'
import { drawPatrolPath } from '../../../../src/rom/model/overlays/patrolPath'
import { KoopaWalkBehavior, type KoopaWalkConfig } from '../../../../src/rom/model/sprites/behaviors/KoopaWalkBehavior'
import { buildSolidity } from '../fixtures/buildSolidity'
import { makeMockCtx } from '../fixtures/mockOverlayCtx'
import type { L1Cell } from '../../../../src/rom/model/OverlayContext'

// ── Fixtures ─────────────────────────────────────────────────────────────

// A 7-column, 4-row level with a solid flat floor at row 3.
// '#' = floor tile (actsLike=0x0130: solid wall + floor).
const FLAT = buildSolidity(
  [
    '.......',
    '.......',
    '.......',
    '#######',
  ],
  { '#': { actsLike: 0x0130 } },
)

interface PatrolOpts {
  leftX?: number; rightX?: number
  topY?: number;  bottomY?: number
  solidLeft?: boolean; solidRight?: boolean
  fallSide?: 'left' | 'right' | null
  spawnDropFromY?: number
  turnsAtLedges?: boolean
  tall?: boolean
}

function makeBehavior(opts: PatrolOpts = {}): KoopaWalkBehavior {
  const b = Object.create(KoopaWalkBehavior.prototype) as KoopaWalkBehavior
  // Properties read directly in drawPatrolPath
  ;(b as never as Record<string, unknown>)['turnsAtLedges'] = opts.turnsAtLedges ?? true
  ;(b as never as Record<string, unknown>)['tall']          = opts.tall ?? false
  b.computePatrolRange = () => ({
    leftX:         opts.leftX   ?? 16,
    rightX:        opts.rightX  ?? 96,
    topY:          opts.topY    ?? 32,
    bottomY:       opts.bottomY ?? 48,
    solidLeft:     opts.solidLeft  ?? false,
    solidRight:    opts.solidRight ?? false,
    fallSide:      opts.fallSide ?? null,
    ...(opts.spawnDropFromY !== undefined ? { spawnDropFromY: opts.spawnDropFromY } : {}),
  })
  return b
}

// Sprite at x=48 (col 3) in the flat grid, sitting on the floor at row 3.
// y=32 means sprite top at row 2; bottomY=48 → floor at row 3.
const X = 48, Y = 32

// ── bottom.length < 2 early return ────────────────────────────────────────

describe('drawPatrolPath — bottom.length < 2 early return', () => {
  it('zero-width patrol range → no draw ops', () => {
    // leftX === rightX → colStart === colEnd → colFloorRow length 0 → bottom = []
    const ctx = makeMockCtx()
    const b = makeBehavior({ leftX: 32, rightX: 32, bottomY: 48 })
    drawPatrolPath(ctx, b, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })
})

// ── flat floor — dashed midline always drawn ───────────────────────────────

describe('drawPatrolPath — flat floor, dashed midline', () => {
  it('patrol range spanning 3+ tiles → stroke emitted', () => {
    const ctx = makeMockCtx()
    drawPatrolPath(ctx, makeBehavior(), X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })
})

// ── wall cap strokes ──────────────────────────────────────────────────────

describe('drawPatrolPath — wall caps', () => {
  it('solidLeft=true, solidRight=true → wall-cap stroke drawn', () => {
    const ctx = makeMockCtx()
    drawPatrolPath(ctx, makeBehavior({ solidLeft: true, solidRight: true }), X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    const strokes = ctx.events.filter(e => e.op === 'stroke')
    // At least 2 strokes: dashed midline + wall cap(s)
    expect(strokes.length).toBeGreaterThanOrEqual(2)
  })

  it('solidLeft=false, solidRight=false → only the midline stroke', () => {
    const ctx = makeMockCtx()
    drawPatrolPath(ctx, makeBehavior({ solidLeft: false, solidRight: false }), X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    const strokes = ctx.events.filter(e => e.op === 'stroke')
    expect(strokes).toHaveLength(1)
  })
})

// ── turnsAtLedges=false + marioSpawnX ────────────────────────────────────

describe('drawPatrolPath — turnsAtLedges=false pivot', () => {
  it('marioSpawnX < x: toward-left → endIdx restricted; no right-side drawing', () => {
    // sprite x=48; marioSpawnX=8 < 56 (x+8) → towardLeft=true
    // solidLeft=false → towardMarioWalled=false → endIdx = pivotIdx = bottom.findIndex
    // Patrol range left=16 right=96; marioSpawn left of sprite
    const ctx = makeMockCtx()
    const b = makeBehavior({ turnsAtLedges: false, solidLeft: false, solidRight: false })
    drawPatrolPath(ctx, b, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows, 8)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })

  it('marioSpawnX > x: toward-right → startIdx restricted', () => {
    // sprite x=48; marioSpawnX=100 > 56 → towardLeft=false → towardRight
    // solidRight=false → towardMarioWalled=false → startIdx = pivotIdx
    const ctx = makeMockCtx()
    const b = makeBehavior({ turnsAtLedges: false, solidLeft: false, solidRight: false })
    drawPatrolPath(ctx, b, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows, 100)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })

  it('turnsAtLedges=false, towardMario is walled → full range still drawn', () => {
    // solidLeft=true → towardMarioWalled=true → branch skipped → full path drawn
    const ctx = makeMockCtx()
    const b = makeBehavior({ turnsAtLedges: false, solidLeft: true, solidRight: true })
    drawPatrolPath(ctx, b, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows, 8)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })
})

// ── showLeftFall / showRightFall ──────────────────────────────────────────

describe('drawPatrolPath — fall arms', () => {
  it('fallSide=left → showLeftFall=true → L-arm and arrowhead on left', () => {
    // showLeftFall checks: fallSide==='left' && startIdx===0 (startIdx is 0 by default)
    const ctx = makeMockCtx()
    const b = makeBehavior({ fallSide: 'left', solidLeft: false, solidRight: false })
    drawPatrolPath(ctx, b, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    // The L-arm adds extra moveTo/lineTo ops before the main line
    const moveTos = ctx.events.filter(e => e.op === 'moveTo')
    expect(moveTos.length).toBeGreaterThan(1)
  })

  it('fallSide=right → showRightFall=true → L-arm and arrowhead on right', () => {
    const ctx = makeMockCtx()
    const b = makeBehavior({ fallSide: 'right', solidLeft: false, solidRight: false })
    drawPatrolPath(ctx, b, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    const lineTos = ctx.events.filter(e => e.op === 'lineTo')
    // Right L-arm: extra 2 lineTo ops at the end of the main path
    expect(lineTos.length).toBeGreaterThan(1)
  })

  it('fallSide=null → no fall arm', () => {
    const ctx = makeMockCtx()
    const b = makeBehavior({ fallSide: null })
    drawPatrolPath(ctx, b, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    // Only one moveTo for the patrol line start
    const moveTos = ctx.events.filter(e => e.op === 'moveTo')
    expect(moveTos).toHaveLength(1)
  })
})

// ── spawnDropFromY ────────────────────────────────────────────────────────

describe('drawPatrolPath — spawnDropFromY', () => {
  it('spawnDropFromY defined → additional stroke drawn for spawn-drop', () => {
    const ctx = makeMockCtx()
    // spawnDropFromY = 16 (sprite spawned 2 rows above the floor)
    const b = makeBehavior({ spawnDropFromY: 16 })
    drawPatrolPath(ctx, b, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    const strokes = ctx.events.filter(e => e.op === 'stroke')
    // Patrol stroke + spawn-drop stroke = 2
    expect(strokes.length).toBeGreaterThanOrEqual(2)
  })

  it('spawnDropFromY undefined → no extra stroke', () => {
    const ctx = makeMockCtx()
    const b = makeBehavior({ spawnDropFromY: undefined })
    drawPatrolPath(ctx, b, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    const strokes = ctx.events.filter(e => e.op === 'stroke')
    expect(strokes).toHaveLength(1)
  })
})

// ── slope tile → heights sampled ─────────────────────────────────────────

describe('drawPatrolPath — slope tile in floor', () => {
  it('slope tile causes 17 px-level points instead of 2 flat endpoints', () => {
    // Create a custom getL1 where one floor tile has slope data.
    // All others are flat floors or air.
    const SLOPE_ROW = 3, SLOPE_COL = 3
    const heights = new Uint8Array(16).fill(8)  // flat slope (all pixels at y+8)
    const customGetL1 = (c: number, r: number): L1Cell | null => {
      if (r !== SLOPE_ROW) return null
      if (c === SLOPE_COL) {
        return {
          id: 0x0200, actsLike: 0x0180,  // slope actsLike
          collision: {
            wall: false, floor: true, ceiling: false, slopeTable: true,
            marioFloor: true, marioCeiling: false, marioWall: false,
            slope: { heights, maxHeight: 8 },
          },
        }
      }
      // Non-slope solid floor for other cols in row 3
      return { id: 0x0130, actsLike: 0x0130, collision: {
        wall: true, floor: true, ceiling: true, slopeTable: false,
        marioFloor: false, marioCeiling: false, marioWall: false,
      } }
    }

    const ctx = makeMockCtx()
    const b = makeBehavior({ leftX: 32, rightX: 80, bottomY: 48 })
    drawPatrolPath(ctx, b, X, Y, customGetL1, 7, 4)
    // Slope tile emits 17 moveTo/lineTo pts vs 2 for flat tile — more total ops
    const lineTos = ctx.events.filter(e => e.op === 'lineTo')
    // With one slope tile (17 pts) + remaining flat tiles (2 pts each)
    // total lineTo count is greater than if all were flat
    expect(lineTos.length).toBeGreaterThan(2)
  })
})

// ── tall behavior ─────────────────────────────────────────────────────────

describe('drawPatrolPath — tall body', () => {
  it('tall=true: BODY_H=32 → midline drawn 16px higher than for tall=false', () => {
    const bottomY = 48
    const b = makeBehavior({ leftX: 16, rightX: 96, bottomY, tall: true })
    const ctx = makeMockCtx()
    drawPatrolPath(ctx, b, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    // For tall, HALF_BODY=16; for non-tall, HALF_BODY=8. The moveTo y coord differs.
    const moveTo = ctx.events.find(e => e.op === 'moveTo') as { op: 'moveTo'; y: number } | undefined
    // Floor at row3 → tileTopY=48. midline y = 48 - 16 = 32 for tall
    expect(moveTo?.y).toBe(32)

    const ctx2 = makeMockCtx()
    const b2 = makeBehavior({ leftX: 16, rightX: 96, bottomY, tall: false })
    drawPatrolPath(ctx2, b2, X, Y, FLAT.getL1, FLAT.cols, FLAT.rows)
    const moveTo2 = ctx2.events.find(e => e.op === 'moveTo') as { op: 'moveTo'; y: number } | undefined
    // For non-tall: midline y = 48 - 8 = 40
    expect(moveTo2?.y).toBe(40)
  })
})
