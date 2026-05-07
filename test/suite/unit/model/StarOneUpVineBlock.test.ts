/**
 * StarOneUpVineBlockBehavior — column-dispatch tests.
 *
 * Ports CODE_00F1AE (bank_00.asm:12868) via DATA_00F080[$09]=$81
 * (column-cycle, second-half offset) and DATA_00F100[16..31]:
 *
 *   (col % 16) % 3 === 0  →  sprite $76 (star)
 *   (col % 16) % 3 === 1  →  sprite $78 (1-up mushroom)
 *   (col % 16) % 3 === 2  →  sprite $79 (vine)
 *
 * TouchBlockXPos (direct page $9A) is the low byte of the block's
 * pixel X, so the lookup wraps every 16 tiles = 1 screen.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { CellBox, RenderTarget } from '../../../../src/rom/model/RenderTarget'
import {
  starOneUpVineItemAt,
  StarOneUpVineBlockBehavior,
} from '../../../../src/rom/model/tiles/behaviors/StarOneUpVineBlockBehavior'
import { editorStore, resetEditorStore, makeTestMapStore } from '../fixtures/stores'

function makeChar(): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64)))
}

function makeSub(): SubTile {
  return new SubTile(makeChar(), 0, false, false, false)
}

function makeQuad(): SubtileQuad {
  return [makeSub(), makeSub(), makeSub(), makeSub()]
}

describe('starOneUpVineItemAt — column dispatch (CODE_00F1AE)', () => {
  // (col % 16) % 3 === 0 → star ($76)
  it.each([0, 3, 6, 9, 12, 15])('col %i → star', (col) => {
    expect(starOneUpVineItemAt(col)).toBe('star')
  })

  // (col % 16) % 3 === 1 → 1up ($78)
  it.each([1, 4, 7, 10, 13])('col %i → 1up', (col) => {
    expect(starOneUpVineItemAt(col)).toBe('1up')
  })

  // (col % 16) % 3 === 2 → vine ($79)
  it.each([2, 5, 8, 11, 14])('col %i → vine', (col) => {
    expect(starOneUpVineItemAt(col)).toBe('vine')
  })

  it('col 16 wraps to same result as col 0 (star)', () => {
    expect(starOneUpVineItemAt(16)).toBe(starOneUpVineItemAt(0))
    expect(starOneUpVineItemAt(16)).toBe('star')
  })

  it('col 17 wraps to same result as col 1 (1up)', () => {
    expect(starOneUpVineItemAt(17)).toBe(starOneUpVineItemAt(1))
    expect(starOneUpVineItemAt(17)).toBe('1up')
  })

  it('col 18 wraps to same result as col 2 (vine)', () => {
    expect(starOneUpVineItemAt(18)).toBe(starOneUpVineItemAt(2))
    expect(starOneUpVineItemAt(18)).toBe('vine')
  })

  it('col 32 wraps to star (two full screens)', () => {
    expect(starOneUpVineItemAt(32)).toBe('star')
  })

  it('col 33 wraps to 1up', () => {
    expect(starOneUpVineItemAt(33)).toBe('1up')
  })
})

describe('StarOneUpVineBlockBehavior', () => {
  beforeEach(resetEditorStore)

  it('selectQuad returns the stored quad reference unchanged', () => {
    const quad = makeQuad()
    const b = new StarOneUpVineBlockBehavior(quad, null, [], [])
    expect(b.selectQuad()).toBe(quad)
  })

  it('itemAtCol matches starOneUpVineItemAt for all positions 0–18', () => {
    const b = new StarOneUpVineBlockBehavior(makeQuad(), null, [], [])
    for (let col = 0; col <= 18; col++) {
      expect(b.itemAtCol(col)).toBe(starOneUpVineItemAt(col))
    }
  })
})

// ── renderOverlay ────────────────────────────────────────────────────────────

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

/** Cell at tileX (each tile is 16 px wide). y=0. */
function makeCell(tileX: number): CellBox {
  const x = tileX * 16
  return { tl: { x, y: 0 }, tr: { x: x + 16, y: 0 }, bl: { x, y: 16 }, br: { x: x + 16, y: 16 } }
}

function makeBlitTarget() {
  const blits: Array<{ alpha: number | undefined }> = []
  const target: RenderTarget = {
    blit8x8(_p: Uint8Array, _pos: any, _row: any, _fx: boolean, _fy: boolean, alpha?: number) {
      blits.push({ alpha })
    },
    fillRect() {},
  }
  return { target, blits }
}

