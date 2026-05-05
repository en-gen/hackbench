/**
 * SumoBrotherAppearance.test.ts — branch coverage for renderOverlay.
 *
 * Test tree:
 *   renderOverlay() guard
 *     - isActive=false → no draw
 *     - behavior not instanceof SumoBrotherBehavior → no draw
 *   renderOverlay() patrol line
 *     - always drawn when guard passes (behavior has getPatrolRange)
 *   renderOverlay() hasFloor branches
 *     - hasFloor=false → no lightning/fire drawn
 *     - hasFloor=true, groundY <= fallTopY → no vertical stroke (Sumo on floor)
 *     - hasFloor=true, groundY > fallTopY  → vertical lightning stroke drawn
 *   renderOverlay() fire footprints
 *     - getClusterFireXs yields values → fill (flame shape) emitted per slot
 *     - surfaceYAt returns null → ?? fallback to groundY (no interpolation)
 *     - surfaceYAt finds a segment → interpolated surfY used (not fallback)
 *   surfaceYAt private helper via indirect testing
 *     - points.length === 0 → returns null → uses groundY fallback
 *     - targetX outside all segments → returns null → uses groundY fallback
 *     - targetX inside a segment → interpolated y
 */

import { describe, it, expect } from 'vitest'
import { SumoBrotherAppearance } from '../../../../src/rom/model/sprites/appearances/SumoBrotherAppearance'
import { SumoBrotherBehavior } from '../../../../src/rom/model/sprites/behaviors/SumoBrotherBehavior'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { makeMockCtx } from '../fixtures/mockOverlayCtx'
import { makeTestMapStore } from '../fixtures/stores'
import type { SpritePart } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOOP_L1 = () => null
const COLS = 20, ROWS = 15
const mapStore = makeTestMapStore({})

function simpleAppearance(): SumoBrotherAppearance {
  const parts: SpritePart[] = Array.from({length: 10}, () => ({
    char: new Char(0, new StaticPixelsBehavior(new Uint8Array(64))),
    palette: 10, flipX: false, flipY: false, dx: 0, dy: 0,
  }))
  return new SumoBrotherAppearance(parts)
}

interface FallResult {
  hasFloor: boolean
  groundY: number
  fallTopY: number
  fallX: number
  surfacePoints: ReadonlyArray<readonly [number, number]>
}

function makeBehavior(opts: {
  leftX?: number; rightX?: number
  fall?: Partial<FallResult>
  fireXs?: number[]
}) {
  const b = Object.create(SumoBrotherBehavior.prototype) as SumoBrotherBehavior
  b.getPatrolRange = () => ({ leftX: opts.leftX ?? 0, rightX: opts.rightX ?? 80 })
  const fall: FallResult = {
    hasFloor: false, groundY: 200, fallTopY: 150, fallX: 40, surfacePoints: [],
    ...opts.fall,
  }
  b.getLightningFall = () => fall
  b.getClusterFireXs = () => opts.fireXs ?? []
  return b
}

// ── guard branches ────────────────────────────────────────────────────────

describe('SumoBrotherAppearance.renderOverlay — guard', () => {
  it('isActive=false → no draw ops beyond save/restore', () => {
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, false, NOOP_L1, COLS, ROWS, makeBehavior({}), mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })

  it('behavior not instanceof SumoBrotherBehavior → no draw ops', () => {
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS, {} as never, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })
})

// ── patrol line always drawn ──────────────────────────────────────────────

describe('SumoBrotherAppearance.renderOverlay — patrol line', () => {
  it('patrol line stroked with correct leftX endpoint', () => {
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS,
      makeBehavior({ leftX: 16, rightX: 64 }), mapStore)
    const moveTos = ctx.events.filter(e => e.op === 'moveTo') as { op: 'moveTo'; x: number }[]
    expect(moveTos.some(m => m.x === 16)).toBe(true)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })
})

// ── hasFloor branches ─────────────────────────────────────────────────────

