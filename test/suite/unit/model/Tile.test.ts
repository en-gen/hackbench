/**
 * Tile — render phase routing + renderOverlay delegation.
 *
 * Tile.render() selects subtiles from behavior.selectQuad() and routes
 * each to the correct render phase:
 *   subPhase = sub.priority ? 'priority' : 'nonPriority'
 *   only rendered when subPhase === phase argument
 *
 * Tile.renderOverlay() delegates to behavior.renderOverlay?() if present.
 */

import { describe, it, expect } from 'vitest'
import { ref } from '@vue/reactivity'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { Tile, type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { NO_COLLISION } from '../../../../src/rom/model/tiles/TileCollision'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { cellBoxOf, type CellBox, type RenderContext, type RenderTarget, type PixelPos } from '../../../../src/rom/model/RenderTarget'
import type { TileBehavior } from '../../../../src/rom/model/tiles/TileBehavior'

const TRANSPARENT_ROW: RgbaColor[] = Array(16).fill([0, 0, 0, 0] as RgbaColor)

function mockCtx(): RenderContext {
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
  }
}

function makeChar(): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64)))
}

function makeSub(priority: boolean): SubTile {
  return new SubTile(makeChar(), 0, false, false, priority)
}

function capturingTarget() {
  const calls: Array<{ pos: PixelPos; alpha: number | undefined }> = []
  const target: RenderTarget = {
    blit8x8(_pixels, pos, _row, _fx, _fy, alpha) { calls.push({ pos, alpha }) },
    fillRect() {},
  }
  return { target, calls }
}

describe('Tile — defaults', () => {
  it('actsLike defaults to id when not provided', () => {
    const t = new Tile(0x42, new StaticQuadBehavior([makeSub(false), makeSub(false), makeSub(false), makeSub(false)]))
    expect(t.actsLike).toBe(0x42)
  })

  it('collision defaults to NO_COLLISION (all false)', () => {
    const t = new Tile(1, new StaticQuadBehavior([makeSub(false), makeSub(false), makeSub(false), makeSub(false)]))
    expect(t.collision).toEqual(NO_COLLISION)
    expect(t.collision.floor).toBe(false)
    expect(t.collision.marioFloor).toBe(false)
    expect(t.collision.wall).toBe(false)
  })
})

describe('Tile.render — phase routing', () => {
  // Quad layout: TL=nonPriority, TR=nonPriority, BL=priority, BR=priority
  function makePhaseQuad(): SubtileQuad {
    return [
      makeSub(false), // TL — nonPriority
      makeSub(false), // TR — nonPriority
      makeSub(true),  // BL — priority
      makeSub(true),  // BR — priority
    ]
  }

  it('nonPriority phase: only priority=false subtiles call blit8x8', () => {
    const quad = makePhaseQuad()
    const tile = new Tile(1, new StaticQuadBehavior(quad))
    const ctx = mockCtx()
    const { target, calls } = capturingTarget()
    tile.render(ctx, target, cellBoxOf(0, 0), 'nonPriority')
    expect(calls).toHaveLength(2)
  })

  it('nonPriority phase: rendered positions are TL and TR', () => {
    const quad = makePhaseQuad()
    const tile = new Tile(1, new StaticQuadBehavior(quad))
    const cell = cellBoxOf(1, 2) // pixel (16, 32)
    const { target, calls } = capturingTarget()
    tile.render(mockCtx(), target, cell, 'nonPriority')
    expect(calls[0].pos).toEqual(cell.tl)
    expect(calls[1].pos).toEqual(cell.tr)
  })

  it('priority phase: only priority=true subtiles call blit8x8', () => {
    const quad = makePhaseQuad()
    const tile = new Tile(1, new StaticQuadBehavior(quad))
    const { target, calls } = capturingTarget()
    tile.render(mockCtx(), target, cellBoxOf(0, 0), 'priority')
    expect(calls).toHaveLength(2)
  })

  it('priority phase: rendered positions are BL and BR', () => {
    const quad = makePhaseQuad()
    const tile = new Tile(1, new StaticQuadBehavior(quad))
    const cell = cellBoxOf(1, 2)
    const { target, calls } = capturingTarget()
    tile.render(mockCtx(), target, cell, 'priority')
    expect(calls[0].pos).toEqual(cell.bl)
    expect(calls[1].pos).toEqual(cell.br)
  })

  it('all-nonPriority quad: priority phase produces zero blit calls', () => {
    const allNonPriority: SubtileQuad = [makeSub(false), makeSub(false), makeSub(false), makeSub(false)]
    const tile = new Tile(1, new StaticQuadBehavior(allNonPriority))
    const { target, calls } = capturingTarget()
    tile.render(mockCtx(), target, cellBoxOf(0, 0), 'priority')
    expect(calls).toHaveLength(0)
  })

  it('all-priority quad: nonPriority phase produces zero blit calls', () => {
    const allPriority: SubtileQuad = [makeSub(true), makeSub(true), makeSub(true), makeSub(true)]
    const tile = new Tile(1, new StaticQuadBehavior(allPriority))
    const { target, calls } = capturingTarget()
    tile.render(mockCtx(), target, cellBoxOf(0, 0), 'nonPriority')
    expect(calls).toHaveLength(0)
  })
})