describe('StarOneUpVineBlockBehavior.renderOverlay — item dispatch', () => {
  beforeEach(resetEditorStore)

  it('col=2 (vine) with vineOverlayQuad → 4 blits (quad rendered)', () => {
    const b = new StarOneUpVineBlockBehavior(makeQuad(), makeQuad(), [], [])
    const { target, blits } = makeBlitTarget()
    b.renderOverlay(target, makeCell(2), stubMapStore())
    expect(blits).toHaveLength(4)
  })

  it('col=2 (vine) with vineOverlayQuad=null → 0 blits (skipped)', () => {
    const b = new StarOneUpVineBlockBehavior(makeQuad(), null, [], [])
    const { target, blits } = makeBlitTarget()
    b.renderOverlay(target, makeCell(2), stubMapStore())
    expect(blits).toHaveLength(0)
  })

  it('col=1 (1up) → drawCharsOverlay with oneupChars (4 blits)', () => {
    const ch = makeChar()
    const b = new StarOneUpVineBlockBehavior(makeQuad(), null, [ch, ch, ch, ch], [])
    const { target, blits } = makeBlitTarget()
    b.renderOverlay(target, makeCell(1), stubMapStore())
    expect(blits).toHaveLength(4)
  })

  it('col=0 (star) → drawCharsOverlay with starChars (4 blits)', () => {
    const ch = makeChar()
    const b = new StarOneUpVineBlockBehavior(makeQuad(), null, [], [ch, ch, ch, ch])
    const { target, blits } = makeBlitTarget()
    b.renderOverlay(target, makeCell(0), stubMapStore())
    expect(blits).toHaveLength(4)
  })

  it('null char in array → skip blit for that slot', () => {
    const ch = makeChar()
    const b = new StarOneUpVineBlockBehavior(makeQuad(), null, [ch, null, ch, ch], [])
    const { target, blits } = makeBlitTarget()
    b.renderOverlay(target, makeCell(1), stubMapStore())
    expect(blits).toHaveLength(3)
  })
})

describe('StarOneUpVineBlockBehavior.renderOverlay — indicatorAlpha', () => {
  beforeEach(resetEditorStore)

  // col=0 (star), cell at tl={x:0,y:0}, covers x=[0,16) y=[0,16)

  it('cursor null → alpha=0.5', () => {
    const ch = makeChar()
    const b = new StarOneUpVineBlockBehavior(makeQuad(), null, [], [ch, ch, ch, ch])
    const { target, blits } = makeBlitTarget()
    editorStore.setCursorPx(null)
    b.renderOverlay(target, makeCell(0), stubMapStore())
    expect(blits.every(bl => bl.alpha === 0.5)).toBe(true)
  })

  it('cursor inside cell → alpha=1.0', () => {
    const ch = makeChar()
    const b = new StarOneUpVineBlockBehavior(makeQuad(), null, [], [ch, ch, ch, ch])
    const { target, blits } = makeBlitTarget()
    editorStore.setCursorPx({ x: 8, y: 8 })  // inside [0,16)×[0,16)
    b.renderOverlay(target, makeCell(0), stubMapStore())
    expect(blits.every(bl => bl.alpha === 1.0)).toBe(true)
  })

  it('cursor outside cell (x) → alpha=0.5', () => {
    const ch = makeChar()
    const b = new StarOneUpVineBlockBehavior(makeQuad(), null, [], [ch, ch, ch, ch])
    const { target, blits } = makeBlitTarget()
    editorStore.setCursorPx({ x: 100, y: 8 })  // x outside [0,16)
    b.renderOverlay(target, makeCell(0), stubMapStore())
    expect(blits.every(bl => bl.alpha === 0.5)).toBe(true)
  })

  it('cursor outside cell (y) → alpha=0.5', () => {
    const ch = makeChar()
    const b = new StarOneUpVineBlockBehavior(makeQuad(), null, [], [ch, ch, ch, ch])
    const { target, blits } = makeBlitTarget()
    editorStore.setCursorPx({ x: 8, y: 100 })  // y outside [0,16)
    b.renderOverlay(target, makeCell(0), stubMapStore())
    expect(blits.every(bl => bl.alpha === 0.5)).toBe(true)
  })
})
