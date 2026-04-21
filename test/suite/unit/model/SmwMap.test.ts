import { describe, it, expect } from 'vitest'
import { ref } from '@vue/reactivity'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Color } from '../../../../src/rom/model/palette/Color'
import { Palette } from '../../../../src/rom/model/palette/Palette'
import { StaticColor } from '../../../../src/rom/model/palette/behaviors/StaticColor'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixels } from '../../../../src/rom/model/chars/behaviors/StaticPixels'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { Tile, type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { StaticQuad } from '../../../../src/rom/model/tiles/behaviors/StaticQuad'
import { L2ObjectStream } from '../../../../src/rom/model/L2Layer'
import type { Sprite } from '../../../../src/rom/model/sprites/Sprite'
import { SmwMap } from '../../../../src/rom/model/SmwMap'
import type {
  CellBox,
  PixelPos,
  PixelSize,
  RenderContext,
  RenderTarget,
} from '../../../../src/rom/model/RenderTarget'

interface BlitCall {
  kind: 'blit'
  posX: number
  posY: number
  charId: number
}

interface FillCall {
  kind: 'fill'
  posX: number
  posY: number
  w: number
  h: number
}

class MockRenderTarget implements RenderTarget {
  readonly calls: (BlitCall | FillCall)[] = []
  // Map pixel buffers back to char ids for easier assertions
  private readonly pixelsToCharId = new Map<Uint8Array, number>()

  registerChar(char: Char, pixels: Uint8Array): void {
    this.pixelsToCharId.set(pixels, char.id)
  }

  blit8x8(pixels: Uint8Array, pos: PixelPos, _row: RgbaColor[], _flipX: boolean, _flipY: boolean): void {
    this.calls.push({
      kind: 'blit',
      posX: pos.x,
      posY: pos.y,
      charId: this.pixelsToCharId.get(pixels) ?? -1,
    })
  }

  fillRect(pos: PixelPos, size: PixelSize, _color: RgbaColor): void {
    this.calls.push({ kind: 'fill', posX: pos.x, posY: pos.y, w: size.w, h: size.h })
  }
}

function makeCharWithPixels(id: number, mock: MockRenderTarget): Char {
  const pixels = new Uint8Array(64).fill(1) // non-zero so blits happen
  const char = new Char(id, new StaticPixels(pixels))
  mock.registerChar(char, pixels)
  return char
}

function makeStaticTile(id: number, quad: SubtileQuad): Tile {
  return new Tile(id, new StaticQuad(quad))
}

function makeQuad(chars: [number, number, number, number], mock: MockRenderTarget, priority = false): SubtileQuad {
  return [
    new SubTile(makeCharWithPixels(chars[0], mock), 0, false, false, priority),
    new SubTile(makeCharWithPixels(chars[1], mock), 0, false, false, priority),
    new SubTile(makeCharWithPixels(chars[2], mock), 0, false, false, priority),
    new SubTile(makeCharWithPixels(chars[3], mock), 0, false, false, priority),
  ]
}

function makeCtx(): RenderContext {
  const black: RgbaColor = [0, 0, 0, 255]
  const cells: Color[][] = Array.from({ length: 16 }, () =>
    Array.from({ length: 16 }, () => new Color(new StaticColor(black))),
  )
  const palette = new Palette(cells, new Color(new StaticColor(black)))
  return {
    animFrame: ref(0),
    palAnimFrame: ref(0),
    pSwitchActive: ref(false),
    switchPalaceState: ref<readonly [boolean, boolean, boolean, boolean]>([false, false, false, false]),
    palette,
    camera: ref({ tileX: 0, tileY: 0, focused: false }),
    zoom: ref(1),
    layerToggles: ref({ l1: true, l2: true, sprites: true, screens: true, block: true, mapGrid: false }),
  }
}

describe('SmwMap.render', () => {
  it('draws tile subtiles at correct pixel positions', () => {
    const mock = new MockRenderTarget()
    const tile = makeStaticTile(0, makeQuad([10, 11, 12, 13], mock))
    const l1Tiles = new Map([[0, tile]])
    const map = new SmwMap(
      0,
      { mode: 0, music: 0, tileset: 0, orientation: 'horizontal' },
      [[0]],
      null,
      [],
      makeCtx().palette,
      0,
      1,
      [0],
      l1Tiles,
      new Map(),
    )

    map.render(makeCtx(), mock)

    const blits = mock.calls.filter((c): c is BlitCall => c.kind === 'blit')
    // StaticTile has all non-priority subtiles -> all 4 blitted in non-priority phase
    expect(blits).toHaveLength(4)
    expect(blits[0]).toMatchObject({ posX: 0, posY: 0, charId: 10 })
    expect(blits[1]).toMatchObject({ posX: 8, posY: 0, charId: 11 })
    expect(blits[2]).toMatchObject({ posX: 0, posY: 8, charId: 12 })
    expect(blits[3]).toMatchObject({ posX: 8, posY: 8, charId: 13 })
  })

  it('respects layer render order: L2 -> L1 non-priority -> sprites -> L1 priority', () => {
    const mock = new MockRenderTarget()

    // L2 tile
    const l2Tile = makeStaticTile(100, makeQuad([20, 21, 22, 23], mock))
    const l1Tiles = new Map<number, Tile>()
    l1Tiles.set(100, l2Tile)
    const l2 = new L2ObjectStream([[100]], l1Tiles)

    // L1 mixed-priority tile: TL/TR priority=true, BL/BR priority=false
    const priorityQuad: SubtileQuad = [
      new SubTile(makeCharWithPixels(30, mock), 0, false, false, true),
      new SubTile(makeCharWithPixels(31, mock), 0, false, false, true),
      new SubTile(makeCharWithPixels(32, mock), 0, false, false, false),
      new SubTile(makeCharWithPixels(33, mock), 0, false, false, false),
    ]
    const l1Tile = makeStaticTile(0, priorityQuad)
    l1Tiles.set(0, l1Tile)

    // Sprite with a stub appearance that blits a single char
    const spriteChar = makeCharWithPixels(40, mock)
    const sprite: Sprite = {
      id: 0,
      x: 0,
      y: 0,
      appearance: {
        render: (ctx, t, x, y) => {
          t.blit8x8(spriteChar.getPixels(ctx), { x, y }, ctx.palette.row(0), false, false)
        },
      },
      behavior: { kind: 'stub' },
      render(ctx, t) {
        this.appearance.render(ctx, t, this.x, this.y)
      },
    } as unknown as Sprite

    const map = new SmwMap(
      0,
      { mode: 0, music: 0, tileset: 0, orientation: 'horizontal' },
      [[0]],
      l2,
      [sprite],
      makeCtx().palette,
      0,
      1,
      [0],
      l1Tiles,
      new Map(),
    )
    map.render(makeCtx(), mock)

    const charIds = mock.calls.filter((c): c is BlitCall => c.kind === 'blit').map(c => c.charId)

    // Expected order:
    // L2 non-priority + priority of L2 tile (both phases): [20, 21, 22, 23] (all non-priority)
    // L1 non-priority of l1Tile: [32, 33]
    // Sprite: [40]
    // L1 priority of l1Tile: [30, 31]
    expect(charIds).toEqual([20, 21, 22, 23, 32, 33, 40, 30, 31])
  })

  it('honors layer toggles', () => {
    const mock = new MockRenderTarget()
    const l2Tile = makeStaticTile(100, makeQuad([20, 21, 22, 23], mock))
    const l1Tile = makeStaticTile(0, makeQuad([30, 31, 32, 33], mock))
    const l1Tiles = new Map<number, Tile>([[0, l1Tile], [100, l2Tile]])
    const map = new SmwMap(
      0,
      { mode: 0, music: 0, tileset: 0, orientation: 'horizontal' },
      [[0]],
      new L2ObjectStream([[100]], l1Tiles),
      [],
      makeCtx().palette,
      0,
      1,
      [0],
      l1Tiles,
      new Map(),
    )

    const ctx = makeCtx()
    ctx.layerToggles.value = { ...ctx.layerToggles.value, l1: false }
    map.render(ctx, mock)

    const charIds = mock.calls.filter((c): c is BlitCall => c.kind === 'blit').map(c => c.charId)
    expect(charIds).toEqual([20, 21, 22, 23]) // only L2 drew
  })
})