describe('SumoBrotherAppearance.renderOverlay — hasFloor', () => {
  it('hasFloor=false → no lightning stroke, no fill', () => {
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS,
      makeBehavior({ fall: { hasFloor: false } }), mapStore)
    // Patrol line strokes exist, but no fills (no flame footprints)
    expect(ctx.events.some(e => e.op === 'fill')).toBe(false)
    // Only the 2 patrol strokes (dashed line + wall caps) present
    const strokes = ctx.events.filter(e => e.op === 'stroke')
    expect(strokes).toHaveLength(2)
  })

  it('hasFloor=true, groundY <= fallTopY → no vertical lightning stroke', () => {
    // Sumo standing on floor: groundY=150, fallTopY=150 → not strictly greater
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS,
      makeBehavior({ fall: { hasFloor: true, groundY: 150, fallTopY: 150, fallX: 40, surfacePoints: [] }, fireXs: [] }),
      mapStore)
    // Patrol strokes only; no lightning stroke (3rd stroke absent)
    const strokes = ctx.events.filter(e => e.op === 'stroke')
    expect(strokes).toHaveLength(2)
    expect(ctx.events.some(e => e.op === 'fill')).toBe(false)
  })

  it('hasFloor=true, groundY > fallTopY → vertical lightning stroke drawn', () => {
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS,
      makeBehavior({ fall: { hasFloor: true, groundY: 200, fallTopY: 100, fallX: 40, surfacePoints: [] }, fireXs: [] }),
      mapStore)
    // Patrol (2) + lightning (1) = 3 strokes
    const strokes = ctx.events.filter(e => e.op === 'stroke')
    expect(strokes).toHaveLength(3)
  })
})

// ── fire footprints ───────────────────────────────────────────────────────

describe('SumoBrotherAppearance.renderOverlay — fire footprints', () => {
  const baseFall: Partial<FallResult> = {
    hasFloor: true, groundY: 200, fallTopY: 100, fallX: 40, surfacePoints: [],
  }

  it('getClusterFireXs yields one value → one fill emitted', () => {
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS,
      makeBehavior({ fall: baseFall, fireXs: [32] }), mapStore)
    const fills = ctx.events.filter(e => e.op === 'fill')
    expect(fills).toHaveLength(1)
  })

  it('getClusterFireXs yields three values → three fills emitted', () => {
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS,
      makeBehavior({ fall: baseFall, fireXs: [0, 32, 64] }), mapStore)
    const fills = ctx.events.filter(e => e.op === 'fill')
    expect(fills).toHaveLength(3)
  })

  it('surfacePoints empty → surfaceYAt returns null → uses groundY fallback (?? branch)', () => {
    // surfacePoints=[] → surfaceYAt returns null → ?? fall.groundY (200) used as surfY
    // Test: flame footprint is drawn at groundY=200 (not some interpolated y)
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS,
      makeBehavior({ fall: { ...baseFall, surfacePoints: [], groundY: 200 }, fireXs: [32] }),
      mapStore)
    // The flame's baseY = surfY = 200; check a moveTo at y=200
    const moveTos = ctx.events.filter(e => e.op === 'moveTo') as { op: 'moveTo'; x: number; y: number }[]
    expect(moveTos.some(m => m.y === 200)).toBe(true)
  })

  it('surfacePoints covering targetX → interpolated surfY used (not groundY)', () => {
    // surfacePoints = [[24, 180], [40, 180]] covers cx=40 (fx=32 → cx=40)
    // surfaceYAt returns 180 → used instead of groundY=200
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS,
      makeBehavior({
        fall: { ...baseFall, surfacePoints: [[24, 180], [40, 180]], groundY: 200 },
        fireXs: [32],
      }),
      mapStore)
    const moveTos = ctx.events.filter(e => e.op === 'moveTo') as { op: 'moveTo'; x: number; y: number }[]
    expect(moveTos.some(m => m.y === 180)).toBe(true)
  })

  it('surfacePoints present but targetX outside range → null → uses groundY', () => {
    // cx = fx+8 = 200. surfacePoints covers x=[0,16] → targetX=200 outside → returns null
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS,
      makeBehavior({
        fall: { ...baseFall, surfacePoints: [[0, 180], [16, 180]], groundY: 200 },
        fireXs: [192],  // cx = 200, outside [0,16]
      }),
      mapStore)
    const moveTos = ctx.events.filter(e => e.op === 'moveTo') as { op: 'moveTo'; x: number; y: number }[]
    expect(moveTos.some(m => m.y === 200)).toBe(true)
  })
})
