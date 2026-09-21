/**
 * VineSourceBehavior - selectQuad + renderOverlay tests.
 *
 * VineSourceBehavior is attached by TileFactory when a tile's acts-like
 * low byte is $2A or $2B (DATA_00F05C indices 25/26 = $03 → vine via
 * CODE_00C077). The behavior carries vine-source identity (instanceof
 * check) and draws an optional vine-icon overlay above the block.
 *
 * renderOverlay draw positions (from VineSourceBehavior source):
 *   subtile 0: (tl.x + 0, tl.y - 8)
 *   subtile 1: (tl.x + 8, tl.y - 8)
 *   subtile 2: (tl.x + 0, tl.y + 0)
 *   subtile 3: (tl.x + 8, tl.y + 0)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { VineSourceBehavior } from '../../../../src/rom/model/tiles/behaviors/VineSourceBehavior'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import { cellBoxOf, type RenderTarget, type PixelPos } from '../../../../src/rom/model/RenderTarget'
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

function makeChar(): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64)))
}

function makeSub(): SubTile {
  return new SubTile(makeChar(), 0, false, false, false)
}

function makeQuad(): SubtileQuad {
  return [makeSub(), makeSub(), makeSub(), makeSub()]
}

function capturingTarget() {
  const calls: Array<{ pos: PixelPos; alpha: number | undefined }> = []
  const target: RenderTarget = {
    blit8x8(_pixels, pos, _row, _fx, _fy, alpha) {
      calls.push({ pos, alpha })
    },
    fillRect() {},
  }
  return { target, calls }
}

describe('VineSourceBehavior - selectQuad', () => {
  beforeEach(resetEditorStore)

  it('returns the stored quad reference', () => {
    const quad = makeQuad()
    const b = new VineSourceBehavior(quad, null)
    expect(b.selectQuad()).toBe(quad)
  })
})

describe('VineSourceBehavior - renderOverlay with null overlayQuad', () => {
  beforeEach(resetEditorStore)

  it('produces zero blit8x8 calls when overlayQuad is null', () => {
    const b = new VineSourceBehavior(makeQuad(), null)
    const { target, calls } = capturingTarget()
    b.renderOverlay(target, cellBoxOf(0, 0), stubMapStore())
    expect(calls).toHaveLength(0)
  })
})

describe('VineSourceBehavior - renderOverlay with overlay quad', () => {
  beforeEach(resetEditorStore)

  const CELL_TX = 3 // tile column 3 → pixel x = 48
  const CELL_TY = 5 // tile row 5   → pixel y = 80
  const cell = cellBoxOf(CELL_TX, CELL_TY)
  const expectedPositions: PixelPos[] = [
    { x: CELL_TX * 16 + 0, y: CELL_TY * 16 - 8 },
    { x: CELL_TX * 16 + 8, y: CELL_TY * 16 - 8 },
    { x: CELL_TX * 16 + 0, y: CELL_TY * 16 + 0 },
    { x: CELL_TX * 16 + 8, y: CELL_TY * 16 + 0 },
  ]

  it('draws exactly 4 blit8x8 calls (one per overlay subtile)', () => {
    const b = new VineSourceBehavior(makeQuad(), makeQuad())
    const { target, calls } = capturingTarget()
    b.renderOverlay(target, cell, stubMapStore())
    expect(calls).toHaveLength(4)
  })

  it('places overlay subtiles at the correct 4 pixel offsets from cell TL', () => {
    const b = new VineSourceBehavior(makeQuad(), makeQuad())
    const { target, calls } = capturingTarget()
    b.renderOverlay(target, cell, stubMapStore())
    for (let i = 0; i < 4; i++) {
      expect(calls[i].pos).toEqual(expectedPositions[i])
    }
  })

  it('alpha is 0.5 when cursorPx is null (no cursor)', () => {
    const b = new VineSourceBehavior(makeQuad(), makeQuad())
    const { target, calls } = capturingTarget()
    editorStore.setCursorPx(null)
    b.renderOverlay(target, cell, stubMapStore())
    for (const call of calls) expect(call.alpha).toBe(0.5)
  })

  it('alpha is 0.5 when cursor is outside the cell', () => {
    const b = new VineSourceBehavior(makeQuad(), makeQuad())
    const { target, calls } = capturingTarget()
    // cursor at (0, 0) - far from cell at tile (3,5) = pixel (48,80)
    editorStore.setCursorPx({ x: 0, y: 0 })
    b.renderOverlay(target, cell, stubMapStore())
    for (const call of calls) expect(call.alpha).toBe(0.5)
  })

  it('alpha is 0.5 when cursor is exactly at cell.tl.x + 16 (right edge, exclusive)', () => {
    const b = new VineSourceBehavior(makeQuad(), makeQuad())
    const { target, calls } = capturingTarget()
    editorStore.setCursorPx({ x: cell.tl.x + 16, y: cell.tl.y })
    b.renderOverlay(target, cell, stubMapStore())
    for (const call of calls) expect(call.alpha).toBe(0.5)
  })

  it('alpha is 1.0 when cursor is inside the cell bounds', () => {
    const b = new VineSourceBehavior(makeQuad(), makeQuad())
    const { target, calls } = capturingTarget()
    editorStore.setCursorPx({ x: cell.tl.x + 8, y: cell.tl.y + 8 })
    b.renderOverlay(target, cell, stubMapStore())
    for (const call of calls) expect(call.alpha).toBe(1.0)
  })

  it('alpha is 1.0 when cursor is at cell top-left corner (inclusive)', () => {
    const b = new VineSourceBehavior(makeQuad(), makeQuad())
    const { target, calls } = capturingTarget()
    editorStore.setCursorPx({ x: cell.tl.x, y: cell.tl.y })
    b.renderOverlay(target, cell, stubMapStore())
    for (const call of calls) expect(call.alpha).toBe(1.0)
  })
})
