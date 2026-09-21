/**
 * BranchCleanup - covers the remaining 1-3 branch misses across six
 * small model-layer files that can be exercised without a real ROM.
 *
 * Test tree:
 *   buildL2Tiles
 *     - paletteOrMask=0  → returns the same map reference (??-left branch)
 *     - paletteOrMask=4  → wraps every tile in PaletteOrBehavior (??-right branch)
 *   solidityFromL1 (MovementBehavior.ts)
 *     - cell with no collision → collision?.xxx ?? false right-side fires
 *   spriteCollisionFromL1 (SpriteCollision.ts)
 *     - cell with no collision → collision?.xxx ?? false right-side fires
 *       for solidH, solidV, ceilingV
 *   PaletteOrBehavior
 *     - inner with renderOverlay → forwarding branch (true branch)
 *   PipeVariantsBehavior
 *     - table[screenIdx] undefined → ?? 0 right-side fires
 *     - variants[variant] undefined → ?? variants[0] right-side fires
 *   InvisibleBlockRevealBehavior.renderOverlay
 *     - rewardOverlayQuad=null → early return branch
 *     - rewardOverlayQuad set → loop body executes
 */

import { describe, it, expect } from 'vitest'
import { buildL2Tiles } from '../../../../src/rom/model/L2Factory'
import { solidityFromL1 } from '../../../../src/rom/model/sprites/MovementBehavior'
import { spriteCollisionFromL1 } from '../../../../src/rom/model/sprites/SpriteCollision'
import { PaletteOrBehavior } from '../../../../src/rom/model/tiles/behaviors/PaletteOrBehavior'
import { PipeVariantsBehavior } from '../../../../src/rom/model/tiles/behaviors/PipeVariantsBehavior'
import { InvisibleBlockRevealBehavior } from '../../../../src/rom/model/tiles/behaviors/InvisibleBlockRevealBehavior'
import { Tile, type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { NO_COLLISION } from '../../../../src/rom/model/tiles/TileCollision'
import { Color } from '../../../../src/rom/model/palette/Color'
import { Palette } from '../../../../src/rom/model/palette/Palette'
import { StaticColorBehavior } from '../../../../src/rom/model/palette/behaviors/StaticColorBehavior'
import { cellBoxOf } from '../../../../src/rom/model/RenderTarget'
import type { L1Cell } from '../../../../src/rom/model/OverlayContext'
import { makeTestMapStore } from '../fixtures/stores'

// ── Shared primitive fixtures ─────────────────────────────────────────────────

const placeholder = new Char(-1, new StaticPixelsBehavior(new Uint8Array(64)))
const subTile0 = new SubTile(placeholder, 0, false, false, false)
const QUAD: SubtileQuad = [subTile0, subTile0, subTile0, subTile0]
const tile0 = new Tile(1, new StaticQuadBehavior(QUAD), 0, NO_COLLISION)
const L1_TILES = new Map([[1, tile0]])

function makeQuad(pal: number): SubtileQuad {
  const st = new SubTile(placeholder, pal, false, false, false)
  return [st, st, st, st]
}

const FAKE_CELL = { tl: { x: 0, y: 0 }, tr: { x: 8, y: 0 }, bl: { x: 0, y: 8 }, br: { x: 8, y: 8 } }
const FAKE_STORE = {} as never

// Minimal Palette for InvisibleBlockReveal tests (SubTile.render needs palette.row()).
const PALETTE = new Palette(
  Array.from({ length: 16 }, () =>
    Array.from(
      { length: 16 },
      () => new Color(new StaticColorBehavior({ r: 0, g: 0, b: 0, a: 255 })),
    ),
  ),
  new Color(new StaticColorBehavior({ r: 0, g: 0, b: 0, a: 255 })),
)

// ── buildL2Tiles ──────────────────────────────────────────────────────────────

describe('buildL2Tiles - paletteOrMask=0 early return', () => {
  it('returns the same map reference when mask is 0 (true branch of if-guard)', () => {
    // Covers: if (paletteOrMask === 0) return l1Tiles - true branch
    const result = buildL2Tiles(L1_TILES, 0)
    expect(result).toBe(L1_TILES)
  })
})

describe('buildL2Tiles - paletteOrMask nonzero wrapping', () => {
  it('wraps every tile in PaletteOrBehavior when mask is nonzero (false branch + loop)', () => {
    // Covers: if (paletteOrMask === 0) - false branch + for-of body executed
    const result = buildL2Tiles(L1_TILES, 4)
    expect(result).not.toBe(L1_TILES)
    expect(result.size).toBe(1)
    expect(result.get(1)?.behavior).toBeInstanceOf(PaletteOrBehavior)
  })
})

// ── solidityFromL1 - collision=undefined ─────────────────────────────────────

describe('solidityFromL1 - cell.collision undefined', () => {
  /** Cell that is non-priority but has no collision data attached. */
  const cellNoCollision: L1Cell = { id: 1, actsLike: 0x130 } // no collision property

  it('solidH returns false when collision is absent (??-right branch fires)', () => {
    // Covers: cell.collision?.wall ?? false - ?? right side (collision is undefined)
    const { solidH } = solidityFromL1((_c, _r) => cellNoCollision)
    expect(solidH(0, 0)).toBe(false)
  })

  it('solidV returns false when collision is absent (??-right branch fires)', () => {
    // Covers: cell.collision?.floor ?? false - ?? right side (collision is undefined)
    const { solidV } = solidityFromL1((_c, _r) => cellNoCollision)
    expect(solidV(0, 0)).toBe(false)
  })
})

// ── spriteCollisionFromL1 - collision=undefined ───────────────────────────────

describe('spriteCollisionFromL1 - cell.collision undefined', () => {
  /** Non-priority cell with no collision object. */
  const cellNoCollision: L1Cell = { id: 2, actsLike: 0x130 } // no collision property

  it('solidH returns false when collision is absent (??-right branch fires)', () => {
    // Covers: cell.collision?.wall ?? false - ?? right side
    const { solidH } = spriteCollisionFromL1((_c, _r) => cellNoCollision)
    expect(solidH(0, 0)).toBe(false)
  })

  it('solidV returns false when collision is absent (??-right branch fires)', () => {
    // Covers: cell.collision?.floor ?? false - ?? right side
    const { solidV } = spriteCollisionFromL1((_c, _r) => cellNoCollision)
    expect(solidV(0, 0)).toBe(false)
  })

  it('ceilingV returns false when collision is absent (??-right branch fires)', () => {
    // Covers: cell.collision?.ceiling ?? false - ?? right side
    const { ceilingV } = spriteCollisionFromL1((_c, _r) => cellNoCollision)
    expect(ceilingV(0, 0)).toBe(false)
  })
})

// ── PaletteOrBehavior - renderOverlay forwarding ──────────────────────────────

describe('PaletteOrBehavior - forwards renderOverlay when inner has it', () => {
  it('exposes renderOverlay and delegates to inner (true branch of if(inner.renderOverlay))', () => {
    // Covers: if (inner.renderOverlay) { this.renderOverlay = ... } - true branch
    let called = false
    const inner = {
      selectQuad: () => QUAD,
      renderOverlay: () => {
        called = true
      },
    }
    const wrapped = new PaletteOrBehavior(inner, 4)
    expect(wrapped.renderOverlay).toBeDefined()
    wrapped.renderOverlay!({} as RenderTarget, FAKE_CELL, FAKE_STORE)
    expect(called).toBe(true)
  })
})

// ── PipeVariantsBehavior - out-of-bounds ?? branches ─────────────────────────

describe('PipeVariantsBehavior - table index out of bounds', () => {
  it('table[screenIdx] is undefined → ?? 0 fires, falls back to variant 0', () => {
    // Covers: const variant = table[screenIdx] ?? 0 - ?? right side (undefined → 0)
    // table has only screen 0; a cell at tileCol=16 gives screenIdx=1 (undefined).
    // tileCol = Math.floor(cell.tl.x / 16) = cellBoxOf(tileX,y).tl.x/16 = tileX.
    // screenIdx = Math.floor(tileCol / 16) = Math.floor(16/16) = 1 → table[1]=undefined.
    const variants = [makeQuad(3), makeQuad(5)]
    const behavior = new PipeVariantsBehavior(variants)
    const mapStore = makeTestMapStore({
      screenPipeVariantIdx: [1], // only screen 0 wired; screen 1 is absent
      levelOrientation: 'horizontal',
    })
    // cellBoxOf(16,0) → tl.x=256 → tileCol=16 → screenIdx=1 → table[1]=undefined → ?? 0 → variant=0 → palette=3.
    expect(behavior.selectQuad(cellBoxOf(16, 0), mapStore)[0].palette).toBe(3)
  })

  it('variants[variant] is undefined → ?? variants[0] fires, falls back to variant 0', () => {
    // Covers: return this.variants[variant] ?? this.variants[0] - ?? right side
    // table[0]=99, but variants only has 1 entry → variants[99]=undefined → variants[0].
    const variants = [makeQuad(3)] // only variant 0 exists
    const behavior = new PipeVariantsBehavior(variants)
    const mapStore = makeTestMapStore({
      screenPipeVariantIdx: [99], // variant 99 → out of bounds
      levelOrientation: 'horizontal',
    })
    expect(behavior.selectQuad(cellBoxOf(0, 0), mapStore)[0].palette).toBe(3)
  })
})

// ── InvisibleBlockRevealBehavior.renderOverlay ────────────────────────────────

describe('InvisibleBlockRevealBehavior.renderOverlay - null quad', () => {
  it('returns immediately without drawing when rewardOverlayQuad is null', () => {
    // Covers: if (!this.rewardOverlayQuad) return - true branch (null → early return)
    const b = new InvisibleBlockRevealBehavior(QUAD, null)
    const mapStore = makeTestMapStore({ palette: PALETTE })
    // Should not throw and should produce no blit calls.
    let blitCalled = false
    const target: RenderTarget = {
      blit8x8: () => {
        blitCalled = true
      },
      fillRect: () => {},
    }
    b.renderOverlay(target, FAKE_CELL, mapStore)
    expect(blitCalled).toBe(false)
  })
})

describe('InvisibleBlockRevealBehavior.renderOverlay - quad present', () => {
  it('calls blit8x8 for each of the 4 subtiles when rewardOverlayQuad is set', () => {
    // Covers: if (!this.rewardOverlayQuad) return - false branch (non-null → loop executes)
    const rewardQuad: SubtileQuad = [
      new SubTile(placeholder, 0, false, false, false),
      new SubTile(placeholder, 0, false, false, false),
      new SubTile(placeholder, 0, false, false, false),
      new SubTile(placeholder, 0, false, false, false),
    ]
    const b = new InvisibleBlockRevealBehavior(QUAD, rewardQuad)
    const mapStore = makeTestMapStore({ palette: PALETTE })
    let blitCount = 0
    const target: RenderTarget = {
      blit8x8: () => {
        blitCount++
      },
      fillRect: () => {},
    }
    b.renderOverlay(target, cellBoxOf(0, 1), mapStore)
    // 4 subtiles, each calls blit8x8 once.
    expect(blitCount).toBe(4)
  })
})
