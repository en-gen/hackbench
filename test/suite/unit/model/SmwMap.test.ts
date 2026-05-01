import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Color } from '../../../../src/rom/model/palette/Color'
import { Palette } from '../../../../src/rom/model/palette/Palette'
import { StaticColorBehavior } from '../../../../src/rom/model/palette/behaviors/StaticColorBehavior'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { Tile, type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { L2ObjectStream } from '../../../../src/rom/model/L2Layer'
import type { Sprite } from '../../../../src/rom/model/sprites/Sprite'
import { SmwMap } from '../../../../src/rom/model/SmwMap'
import type { MapStore } from '../../../../src/rom/model/stores/mapStore'
import type {
  PixelPos,
  PixelSize,
  RenderTarget,
} from '../../../../src/rom/model/RenderTarget'
import { editorStore, makeTestMapStore, resetEditorStore } from '../fixtures/stores'

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
  const char = new Char(id, new StaticPixelsBehavior(pixels))
  mock.registerChar(char, pixels)
  return char
}

function makeStaticTile(id: number, quad: SubtileQuad): Tile {
  return new Tile(id, new StaticQuadBehavior(quad))
}

function makeQuad(chars: [number, number, number, number], mock: MockRenderTarget, priority = false): SubtileQuad {
  return [
    new SubTile(makeCharWithPixels(chars[0], mock), 0, false, false, priority),
    new SubTile(makeCharWithPixels(chars[1], mock), 0, false, false, priority),
    new SubTile(makeCharWithPixels(chars[2], mock), 0, false, false, priority),
    new SubTile(makeCharWithPixels(chars[3], mock), 0, false, false, priority),
  ]
}

function makePalette(): Palette {
  const black: RgbaColor = [0, 0, 0, 255]
  const cells: Color[][] = Array.from({ length: 16 }, () =>
    Array.from({ length: 16 }, () => new Color(new StaticColorBehavior(black))),
  )
  return new Palette(cells, new Color(new StaticColorBehavior(black)))
}

function makeMapStore(palette: Palette = makePalette()): MapStore {
  return makeTestMapStore({ palette, levelOrientation: 'horizontal', screenPipeVariantIdx: [0] })
}

describe('SmwMap.render', () => {
  beforeEach(resetEditorStore)

  it('draws tile subtiles at correct pixel positions', () => {
    const mock = new MockRenderTarget()
    const tile = makeStaticTile(0, makeQuad([10, 11, 12, 13], mock))
    const l1Tiles = new Map([[0, tile]])
    const palette = makePalette()
    const mapStore = makeMapStore(palette)
    const map = new SmwMap(
      0,
      {
        mode: 0, music: 0, tileset: 0, orientation: 'horizontal',
        initialCameraYPx: 0, timeLimit: 0, marioStartPx: { x: 0, y: 0 },
      },
      [[0]],
      null,
      null,
      [],
      palette,
      0,
      1,
      [0],
      l1Tiles,
      new Map(),
      mapStore,
    )

    map.render(mock)

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
    interface StubSprite {
      id: number
      x: number
      y: number
      appearance: { render: (t: RenderTarget, x: number, y: number, b: unknown, ms: MapStore) => void }
      behavior: { kind: string }
      render: (t: RenderTarget, ms: MapStore) => void
    }
    const stubSprite: StubSprite = {
      id: 0,
      x: 0,
      y: 0,
      appearance: {
        render: (t, x, y, _b, ms) => {
          t.blit8x8(spriteChar.getPixels(), { x, y }, ms.palette.row(0), false, false)
        },
      },
      behavior: { kind: 'stub' },
      render(t, ms) {
        this.appearance.render(t, this.x, this.y, this.behavior, ms)
      },
    }
    const sprite = stubSprite as unknown as Sprite

    const palette = makePalette()
    const mapStore = makeMapStore(palette)
    const map = new SmwMap(
      0,
      {
        mode: 0, music: 0, tileset: 0, orientation: 'horizontal',
        initialCameraYPx: 0, timeLimit: 0, marioStartPx: { x: 0, y: 0 },
      },
      [[0]],
      l2,
      null,
      [sprite],
      palette,
      0,
      1,
      [0],
      l1Tiles,
      new Map(),
      mapStore,
    )
    map.render(mock)

    const charIds = mock.calls.filter((c): c is BlitCall => c.kind === 'blit').map(c => c.charId)

    // Expected order:
    // L2: [20, 21, 22, 23] (all non-priority)
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
    const palette = makePalette()
    const mapStore = makeMapStore(palette)
    const map = new SmwMap(
      0,
      {
        mode: 0, music: 0, tileset: 0, orientation: 'horizontal',
        initialCameraYPx: 0, timeLimit: 0, marioStartPx: { x: 0, y: 0 },
      },
      [[0]],
      new L2ObjectStream([[100]], l1Tiles),
      null,
      [],
      palette,
      0,
      1,
      [0],
      l1Tiles,
      new Map(),
      mapStore,
    )

    editorStore.setLayerToggles({
      ...editorStore.layerToggles,
      l1: false,
    })
    map.render(mock)

    const charIds = mock.calls.filter((c): c is BlitCall => c.kind === 'blit').map(c => c.charId)
    expect(charIds).toEqual([20, 21, 22, 23]) // only L2 drew
  })
})
