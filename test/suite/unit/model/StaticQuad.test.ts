/**
 * StaticQuadBehavior — always returns the same quad reference.
 *
 * The simplest tile behavior: wraps a fixed SubtileQuad and returns it
 * unchanged every frame, regardless of render context state. Used for
 * all non-special Map16 tiles after TileFactory's dispatch.
 */

import { describe, it, expect } from 'vitest'
import { computed, ref } from '@vue/reactivity'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { cellBoxOf, type RenderContext } from '../../../../src/rom/model/RenderTarget'

function mockCtx(): RenderContext {
  return {
    animFrame: ref(0),
    palAnimFrame: ref(0),
    pSwitchActive: ref(false),
    switchPalaceState: ref<readonly [boolean, boolean, boolean, boolean]>([false, false, false, false]),
    palette: null as never,
    camera: ref({ tileX: 0, tileY: 0, focused: false }),
    zoom: ref(1),
    layerToggles: ref({ l1: true, l2: true, l3: true, sprites: true, screens: true, block: true, mapGrid: false, l3Hud: false, surfaces: false, walls: false }),
  }
}

function makeQuad(): SubtileQuad {
  const sub = () => new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), 0, false, false, false)
  return [sub(), sub(), sub(), sub()]
}

describe('StaticQuadBehavior', () => {
  it('selectQuad returns the exact quad reference passed to the constructor', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    expect(b.selectQuad(mockCtx())).toBe(quad)
  })

  it('returns the same reference on every call', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    const ctx = mockCtx()
    const cell = cellBoxOf(0, 0)
    const q1 = b.selectQuad(ctx, cell)
    const q2 = b.selectQuad(ctx, cell)
    expect(q1).toBe(q2)
  })

  it('is invariant when animFrame changes', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    const ctx = mockCtx()
    ctx.animFrame.value = 42
    expect(b.selectQuad(ctx)).toBe(quad)
  })

  it('is invariant when pSwitchActive changes', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    const ctx = mockCtx()
    ctx.pSwitchActive.value = true
    expect(b.selectQuad(ctx)).toBe(quad)
  })

  it('is invariant when switchPalaceState changes', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    const ctx = mockCtx()
    ctx.switchPalaceState.value = [true, true, true, true]
    expect(b.selectQuad(ctx)).toBe(quad)
  })

  it('computed() wrapping selectQuad is never re-evaluated on ctx ref changes (no reactive reads)', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    const ctx = mockCtx()
    let evaluations = 0
    const reactive = computed(() => {
      evaluations++
      return b.selectQuad(ctx)
    })

    expect(reactive.value).toBe(quad)
    expect(evaluations).toBe(1)

    // Changing any ctx ref should NOT cause a recompute because
    // StaticQuadBehavior reads no refs — the computed stays warm.
    ctx.animFrame.value = 5
    ctx.pSwitchActive.value = true
    ctx.palAnimFrame.value = 3
    expect(reactive.value).toBe(quad)
    expect(evaluations).toBe(1)
  })

  it('stores the quad on the .quad property', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    expect(b.quad).toBe(quad)
  })
})
