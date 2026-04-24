/**
 * ThwompAppearance.render() — cursor proximity face selection.
 *
 * Source: ThwompGfx (bank_01.asm:6422) + InitThwomp (bank_01.asm:6316).
 * InitThwomp adds +8 to SpriteXPosLow at spawn. ThwompGfx then dispatches
 * on SpriteMisc1528: =2 → aggressive face, =1 → alert face, else → no face.
 *
 * In the editor we stand in for Mario with ctx.cursorPx. Detection logic:
 *   anchorX = x + 8  (the +8 is the InitThwomp shift)
 *   hdist   = |cursor.x - anchorX|
 *   inYRange = cursor.y ∈ [y, y + reactRangeDy)
 *
 *   face = inYRange && hdist ≤ 36 → aggressiveFace
 *        = inYRange && hdist ≤ 64 → alertFace
 *        = otherwise               → null (no face rendered)
 *
 * ALERT_PX      = 64   (SpriteMisc1528=1 threshold)
 * AGGRESSIVE_PX = 36   (SpriteMisc1528=2 threshold)
 * ANCHOR_DX     = 8    (InitThwomp +8 shift)
 */

import { describe, it, expect } from 'vitest'
import { ref } from '@vue/reactivity'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { ThwompAppearance } from '../../../../src/rom/model/sprites/appearances/ThwompAppearance'
import { partsHitRect, type SpritePart } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import type { RenderContext, RenderTarget, PixelPos } from '../../../../src/rom/model/RenderTarget'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'

const TRANSPARENT_ROW: RgbaColor[] = Array(16).fill([0, 0, 0, 0] as RgbaColor)

function mockCtx(cursor: { x: number; y: number } | null = null): RenderContext {
  return {
    animFrame: ref(0),
    palAnimFrame: ref(0),
    pSwitchActive: ref(false),
    switchPalaceState: ref<readonly [boolean, boolean, boolean, boolean]>([false, false, false, false]),
    palette: {
      row: () => TRANSPARENT_ROW,
      color: () => [0, 0, 0, 0] as RgbaColor,
      cells: [] as never,
      backAreaColor: null as never,
    } as never,
    camera: ref({ tileX: 0, tileY: 0, focused: false }),
    zoom: ref(1),
    layerToggles: ref({ l1: true, l2: true, l3: true, sprites: true, screens: true, block: true, mapGrid: false, l3Hud: false, surfaces: false, walls: false }),
    cursorPx: cursor !== null ? ref(cursor) : undefined,
  }
}

function makePart(dx = 0, dy = 0): SpritePart {
  return {
    char: new Char(0, new StaticPixelsBehavior(new Uint8Array(64))),
    palette: 0,
    flipX: false,
    flipY: false,
    dx,
    dy,
  }
}

function makeBehavior(reactRangeDy?: number): SpriteBehavior {
  return { reactRangeDy } as unknown as SpriteBehavior
}

interface BlitPos { x: number; y: number }

function capturingTarget() {
  const blits: BlitPos[] = []
  const target: RenderTarget = {
    blit8x8(_px, pos: PixelPos) { blits.push({ x: pos.x, y: pos.y }) },
    fillRect() {},
  }
  return { target, blits }
}

/** Build a ThwompAppearance with distinct, identifiable face and body parts. */
function makeThwomp() {
  const body  = [makePart(4, 0)]      // one body part
  const alert = [makePart(8, 8)]      // alert face at distinct offset
  const aggr  = [makePart(8, 8)]      // aggressive face at same offset
  return new ThwompAppearance(body, alert, aggr)
}

describe('ThwompAppearance — no cursor (no cursorPx)', () => {
  it('renders body parts only when cursorPx is absent', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    // 1 body part, no face → 1 blit
    app.render(mockCtx(null), target, 0, 0, makeBehavior(Infinity))
    expect(blits).toHaveLength(1)
    expect(blits[0]).toEqual({ x: 4, y: 0 }) // body part dx=4,dy=0
  })
})

describe('ThwompAppearance — face selection by hdist', () => {
  // Sprite at x=0, y=0. anchorX = 0+8 = 8.
  // reactRangeDy = Infinity so any cursor.y ≥ 0 is in range.

  it('hdist=0 (cursor at anchorX) → aggressive face', () => {
    // cursor.x=8, anchorX=8 → hdist=0 ≤ 36
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: 8, y: 0 }), target, 0, 0, makeBehavior(Infinity))
    // body (1) + aggressive face (1) = 2 blits
    expect(blits).toHaveLength(2)
  })

  it('hdist=36 (at aggressive boundary) → aggressive face', () => {
    // cursor.x = 8+36=44, hdist=36 ≤ 36
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: 44, y: 0 }), target, 0, 0, makeBehavior(Infinity))
    expect(blits).toHaveLength(2)
  })

  it('hdist=37 (just past aggressive) → alert face', () => {
    // cursor.x = 8+37=45, hdist=37 > 36 but ≤ 64
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: 45, y: 0 }), target, 0, 0, makeBehavior(Infinity))
    expect(blits).toHaveLength(2) // body + alert face
  })

  it('hdist=64 (at alert boundary) → alert face', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: 72, y: 0 }), target, 0, 0, makeBehavior(Infinity)) // 8+64=72
    expect(blits).toHaveLength(2)
  })

  it('hdist=65 (just past alert) → no face, body only', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: 73, y: 0 }), target, 0, 0, makeBehavior(Infinity))
    expect(blits).toHaveLength(1)
  })

  it('works symmetrically on the left side: hdist=36 left of anchor', () => {
    // cursor.x = 8-36 = -28, hdist=36 ≤ 36 → aggressive
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: -28, y: 0 }), target, 0, 0, makeBehavior(Infinity))
    expect(blits).toHaveLength(2)
  })
})

describe('ThwompAppearance — inYRange gating', () => {
  // Sprite at x=0, y=100. reactRangeDy=32 → y ∈ [100, 132).

  it('cursor above sprite (y < spriteY) → no face even when hdist=0', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: 8, y: 99 }), target, 0, 100, makeBehavior(32))
    expect(blits).toHaveLength(1) // body only
  })

  it('cursor at spriteY (y = spriteY, top of range) → aggressive face', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: 8, y: 100 }), target, 0, 100, makeBehavior(32))
    expect(blits).toHaveLength(2)
  })

  it('cursor at y = spriteY + reactRangeDy - 1 (last valid row) → aggressive face', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: 8, y: 131 }), target, 0, 100, makeBehavior(32))
    expect(blits).toHaveLength(2)
  })

  it('cursor at y = spriteY + reactRangeDy (exclusive upper bound) → no face', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: 8, y: 132 }), target, 0, 100, makeBehavior(32))
    expect(blits).toHaveLength(1)
  })

  it('reactRangeDy=undefined treated as Infinity: any y below sprite is in range', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    app.render(mockCtx({ x: 8, y: 999999 }), target, 0, 0, makeBehavior(undefined))
    expect(blits).toHaveLength(2)
  })
})

describe('ThwompAppearance — hitRect', () => {
  it('hitRect is the bounding box of body + alertFace combined', () => {
    // body at (4,0), alertFace at (8,8): x0=4, x1=16, y0=0, y1=16 → w=12, h=16
    const body  = [makePart(4, 0)]
    const alert = [makePart(8, 8)]
    const aggr  = [makePart(8, 8)]
    const app = new ThwompAppearance(body, alert, aggr)
    expect(app.hitRect).toEqual(partsHitRect([...body, ...alert]))
  })
})
