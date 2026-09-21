/**
 * ThwompAppearance.render() - cursor proximity face selection.
 *
 * Source: ThwompGfx (bank_01.asm:6422) + InitThwomp (bank_01.asm:6316).
 * InitThwomp adds +8 to SpriteXPosLow at spawn. ThwompGfx then dispatches
 * on SpriteMisc1528: =2 → aggressive face, =1 → alert face, else → no face.
 *
 * In the editor we stand in for Mario with editorStore.cursorPx. Detection logic:
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

import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { ThwompAppearance } from '../../../../src/rom/model/sprites/appearances/ThwompAppearance'
import {
  partsHitRect,
  type SpritePart,
} from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { RenderTarget, PixelPos } from '../../../../src/rom/model/RenderTarget'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import { editorStore, makeTestMapStore, resetEditorStore } from '../fixtures/stores'

const TRANSPARENT_ROW: RgbaColor[] = Array(16).fill([0, 0, 0, 0] as RgbaColor)

function stubMapStore() {
  const palette = {
    row: () => TRANSPARENT_ROW,
    color: () => [0, 0, 0, 0] as RgbaColor,
    cells: [] as never,
    backAreaColor: null as never,
  } as unknown as Palette
  return makeTestMapStore({ palette })
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

interface BlitPos {
  x: number
  y: number
}

function capturingTarget() {
  const blits: BlitPos[] = []
  const target: RenderTarget = {
    blit8x8(_px, pos: PixelPos) {
      blits.push({ x: pos.x, y: pos.y })
    },
    fillRect() {},
  }
  return { target, blits }
}

/** Build a ThwompAppearance with distinct, identifiable face and body parts. */
function makeThwomp() {
  const body = [makePart(4, 0)] // one body part
  const alert = [makePart(8, 8)] // alert face at distinct offset
  const aggr = [makePart(8, 8)] // aggressive face at same offset
  return new ThwompAppearance(body, alert, aggr)
}

describe('ThwompAppearance - no cursor (no cursorPx)', () => {
  beforeEach(resetEditorStore)

  it('renders body parts only when cursorPx is null', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx(null)
    // 1 body part, no face → 1 blit
    app.render(target, 0, 0, makeBehavior(Infinity), stubMapStore())
    expect(blits).toHaveLength(1)
    expect(blits[0]).toEqual({ x: 4, y: 0 }) // body part dx=4,dy=0
  })
})

describe('ThwompAppearance - face selection by hdist', () => {
  beforeEach(resetEditorStore)

  // Sprite at x=0, y=0. anchorX = 0+8 = 8.
  // reactRangeDy = Infinity so any cursor.y ≥ 0 is in range.

  it('hdist=0 (cursor at anchorX) → aggressive face', () => {
    // cursor.x=8, anchorX=8 → hdist=0 ≤ 36
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: 8, y: 0 })
    app.render(target, 0, 0, makeBehavior(Infinity), stubMapStore())
    // body (1) + aggressive face (1) = 2 blits
    expect(blits).toHaveLength(2)
  })

  it('hdist=36 (at aggressive boundary) → aggressive face', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: 44, y: 0 })
    app.render(target, 0, 0, makeBehavior(Infinity), stubMapStore())
    expect(blits).toHaveLength(2)
  })

  it('hdist=37 (just past aggressive) → alert face', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: 45, y: 0 })
    app.render(target, 0, 0, makeBehavior(Infinity), stubMapStore())
    expect(blits).toHaveLength(2) // body + alert face
  })

  it('hdist=64 (at alert boundary) → alert face', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: 72, y: 0 })
    app.render(target, 0, 0, makeBehavior(Infinity), stubMapStore())
    expect(blits).toHaveLength(2)
  })

  it('hdist=65 (just past alert) → no face, body only', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: 73, y: 0 })
    app.render(target, 0, 0, makeBehavior(Infinity), stubMapStore())
    expect(blits).toHaveLength(1)
  })

  it('works symmetrically on the left side: hdist=36 left of anchor', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: -28, y: 0 })
    app.render(target, 0, 0, makeBehavior(Infinity), stubMapStore())
    expect(blits).toHaveLength(2)
  })
})

