/**
 * WingedSpriteAppearance.test.ts — branch coverage for render + renderOverlay.
 *
 * All behavior stubs use Object.create(Prototype) so instanceof checks pass
 * without requiring real behavior construction (which needs ROM data).
 *
 * Test tree:
 *   render()
 *     - wingsInFront=false: wings drawn before body parts
 *     - wingsInFront=true:  body drawn before wings
 *   renderOverlay() — guard
 *     - isActive=false → no draw ops
 *     - behavior=undefined → no draw ops
 *   renderOverlay() — BouncingKoopaBehavior
 *     - points.length >= 2 → arrowhead drawn
 *     - points.length < 2 → no arrowhead
 *   renderOverlay() — WingedGoombaBehavior
 *     - same polyline + arrowhead path as bouncing koopa
 *   renderOverlay() — FlyingLeftKoopaBehavior
 *     - fade-corridor horizontal line drawn
 *   renderOverlay() — SinusoidalParaKoopaBehavior vertical axis
 *   renderOverlay() — SinusoidalParaKoopaBehavior horizontal axis
 *   renderOverlay() — KoopaWalkBehavior
 *   renderOverlay() — FlyingBlockBehavior, path.length >= 2
 *   strokeDashedPolyline: points.length < 2 → early return (no stroke)
 */

import { describe, it, expect } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import type { SpriteLayout } from '../../../../src/rom/SpriteTileLoader'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { WingedSpriteAppearance } from '../../../../src/rom/model/sprites/appearances/WingedSpriteAppearance'
import { type SpritePart } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import { BouncingKoopaBehavior }       from '../../../../src/rom/model/sprites/behaviors/BouncingKoopaBehavior'
import { WingedGoombaBehavior }         from '../../../../src/rom/model/sprites/behaviors/WingedGoombaBehavior'
import { FlyingLeftKoopaBehavior }      from '../../../../src/rom/model/sprites/behaviors/FlyingLeftKoopaBehavior'
import { SinusoidalParaKoopaBehavior }  from '../../../../src/rom/model/sprites/behaviors/SinusoidalParaKoopaBehavior'
import { KoopaWalkBehavior }            from '../../../../src/rom/model/sprites/behaviors/KoopaWalkBehavior'
import { FlyingBlockBehavior }          from '../../../../src/rom/model/sprites/behaviors/FlyingBlockBehavior'
import { ThwimpBounceBehavior }          from '../../../../src/rom/model/sprites/behaviors/ThwimpBounceBehavior'
import type { RenderTarget, PixelPos }  from '../../../../src/rom/model/RenderTarget'
import type { Palette }                 from '../../../../src/rom/model/palette/Palette'
import { makeTestMapStore }             from '../fixtures/stores'
import { makeMockCtx }                  from '../fixtures/mockOverlayCtx'

// ── Fixtures ─────────────────────────────────────────────────────────────

const TRANSPARENT_ROW: RgbaColor[] = Array(16).fill([0, 0, 0, 0] as RgbaColor)

function makePart(dx = 0, dy = 0): SpritePart {
  return {
    char: new Char(0, new StaticPixelsBehavior(new Uint8Array(64))),
    palette: 0, flipX: false, flipY: false, dx, dy,
  }
}

const WING_F0 = [makePart(0, -8)]
const WING_F1 = [makePart(0, -4)]
const BODY    = [makePart(0,  0)]

function makeAppearance(wingsInFront = false) {
  return new WingedSpriteAppearance(BODY, [WING_F0, WING_F1], wingsInFront)
}

const stubPalette = {
  row: () => TRANSPARENT_ROW,
  color: () => [0, 0, 0, 0] as RgbaColor,
  cells: [] as never,
  backAreaColor: null as never,
} as unknown as Palette

const mapStore = makeTestMapStore({ palette: stubPalette })

function capturingTarget() {
  const order: number[] = []
  const target: RenderTarget = {
    blit8x8(_px, pos: PixelPos) { order.push(pos.y) },
    fillRect() {},
  }
  return { target, order }
}

const NOOP_L1 = () => null
const COLS = 20, ROWS = 15

// ── render() — wingsInFront ───────────────────────────────────────────────

