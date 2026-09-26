/**
 * src/rom/render/BufferRenderTarget.ts (#421 step 2 round 3, design approved
 * on #421): a pure-core RenderTarget so the model's own render path
 * (Tile.render -> SubTile.render -> blit8x8) reaches the same composeTile
 * TileRenderer.renderMap16Tile uses. Pins that both give identical pixels
 * for the same Map16 tile data, flips and a priority split included.
 *
 * Effects (L3Layer's own flip) is out of scope; this covers only the
 * Foreground/Background 8x8 blit both paths share.
 */
import { describe, expect, it } from 'vitest'
import type { RgbaColor } from '../../../src/rom/GraphicsDecoder'
import type { Map16Tile, SubTile as Map16SubTile } from '../../../src/rom/Map16'
import { renderMap16Tile } from '../../../src/rom/TileRenderer'
import type { VramState } from '../../../src/rom/GfxLoader'
import { BufferRenderTarget } from '../../../src/rom/render/BufferRenderTarget'
import { Char } from '../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../src/rom/model/tiles/SubTile'
import { Tile } from '../../../src/rom/model/tiles/Tile'
import { StaticQuadBehavior } from '../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { cellBoxOf } from '../../../src/rom/model/RenderTarget'
import type { Palette } from '../../../src/rom/model/palette/Palette'
import { makeTestMapStore } from './fixtures/stores'

// Same ramp fixture as TileRendererAtlas.test.ts: index (y*8+x)%16, so a
// flip lands on a different, distinguishable value.
const RAMP = Array.from({ length: 64 }, (_, i) => i % 16)

const ROWS: RgbaColor[][] = [
  Array.from({ length: 16 }, (_, i) => [i, 0, 0, 255]),
  Array.from({ length: 16 }, (_, i) => [0, i, 0, 255]),
]

/** Quadrant descriptors exercising both flip axes and a priority split. */
const QUADS: Array<{ palette: number; flipX: boolean; flipY: boolean; priority: boolean }> = [
  { palette: 0, flipX: false, flipY: false, priority: false }, // TL
  { palette: 0, flipX: true, flipY: false, priority: false }, // TR
  { palette: 1, flipX: false, flipY: true, priority: true }, // BL
  { palette: 1, flipX: true, flipY: true, priority: true }, // BR
]

function map16Tile(): Map16Tile {
  const sub = (q: (typeof QUADS)[number]): Map16SubTile => ({
    charNum: 0,
    palette: q.palette,
    priority: q.priority,
    flipX: q.flipX,
    flipY: q.flipY,
  })
  return { id: 0, tl: sub(QUADS[0]), tr: sub(QUADS[1]), bl: sub(QUADS[2]), br: sub(QUADS[3]) }
}

function modelTile(): Tile {
  const char = new Char(0, new StaticPixelsBehavior(Uint8Array.from(RAMP)))
  const sub = (q: (typeof QUADS)[number]) =>
    new SubTile(char, q.palette, q.flipX, q.flipY, q.priority)
  return new Tile(0, new StaticQuadBehavior([sub(QUADS[0]), sub(QUADS[1]), sub(QUADS[2]), sub(QUADS[3])])) // prettier-ignore
}

describe('Tile.render through BufferRenderTarget matches renderMap16Tile', () => {
  it('gives identical RGBA pixels, flips and the priority split included', () => {
    const vram: VramState = { fg1: [Uint8Array.from(RAMP)] }
    const cgram = { colors: [...ROWS[0], ...ROWS[1]] }
    const expected = renderMap16Tile(map16Tile(), vram, cgram)

    const target = new BufferRenderTarget(16, 16)
    const palette = { row: (idx: number) => ROWS[idx] } as unknown as Palette
    const mapStore = makeTestMapStore({ palette })
    const tile = modelTile()
    const cell = cellBoxOf(0, 0)
    tile.render(target, cell, mapStore, 'nonPriority')
    tile.render(target, cell, mapStore, 'priority')

    expect(Buffer.from(target.buf)).toEqual(Buffer.from(expected))
  })
})
