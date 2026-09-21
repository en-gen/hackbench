/**
 * KeyCoinBalloonKoopaBlockBehavior - branch coverage.
 * (src/rom/model/tiles/behaviors/KeyCoinBalloonKoopaBlockBehavior.ts)
 *
 * Test tree:
 *   tile25ItemAt - all 4 switch cases
 *   renderOverlay
 *     - cursor null → alpha=0.5
 *     - cursor inside cell → alpha=1.0
 *     - cursor outside (x) → alpha=0.5
 *     - cursor outside (y) → alpha=0.5
 *     - col%4==0 (key) → keyChars rendered
 *     - col%4==1 (redCoin) → redCoinChars rendered
 *     - col%4==2 (pBalloon) → pBalloonChars rendered
 *     - col%4==3 (paraKoopa) → paraKoopaChars rendered
 *     - null char in array → skip blit
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { CellBox, RenderTarget } from '../../../../src/rom/model/RenderTarget'
import type { SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import {
  tile25ItemAt,
  KeyCoinBalloonKoopaBlockBehavior,
} from '../../../../src/rom/model/tiles/behaviors/KeyCoinBalloonKoopaBlockBehavior'
import { editorStore, resetEditorStore, makeTestMapStore } from '../fixtures/stores'

// ── helpers ───────────────────────────────────────────────────────────────────

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

/** Cell whose col index equals `tileX` (tl.x = tileX * 16). */
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

/** Build a behavior with 4 non-null chars for every item type. */
function makeFullBehavior(): KeyCoinBalloonKoopaBlockBehavior {
  const ch = () => makeChar()
  const four = () => [ch(), ch(), ch(), ch()] as const
  return new KeyCoinBalloonKoopaBlockBehavior(makeQuad(), four(), four(), four(), four())
}

// ── tile25ItemAt ──────────────────────────────────────────────────────────────

describe('tile25ItemAt - column dispatch (CODE_028972)', () => {
  it('col%4==0 → key', () => expect(tile25ItemAt(0)).toBe('key'))
  it('col%4==1 → redCoin', () => expect(tile25ItemAt(1)).toBe('redCoin'))
  it('col%4==2 → pBalloon', () => expect(tile25ItemAt(2)).toBe('pBalloon'))
  it('col%4==3 → paraKoopa', () => expect(tile25ItemAt(3)).toBe('paraKoopa'))
  it('col=4 wraps to key', () => expect(tile25ItemAt(4)).toBe('key'))
  it('col=7 wraps to paraKoopa', () => expect(tile25ItemAt(7)).toBe('paraKoopa'))
})

// ── renderOverlay - item switch ───────────────────────────────────────────────

describe('KeyCoinBalloonKoopaBlockBehavior.renderOverlay - item dispatch', () => {
  beforeEach(resetEditorStore)

  it('col=0 (key) → renders keyChars (4 blits)', () => {
    const { target, blits } = makeBlitTarget()
    makeFullBehavior().renderOverlay(target, makeCell(0), stubMapStore())
    expect(blits).toHaveLength(4)
  })

  it('col=1 (redCoin) → renders redCoinChars (4 blits)', () => {
    const { target, blits } = makeBlitTarget()
    makeFullBehavior().renderOverlay(target, makeCell(1), stubMapStore())
    expect(blits).toHaveLength(4)
  })

  it('col=2 (pBalloon) → renders pBalloonChars (4 blits)', () => {
    const { target, blits } = makeBlitTarget()
    makeFullBehavior().renderOverlay(target, makeCell(2), stubMapStore())
    expect(blits).toHaveLength(4)
  })

  it('col=3 (paraKoopa) → renders paraKoopaChars (4 blits)', () => {
    const { target, blits } = makeBlitTarget()
    makeFullBehavior().renderOverlay(target, makeCell(3), stubMapStore())
    expect(blits).toHaveLength(4)
  })

  it('null char in array → skip blit for that slot', () => {
    const ch = makeChar()
    const b = new KeyCoinBalloonKoopaBlockBehavior(
      makeQuad(),
      [ch, null, ch, ch], // keyChars: 3 non-null + 1 null
      [ch, ch, ch, ch],
      [ch, ch, ch, ch],
      [ch, ch, ch, ch],
    )
    const { target, blits } = makeBlitTarget()
    b.renderOverlay(target, makeCell(0), stubMapStore()) // col=0 → key
    expect(blits).toHaveLength(3)
  })
})

// ── renderOverlay - indicatorAlpha ────────────────────────────────────────────

describe('KeyCoinBalloonKoopaBlockBehavior.renderOverlay - indicatorAlpha', () => {
  beforeEach(resetEditorStore)

  // col=0 (key), cell at tl={x:0,y:0}, covers x=[0,16) y=[0,16)

  it('cursor null → alpha=0.5', () => {
    const { target, blits } = makeBlitTarget()
    editorStore.setCursorPx(null)
    makeFullBehavior().renderOverlay(target, makeCell(0), stubMapStore())
    expect(blits.every(b => b.alpha === 0.5)).toBe(true)
  })

  it('cursor inside cell → alpha=1.0', () => {
    const { target, blits } = makeBlitTarget()
    editorStore.setCursorPx({ x: 8, y: 8 }) // inside [0,16)×[0,16)
    makeFullBehavior().renderOverlay(target, makeCell(0), stubMapStore())
    expect(blits.every(b => b.alpha === 1.0)).toBe(true)
  })

  it('cursor outside cell (x) → alpha=0.5', () => {
    const { target, blits } = makeBlitTarget()
    editorStore.setCursorPx({ x: 100, y: 8 }) // x outside [0,16)
    makeFullBehavior().renderOverlay(target, makeCell(0), stubMapStore())
    expect(blits.every(b => b.alpha === 0.5)).toBe(true)
  })

  it('cursor outside cell (y) → alpha=0.5', () => {
    const { target, blits } = makeBlitTarget()
    editorStore.setCursorPx({ x: 8, y: 100 }) // y outside [0,16)
    makeFullBehavior().renderOverlay(target, makeCell(0), stubMapStore())
    expect(blits.every(b => b.alpha === 0.5)).toBe(true)
  })
})