describe('Tile.render — alpha forwarding', () => {
  it('passes alpha from behavior.selectAlpha?() to every sub.render()', () => {
    const quad: SubtileQuad = [makeSub(false), makeSub(false), makeSub(false), makeSub(false)]
    const behavior: TileBehavior = {
      selectQuad: () => quad,
      selectAlpha: () => 0.33,
    }
    const tile = new Tile(1, behavior)
    const { target, calls } = capturingTarget()
    tile.render(mockCtx(), target, cellBoxOf(0, 0), 'nonPriority')
    expect(calls).toHaveLength(4)
    for (const call of calls) expect(call.alpha).toBeCloseTo(0.33)
  })

  it('passes undefined alpha when behavior has no selectAlpha', () => {
    const quad: SubtileQuad = [makeSub(false), makeSub(false), makeSub(false), makeSub(false)]
    const behavior: TileBehavior = { selectQuad: () => quad }
    const tile = new Tile(1, behavior)
    const { target, calls } = capturingTarget()
    tile.render(mockCtx(), target, cellBoxOf(0, 0), 'nonPriority')
    for (const call of calls) expect(call.alpha).toBeUndefined()
  })
})

describe('Tile.renderOverlay — delegation', () => {
  it('delegates to behavior.renderOverlay when present', () => {
    let overlayCallCount = 0
    const quad: SubtileQuad = [makeSub(false), makeSub(false), makeSub(false), makeSub(false)]
    const behavior: TileBehavior = {
      selectQuad: () => quad,
      renderOverlay: () => { overlayCallCount++ },
    }
    const tile = new Tile(1, behavior)
    const { target } = capturingTarget()
    tile.renderOverlay(mockCtx(), target, cellBoxOf(0, 0))
    expect(overlayCallCount).toBe(1)
  })

  it('does not throw when behavior has no renderOverlay', () => {
    const quad: SubtileQuad = [makeSub(false), makeSub(false), makeSub(false), makeSub(false)]
    const behavior: TileBehavior = { selectQuad: () => quad }
    const tile = new Tile(1, behavior)
    const { target } = capturingTarget()
    expect(() => tile.renderOverlay(mockCtx(), target, cellBoxOf(0, 0))).not.toThrow()
  })

  it('passes ctx, target, and cell to renderOverlay', () => {
    const quad: SubtileQuad = [makeSub(false), makeSub(false), makeSub(false), makeSub(false)]
    const cell = cellBoxOf(2, 3)
    let capturedCell: CellBox | undefined
    const behavior: TileBehavior = {
      selectQuad: () => quad,
      renderOverlay: (_ctx, _target, c) => { capturedCell = c },
    }
    const tile = new Tile(1, behavior)
    const { target } = capturingTarget()
    tile.renderOverlay(mockCtx(), target, cell)
    expect(capturedCell).toEqual(cell)
  })
})
