/**
 * StaticSpriteAppearance + partsHitRect - unit tests.
 *
 * partsHitRect(parts): pure function, no ROM dependency.
 *   - Empty iterable → default { dx:0, dy:0, w:16, h:16 }
 *   - Single part at (dx, dy) → { dx, dy, w:8, h:8 }
 *   - Multiple parts → tightest bounding rect over all 8×8 tiles
 *   - Parts with negative dx/dy → rect extends into negative space
 *
 * StaticSpriteAppearance.render() passes through to blit8x8 for each part.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import {
  partsHitRect,
  StaticSpriteAppearance,
  type SpritePart,
} from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { RenderTarget, PixelPos } from '../../../../src/rom/model/RenderTarget'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import { makeTestMapStore, resetEditorStore } from '../fixtures/stores'

const TRANSPARENT_ROW: RgbaColor[] = Array(16).fill([0, 0, 0, 0] as RgbaColor)
const STUB_BEHAVIOR: SpriteBehavior = { displayName: 'stub', spawns: false } as never

function stubMapStore() {
  const palette = {
    row: () => TRANSPARENT_ROW,
    color: () => [0, 0, 0, 0] as RgbaColor,
    cells: [] as never,
    backAreaColor: null as never,
  } as unknown as Palette
  return makeTestMapStore({ palette })
}

function makePart(dx: number, dy: number): SpritePart {
  return {
    char: new Char(0, new StaticPixelsBehavior(new Uint8Array(64))),
    palette: 0,
    flipX: false,
    flipY: false,
    dx,
    dy,
  }
}

function capturingTarget() {
  const calls: Array<{ pos: PixelPos }> = []
  const target: RenderTarget = {
    blit8x8(_px, pos) {
      calls.push({ pos })
    },
    fillRect() {},
  }
  return { target, calls }
}

describe('partsHitRect - empty input', () => {
  it('empty array → default 16×16 at origin', () => {
    expect(partsHitRect([])).toEqual({ dx: 0, dy: 0, w: 16, h: 16 })
  })

  it('empty generator → default 16×16 at origin', () => {
    expect(partsHitRect((function* () {})())).toEqual({ dx: 0, dy: 0, w: 16, h: 16 })
  })
})

describe('partsHitRect - single part', () => {
  it('part at (0,0) → { dx:0, dy:0, w:8, h:8 }', () => {
    expect(partsHitRect([makePart(0, 0)])).toEqual({ dx: 0, dy: 0, w: 8, h: 8 })
  })

  it('part at (4,8) → { dx:4, dy:8, w:8, h:8 }', () => {
    expect(partsHitRect([makePart(4, 8)])).toEqual({ dx: 4, dy: 8, w: 8, h: 8 })
  })

  it('part at (-4,-8) → { dx:-4, dy:-8, w:8, h:8 }', () => {
    expect(partsHitRect([makePart(-4, -8)])).toEqual({ dx: -4, dy: -8, w: 8, h: 8 })
  })
})

describe('partsHitRect - multiple parts', () => {
  it('two horizontally adjacent parts → width 16', () => {
    // Part at (0,0) and (8,0) → x0=0, x1=16, y0=0, y1=8
    expect(partsHitRect([makePart(0, 0), makePart(8, 0)])).toEqual({ dx: 0, dy: 0, w: 16, h: 8 })
  })

  it('two vertically stacked parts → height 16', () => {
    expect(partsHitRect([makePart(0, 0), makePart(0, 8)])).toEqual({ dx: 0, dy: 0, w: 8, h: 16 })
  })

  it('2×2 grid of parts → 16×16', () => {
    const parts = [makePart(0, 0), makePart(8, 0), makePart(0, 8), makePart(8, 8)]
    expect(partsHitRect(parts)).toEqual({ dx: 0, dy: 0, w: 16, h: 16 })
  })

  it('parts with varying offsets - bounding rect is tight', () => {
    // dx: -4, 4; dy: -8, 8 → x0=-4, x1=12, y0=-8, y1=16
    const parts = [makePart(-4, -8), makePart(4, 8)]
    expect(partsHitRect(parts)).toEqual({ dx: -4, dy: -8, w: 16, h: 24 })
  })

  it('asymmetric set: three parts', () => {
    // (0,0), (8,0), (0,16) → x0=0, x1=16, y0=0, y1=24
    const parts = [makePart(0, 0), makePart(8, 0), makePart(0, 16)]
    expect(partsHitRect(parts)).toEqual({ dx: 0, dy: 0, w: 16, h: 24 })
  })
})

describe('StaticSpriteAppearance - hitRect via constructor', () => {
  it('hitRect matches partsHitRect of the given parts', () => {
    const parts = [makePart(0, 0), makePart(8, 0)]
    const app = new StaticSpriteAppearance(parts)
    expect(app.hitRect).toEqual(partsHitRect(parts))
  })

  it('empty parts → default hitRect 16×16', () => {
    const app = new StaticSpriteAppearance([])
    expect(app.hitRect).toEqual({ dx: 0, dy: 0, w: 16, h: 16 })
  })
})

describe('StaticSpriteAppearance.render - blit calls', () => {
  beforeEach(resetEditorStore)

  it('calls blit8x8 once per part', () => {
    const app = new StaticSpriteAppearance([makePart(0, 0), makePart(8, 0), makePart(0, 8)])
    const { target, calls } = capturingTarget()
    app.render(target, 0, 0, STUB_BEHAVIOR, stubMapStore())
    expect(calls).toHaveLength(3)
  })

  it('translates sprite (x,y) + part (dx,dy) into the blit position', () => {
    const app = new StaticSpriteAppearance([makePart(4, 8)])
    const { target, calls } = capturingTarget()
    app.render(target, 100, 200, STUB_BEHAVIOR, stubMapStore())
    expect(calls[0].pos).toEqual({ x: 104, y: 208 })
  })

  it('zero parts produces zero blit calls', () => {
    const app = new StaticSpriteAppearance([])
    const { target, calls } = capturingTarget()
    app.render(target, 0, 0, STUB_BEHAVIOR, stubMapStore())
    expect(calls).toHaveLength(0)
  })
})