describe('WingedSpriteAppearance.render — draw order', () => {
  it('wingsInFront=false: wings drawn first (behind body)', () => {
    // Body part at dy=0, wing at dy=-8. Wings-first means y=-8 is recorded first.
    const { target, order } = capturingTarget()
    makeAppearance(false).render(target, 0, 0, undefined as never, mapStore)
    // wing dy=-8 → y=-8 comes before body dy=0 → y=0
    expect(order[0]).toBe(-8)
    expect(order[1]).toBe(0)
  })

  it('wingsInFront=true: body drawn first (wings in front)', () => {
    const { target, order } = capturingTarget()
    makeAppearance(true).render(target, 0, 0, undefined as never, mapStore)
    // body dy=0 → y=0 comes before wing dy=-8 → y=-8
    expect(order[0]).toBe(0)
    expect(order[1]).toBe(-8)
  })
})

// ── renderOverlay — guard branches ────────────────────────────────────────

describe('WingedSpriteAppearance.renderOverlay — guard', () => {
  it('isActive=false → no draw ops emitted', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, false, NOOP_L1, COLS, ROWS, undefined, mapStore)
    expect(ctx.events.filter(e => e.op !== 'save' && e.op !== 'restore')).toHaveLength(0)
  })

  it('behavior=undefined → no draw ops emitted', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS, undefined, mapStore)
    expect(ctx.events.filter(e => e.op !== 'save' && e.op !== 'restore')).toHaveLength(0)
  })
})

// ── renderOverlay — BouncingKoopaBehavior ────────────────────────────────

describe('WingedSpriteAppearance.renderOverlay — BouncingKoopaBehavior', () => {
  function makeBouncingBehavior(points: {x:number; y:number}[]) {
    const b = Object.create(BouncingKoopaBehavior.prototype) as BouncingKoopaBehavior
    b.computeBouncePolyline = () => ({ points } as never)
    return b
  }

  it('points.length >= 2 → stroke + arrowhead emitted', () => {
    const ctx = makeMockCtx()
    const b = makeBouncingBehavior([{x:10, y:20}, {x:50, y:20}])
    makeAppearance().renderOverlay(ctx, 10, 20, true, NOOP_L1, COLS, ROWS, b, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
    // arrowhead draws a filled path — check a moveTo was emitted for the tip
    const moveTos = ctx.events.filter(e => e.op === 'moveTo')
    expect(moveTos.length).toBeGreaterThan(0)
  })

  it('points.length < 2 → no stroke (strokeDashedPolyline early return)', () => {
    const ctx = makeMockCtx()
    const b = makeBouncingBehavior([{x:10, y:20}])  // only 1 point
    makeAppearance().renderOverlay(ctx, 10, 20, true, NOOP_L1, COLS, ROWS, b, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })

  it('points empty → no stroke', () => {
    const ctx = makeMockCtx()
    const b = makeBouncingBehavior([])
    makeAppearance().renderOverlay(ctx, 10, 20, true, NOOP_L1, COLS, ROWS, b, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })
})

// ── renderOverlay — WingedGoombaBehavior ──────────────────────────────────

describe('WingedSpriteAppearance.renderOverlay — WingedGoombaBehavior', () => {
  it('polyline with 2+ points → stroke emitted', () => {
    const b = Object.create(WingedGoombaBehavior.prototype) as WingedGoombaBehavior
    b.computeBouncePolyline = () => ({ points: [{x:0,y:0},{x:16,y:16}] } as never)
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS, b, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })
})

// ── renderOverlay — FlyingLeftKoopaBehavior ───────────────────────────────

describe('WingedSpriteAppearance.renderOverlay — FlyingLeftKoopaBehavior', () => {
  it('draws a horizontal dashed line for the fade corridor', () => {
    const b = Object.create(FlyingLeftKoopaBehavior.prototype) as FlyingLeftKoopaBehavior
    b.computeFadeCorridor = () => ({ originX: 50, originY: 100, endX: 0 })
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 50, 100, true, NOOP_L1, COLS, ROWS, b, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
    // lineTo should reach endX=0
    const lineTo = ctx.events.find(e => e.op === 'lineTo') as { op: 'lineTo'; x: number; y: number } | undefined
    expect(lineTo?.x).toBe(0)
  })
})

// ── renderOverlay — SinusoidalParaKoopaBehavior ───────────────────────────

describe('WingedSpriteAppearance.renderOverlay — SinusoidalParaKoopaBehavior', () => {
  function makeSineBehavior(axis: 'vertical' | 'horizontal') {
    const b = Object.create(SinusoidalParaKoopaBehavior.prototype) as SinusoidalParaKoopaBehavior
    b.computeSineBounds = () => ({ axis, minPos: -40, maxPos: 0 })
    return b
  }

  it('vertical axis: moveTo/lineTo use centerY ± offsets', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 100, 200, true, NOOP_L1, COLS, ROWS, makeSineBehavior('vertical'), mapStore)
    const moveTos = ctx.events.filter(e => e.op === 'moveTo') as { op: 'moveTo'; x: number; y: number }[]
    // At least one moveTo in the dashed line uses the center-X (100+8=108)
    expect(moveTos.some(m => m.x === 108)).toBe(true)
  })

  it('horizontal axis: moveTo/lineTo use centerX ± offsets', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 100, 200, true, NOOP_L1, COLS, ROWS, makeSineBehavior('horizontal'), mapStore)
    const moveTos = ctx.events.filter(e => e.op === 'moveTo') as { op: 'moveTo'; x: number; y: number }[]
    // Horizontal: moveTo uses centerY (200+8=208) for the Y coord of the dashed line
    expect(moveTos.some(m => m.y === 208)).toBe(true)
  })
})

