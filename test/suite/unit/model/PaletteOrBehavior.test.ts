/**
 * PaletteOrBehavior - TileBehavior decorator that ORs each subtile's
 * palette field with a fixed mask. Mirrors SMW's L2 strip-render
 * `ORA #$1000` for tileset 3 (bank_05.asm:1463-1480).
 */

import { describe, it, expect } from 'vitest'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { PaletteOrBehavior } from '../../../../src/rom/model/tiles/behaviors/PaletteOrBehavior'
import { l2PaletteOrForTileset } from '../../../../src/rom/L2Loader'

function quadWithPalettes(palettes: readonly [number, number, number, number]): SubtileQuad {
  const sub = (pal: number) =>
    new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), pal, false, false, false)
  return [sub(palettes[0]), sub(palettes[1]), sub(palettes[2]), sub(palettes[3])]
}

const FAKE_CELL = { tl: { x: 0, y: 0 }, tr: { x: 8, y: 0 }, bl: { x: 0, y: 8 }, br: { x: 8, y: 8 } }
const FAKE_STORE = {} as never

describe('PaletteOrBehavior', () => {
  it('OR mask 4 turns palette 2 into palette 6 ($009 case)', () => {
    const inner = new StaticQuadBehavior(quadWithPalettes([2, 2, 2, 2]))
    const wrapped = new PaletteOrBehavior(inner, 4)
    const quad = wrapped.selectQuad(FAKE_CELL, FAKE_STORE)
    expect(quad.map(s => s.palette)).toEqual([6, 6, 6, 6])
  })

  it('OR mask 4 maps every palette correctly (0→4, 1→5, 2→6, 3→7, 4→4, 5→5, 6→6, 7→7)', () => {
    const cases: [number, number][] = [
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
      [4, 4],
      [5, 5],
      [6, 6],
      [7, 7],
    ]
    for (const [input, expected] of cases) {
      const inner = new StaticQuadBehavior(quadWithPalettes([input, input, input, input]))
      const wrapped = new PaletteOrBehavior(inner, 4)
      const quad = wrapped.selectQuad(FAKE_CELL, FAKE_STORE)
      expect(quad[0].palette).toBe(expected)
    }
  })

  it('preserves char, flip, priority - only palette changes', () => {
    const char = new Char(0x123, new StaticPixelsBehavior(new Uint8Array(64)))
    const sub = new SubTile(char, 2, true, false, true)
    const inner = new StaticQuadBehavior([sub, sub, sub, sub])
    const wrapped = new PaletteOrBehavior(inner, 4)
    const quad = wrapped.selectQuad(FAKE_CELL, FAKE_STORE)
    expect(quad[0].char).toBe(char)
    expect(quad[0].palette).toBe(6)
    expect(quad[0].flipX).toBe(true)
    expect(quad[0].flipY).toBe(false)
    expect(quad[0].priority).toBe(true)
  })

  it('returns the original SubTile reference when OR is a no-op (palette already has bit set)', () => {
    const sub = new SubTile(
      new Char(0, new StaticPixelsBehavior(new Uint8Array(64))),
      6,
      false,
      false,
      false,
    )
    const inner = new StaticQuadBehavior([sub, sub, sub, sub])
    const wrapped = new PaletteOrBehavior(inner, 4)
    const quad = wrapped.selectQuad(FAKE_CELL, FAKE_STORE)
    expect(quad[0]).toBe(sub)
  })

  it('does not expose selectAlpha/renderOverlay when inner has none', () => {
    const inner = new StaticQuadBehavior(quadWithPalettes([2, 2, 2, 2]))
    const wrapped = new PaletteOrBehavior(inner, 4)
    expect(wrapped.selectAlpha).toBeUndefined()
    expect(wrapped.renderOverlay).toBeUndefined()
  })

  it('forwards selectAlpha when inner provides it', () => {
    const inner = {
      selectQuad: () => quadWithPalettes([2, 2, 2, 2]),
      selectAlpha: () => 0.5,
    }
    const wrapped = new PaletteOrBehavior(inner, 4)
    expect(wrapped.selectAlpha?.(FAKE_CELL, FAKE_STORE)).toBe(0.5)
  })
})

describe('l2PaletteOrForTileset', () => {
  it('returns 4 for tileset 3 only', () => {
    expect(l2PaletteOrForTileset(0)).toBe(0)
    expect(l2PaletteOrForTileset(1)).toBe(0)
    expect(l2PaletteOrForTileset(2)).toBe(0)
    expect(l2PaletteOrForTileset(3)).toBe(4)
    expect(l2PaletteOrForTileset(4)).toBe(0)
    expect(l2PaletteOrForTileset(5)).toBe(0)
  })
})