describe('ThwompAppearance - inYRange gating', () => {
  beforeEach(resetEditorStore)

  // Sprite at x=0, y=100. reactRangeDy=32 → y ∈ [100, 132).

  it('cursor above sprite (y < spriteY) → no face even when hdist=0', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: 8, y: 99 })
    app.render(target, 0, 100, makeBehavior(32), stubMapStore())
    expect(blits).toHaveLength(1) // body only
  })

  it('cursor at spriteY (y = spriteY, top of range) → aggressive face', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: 8, y: 100 })
    app.render(target, 0, 100, makeBehavior(32), stubMapStore())
    expect(blits).toHaveLength(2)
  })

  it('cursor at y = spriteY + reactRangeDy - 1 (last valid row) → aggressive face', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: 8, y: 131 })
    app.render(target, 0, 100, makeBehavior(32), stubMapStore())
    expect(blits).toHaveLength(2)
  })

  it('cursor at y = spriteY + reactRangeDy (exclusive upper bound) → no face', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: 8, y: 132 })
    app.render(target, 0, 100, makeBehavior(32), stubMapStore())
    expect(blits).toHaveLength(1)
  })

  it('reactRangeDy=undefined treated as Infinity: any y below sprite is in range', () => {
    const app = makeThwomp()
    const { target, blits } = capturingTarget()
    editorStore.setCursorPx({ x: 8, y: 999999 })
    app.render(target, 0, 0, makeBehavior(undefined), stubMapStore())
    expect(blits).toHaveLength(2)
  })
})

describe('ThwompAppearance - hitRect', () => {
  it('hitRect is the bounding box of body + alertFace combined', () => {
    // body at (4,0), alertFace at (8,8): x0=4, x1=16, y0=0, y1=16 → w=12, h=16
    const body = [makePart(4, 0)]
    const alert = [makePart(8, 8)]
    const aggr = [makePart(8, 8)]
    const app = new ThwompAppearance(body, alert, aggr)
    expect(app.hitRect).toEqual(partsHitRect([...body, ...alert]))
  })
})

// ---- renderOverlay ----------------------------------------------------------
// x=0,y=0: colStart=0, colEnd=2, startRow=2. Stop-line strokeRect = x=5, y=blockerRow*16+1.

describe('ThwompAppearance.fromTables - construction', () => {
  function makePlaceholder(): Char {
    return new Char(0, new StaticPixelsBehavior(new Uint8Array(64)))
  }

  it('empty chars → all parts use placeholder', () => {
    const ph = makePlaceholder()
    const app = ThwompAppearance.fromTables(new Map(), 8, 0, ph)
    const allParts = [...app.bodyParts, ...app.alertFace, ...app.aggressiveFace]
    expect(allParts.every(p => p.char === ph)).toBe(true)
  })

  it('right-column body entries (hFlip=true) produce flipX=true parts', () => {
    const ph = makePlaceholder()
    const app = ThwompAppearance.fromTables(new Map(), 8, 0, ph)
    const body = [...app.bodyParts]
    // bodyEntries: [left-top, right-top, left-bottom, right-bottom]; each → 4 parts
    // right-top (parts 4-7) and right-bottom (parts 12-15) have hFlip=true
    expect(body.slice(0, 4).every(p => p.flipX === false)).toBe(true) // left-top
    expect(body.slice(4, 8).every(p => p.flipX === true)).toBe(true) // right-top
    expect(body.slice(8, 12).every(p => p.flipX === false)).toBe(true) // left-bottom
    expect(body.slice(12, 16).every(p => p.flipX === true)).toBe(true) // right-bottom
  })

  it('face parts are never H-flipped', () => {
    const ph = makePlaceholder()
    const app = ThwompAppearance.fromTables(new Map(), 8, 0, ph)
    expect([...app.alertFace, ...app.aggressiveFace].every(p => p.flipX === false)).toBe(true)
  })
})