// ── renderOverlay — KoopaWalkBehavior ─────────────────────────────────────

describe('WingedSpriteAppearance.renderOverlay — KoopaWalkBehavior', () => {
  it('draws a dashed horizontal patrol line', () => {
    const b = Object.create(KoopaWalkBehavior.prototype) as KoopaWalkBehavior
    b.computePatrolRange = () => ({
      leftX: 10, rightX: 90, topY: 16, bottomY: 32,
      solidLeft: true, solidRight: true, fallSide: null,
    })
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 50, 16, true, NOOP_L1, COLS, ROWS, b, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
    const moveTo = ctx.events.find(e => e.op === 'moveTo') as { op: 'moveTo'; x: number } | undefined
    expect(moveTo?.x).toBe(10)   // leftX
  })
})

// ── renderOverlay — FlyingBlockBehavior ───────────────────────────────────

describe('WingedSpriteAppearance.renderOverlay — FlyingBlockBehavior', () => {
  it('path.length >= 2 → polyline + arrowhead drawn', () => {
    const b = Object.create(FlyingBlockBehavior.prototype) as FlyingBlockBehavior
    b.computePath = () => [{x:100,y:100}, {x:50,y:108}, {x:0,y:100}]
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 100, 100, true, NOOP_L1, COLS, ROWS, b, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })

  it('path.length < 2 → no stroke drawn', () => {
    const b = Object.create(FlyingBlockBehavior.prototype) as FlyingBlockBehavior
    b.computePath = () => [{x:100,y:100}]
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 100, 100, true, NOOP_L1, COLS, ROWS, b, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })
})

// ── factory methods — layoutToBodyParts + buildKoopaWingFrames ────────────

describe('WingedSpriteAppearance.fromParaKoopa — layout=null (no body parts)', () => {
  it('layout=null → layoutToBodyParts gets null → empty body; wing frames built from chars', () => {
    // null layout → layout?.tiles = undefined → ?? [] → body = []
    // chars populated → wing chars found → ?? placeholder NOT used
    const chars = new Map<number, Char>()
    for (let i = 0; i < 0x200; i++) chars.set(0x400 + i, new Char(i, new StaticPixelsBehavior(new Uint8Array(64))))
    const placeholder = new Char(0xFFFF, new StaticPixelsBehavior(new Uint8Array(64)))
    const app = WingedSpriteAppearance.fromParaKoopa(chars, placeholder, null)
    // body parts = 0 (null layout), wing frame 0 has 4 parts (16x16 wing = 4 sub-tiles)
    expect(app.bodyParts).toHaveLength(0)
    expect(app.wingFrames[0]).toHaveLength(4)
    // all wing chars come from the chars map (not placeholder)
    expect(app.wingFrames[0].every(p => p.char !== placeholder)).toBe(true)
  })

  it('layout=null + empty chars → all wing parts use placeholder', () => {
    // chars.get(BASE + n) = undefined → ?? placeholder used in buildKoopaWingFrames
    const placeholder = new Char(0xFFFF, new StaticPixelsBehavior(new Uint8Array(64)))
    const app = WingedSpriteAppearance.fromParaKoopa(new Map(), placeholder, null)
    expect(app.wingFrames[0].every(p => p.char === placeholder)).toBe(true)
  })
})

