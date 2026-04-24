/**
 * PSwitchAppearance — palette selection from pixel X position.
 *
 * Ports InitPSwitch (bank_01.asm:665):
 *   (SpriteXPosLow >> 4) & 1
 *     0 → PSwitchPal[0] = $06 → OBJ palette 3 → CGRAM row 11 (blue)
 *     1 → PSwitchPal[1] = $02 → OBJ palette 1 → CGRAM row 9  (silver)
 *
 * BLUE_PALETTE   = 8 + ((0x06 >> 1) & 0x07) = 8 + 3 = 11
 * SILVER_PALETTE = 8 + ((0x02 >> 1) & 0x07) = 8 + 1 = 9
 */

import { describe, it, expect } from 'vitest'
import { ref } from '@vue/reactivity'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { PSwitchAppearance } from '../../../../src/rom/model/sprites/appearances/PSwitchAppearance'
import type { SpritePart } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import type { RenderContext, RenderTarget } from '../../../../src/rom/model/RenderTarget'

function mockChar(): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64)))
}

function mockCtx(rowSpy: (idx: number) => RgbaColor[]): RenderContext {
  return {
    animFrame: ref(0),
    palAnimFrame: ref(0),
    pSwitchActive: ref(false),
    switchPalaceState: ref<readonly [boolean, boolean, boolean, boolean]>([false, false, false, false]),
    palette: {
      row: rowSpy,
      color: () => [0, 0, 0, 0] as RgbaColor,
      cells: [] as never,
      backAreaColor: null as never,
    } as never,
    camera: ref({ tileX: 0, tileY: 0, focused: false }),
    zoom: ref(1),
    layerToggles: ref({ l1: true, l2: true, l3: true, sprites: true, screens: true, block: true, mapGrid: false, l3Hud: false, surfaces: false, walls: false }),
  }
}

function nullTarget(): RenderTarget {
  return {
    blit8x8() {},
    fillRect() {},
  }
}

function makePart(dx = 0, dy = 0): SpritePart {
  return { char: mockChar(), palette: 0, flipX: false, flipY: false, dx, dy }
}

describe('PSwitchAppearance — static palette constants', () => {
  it('BLUE_PALETTE is 11 (OBJ pal $06 → 8 + ((0x06>>1)&7) = 8+3)', () => {
    expect(PSwitchAppearance.BLUE_PALETTE).toBe(11)
  })

  it('SILVER_PALETTE is 9 (OBJ pal $02 → 8 + ((0x02>>1)&7) = 8+1)', () => {
    expect(PSwitchAppearance.SILVER_PALETTE).toBe(9)
  })
})

describe('PSwitchAppearance.render — palette selection from x position', () => {
  // (x >> 4) & 1 === 0 → BLUE (11)
  // (x >> 4) & 1 === 1 → SILVER (9)

  function palettesUsedAt(x: number): number[] {
    const requested: number[] = []
    const app = new PSwitchAppearance([makePart()])
    app.render(mockCtx((idx) => { requested.push(idx); return [] }), nullTarget(), x, 0)
    return requested
  }

  it('x=0 (bit 4 = 0) → BLUE_PALETTE (11)', () => {
    expect(palettesUsedAt(0)).toContain(PSwitchAppearance.BLUE_PALETTE)
    expect(palettesUsedAt(0)).not.toContain(PSwitchAppearance.SILVER_PALETTE)
  })

  it('x=15 (bit 4 = 0) → BLUE_PALETTE (11)', () => {
    expect(palettesUsedAt(15)).toContain(PSwitchAppearance.BLUE_PALETTE)
  })

  it('x=16 (bit 4 = 1) → SILVER_PALETTE (9)', () => {
    expect(palettesUsedAt(16)).toContain(PSwitchAppearance.SILVER_PALETTE)
    expect(palettesUsedAt(16)).not.toContain(PSwitchAppearance.BLUE_PALETTE)
  })

  it('x=31 (bit 4 = 1) → SILVER_PALETTE (9)', () => {
    expect(palettesUsedAt(31)).toContain(PSwitchAppearance.SILVER_PALETTE)
  })

  it('x=32 (bit 4 = 0) → BLUE_PALETTE (11)', () => {
    expect(palettesUsedAt(32)).toContain(PSwitchAppearance.BLUE_PALETTE)
  })

  it('x=47 (47>>4=2, 2&1=0, bit 4 = 0) → BLUE_PALETTE (11)', () => {
    expect(palettesUsedAt(47)).toContain(PSwitchAppearance.BLUE_PALETTE)
  })

  it('x=48 (48>>4=3, 3&1=1, bit 4 = 1) → SILVER_PALETTE (9)', () => {
    expect(palettesUsedAt(48)).toContain(PSwitchAppearance.SILVER_PALETTE)
  })

  it('uses the same palette for all parts when multiple parts are present', () => {
    const requested: number[] = []
    const app = new PSwitchAppearance([makePart(0, 0), makePart(8, 0), makePart(0, 8)])
    app.render(mockCtx((idx) => { requested.push(idx); return [] }), nullTarget(), 0, 0)
    // x=0 → BLUE for all 3 parts
    expect(requested).toHaveLength(3)
    for (const idx of requested) expect(idx).toBe(PSwitchAppearance.BLUE_PALETTE)
  })
})

describe('PSwitchAppearance — hitRect', () => {
  it('hitRect is derived from the parts bounding box', () => {
    const app = new PSwitchAppearance([makePart(0, 0)])
    // single part at dx=0, dy=0 → x0=0, y0=0, x1=8, y1=8 → w=8, h=8
    expect(app.hitRect).toEqual({ dx: 0, dy: 0, w: 8, h: 8 })
  })

  it('hitRect is empty-safe (no parts → default 16x16)', () => {
    const app = new PSwitchAppearance([])
    expect(app.hitRect).toEqual({ dx: 0, dy: 0, w: 16, h: 16 })
  })
})