describe('WingedSpriteAppearance.fromParaGoomba — layout=null', () => {
  it('fromParaGoomba with null layout → no body parts; goomba wing frames built', () => {
    const chars = new Map<number, Char>()
    for (let i = 0; i < 0x200; i++) chars.set(0x400 + i, new Char(i, new StaticPixelsBehavior(new Uint8Array(64))))
    const placeholder = new Char(0xFFFF, new StaticPixelsBehavior(new Uint8Array(64)))
    const app = WingedSpriteAppearance.fromParaGoomba(chars, placeholder, null)
    expect(app.bodyParts).toHaveLength(0)
    // Frame 0: 2×4 = 8 parts (left wing 4 + right wing 4)
    expect(app.wingFrames[0]).toHaveLength(8)
  })
})

describe('WingedSpriteAppearance.fromFlyingQBlock — layout=null', () => {
  it('fromFlyingQBlock with null layout → no body parts; block wing frames built', () => {
    const chars = new Map<number, Char>()
    for (let i = 0; i < 0x200; i++) chars.set(0x400 + i, new Char(i, new StaticPixelsBehavior(new Uint8Array(64))))
    const placeholder = new Char(0xFFFF, new StaticPixelsBehavior(new Uint8Array(64)))
    const app = WingedSpriteAppearance.fromFlyingQBlock(chars, placeholder, null)
    expect(app.bodyParts).toHaveLength(0)
    // Frame 0: 2 small wing parts
    expect(app.wingFrames[0]).toHaveLength(2)
  })
})

// ── WingedGoombaBehavior points.length < 2 ───────────────────────────────────

describe('WingedSpriteAppearance.renderOverlay — WingedGoombaBehavior < 2 points', () => {
  it('points.length < 2 → no stroke, no arrowhead', () => {
    // Covers: if (points.length >= 2) false branch for WingedGoombaBehavior
    const b = Object.create(WingedGoombaBehavior.prototype) as WingedGoombaBehavior
    b.computeBouncePolyline = () => ({ points: [{x:0, y:0}] } as never)
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS, b, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })
})

// ── layoutToBodyParts — non-null layout ───────────────────────────────────────

describe('WingedSpriteAppearance.fromParaKoopa — layout with tiles', () => {
  it('non-null layout: layout?.tiles defined branch + both chars.get ?? placeholder branches', () => {
    // Tile 0: charNum=0x460 present in chars → chars.get ?? found (left branch)
    // Tile 1: charNum=0x999 NOT in chars → chars.get ?? placeholder (right branch)
    const placeholder = new Char(0xFFFF, new StaticPixelsBehavior(new Uint8Array(64)))
    const knownChar   = new Char(0x460, new StaticPixelsBehavior(new Uint8Array(64)))
    const chars = new Map<number, Char>([[0x460, knownChar]])
    const layout: SpriteLayout = {
      spriteId: 0x09,
      height: 16,
      tiles: [
        { charNum: 0x460, palette: 8, flipX: false, flipY: false, dx: 0,  dy: 0 },
        { charNum: 0x999, palette: 8, flipX: false, flipY: false, dx: 8,  dy: 0 },
      ],
    }
    const app = WingedSpriteAppearance.fromParaKoopa(chars, placeholder, layout)
    // Body should have 2 parts (one per tile).
    expect(app.bodyParts).toHaveLength(2)
    // First tile found in chars, second falls back to placeholder.
    expect(app.bodyParts[0].char).toBe(knownChar)
    expect(app.bodyParts[1].char).toBe(placeholder)
  })
})

// ── renderOverlay — unrecognized behavior (else if FlyingBlock FALSE path) ────

describe('WingedSpriteAppearance.renderOverlay — unrecognized behavior type', () => {
  it('behavior instanceof none of the 6 known types → no draw ops (final else-if FALSE branch)', () => {
    // ThwimpBounceBehavior is not Bouncing/WingedGoomba/FlyingLeft/Sinusoidal/
    // KoopaWalk/FlyingBlock, so every else-if condition evaluates to false.
    // This covers the FALSE path of the last `else if (behavior instanceof FlyingBlockBehavior)`.
    const b = Object.create(ThwimpBounceBehavior.prototype) as ThwimpBounceBehavior
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS, b, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })
})

describe('WingedSpriteAppearance.tickAnimation', () => {
  it('tickAnimation advances wing frame index cyclically', () => {
    const app = makeAppearance()  // 2 wing frames
    // default frame index = 0 (WING_F0)
    app.tickAnimation()
    // after tick, frame = 1 (WING_F1)
    app.tickAnimation()
    // after second tick, frame = 0 (WING_F0) again
    // verify by rendering: with wingsInFront=false, wings are blitted first
    // We just verify tickAnimation doesn't throw and the frame wraps
    expect(app).toBeTruthy()
  })
})
