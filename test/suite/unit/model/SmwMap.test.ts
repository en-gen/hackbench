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
import { L2ObjectStream, type L2Layer } from '../../../../src/rom/model/L2Layer'
import { L3Layer } from '../../../../src/rom/model/L3Layer'
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

interface StubSprite {
  id: number
  x: number
  y: number
  appearance: {
    render: (t: RenderTarget, x: number, y: number, b: unknown, ms: MapStore) => void
    renderAboveL1?: (t: RenderTarget, x: number, y: number, b: unknown, ms: MapStore) => void
  }
  behavior: { kind: string }
  /** The pass this sprite composites in. See SpritePriorityLoader. */
  priority: { value: number; source: 'level' }
  render: (t: RenderTarget, ms: MapStore) => void
  renderAboveL1: (t: RenderTarget, ms: MapStore) => void
}

/**
 * Minimal stand-in for a real `Sprite`. `aboveChar` opts the stub into the
 * second pixel pass (`SmwMap.render`'s above-L1 sprite loop); omit it for a
 * sprite that only draws in the normal pass.
 */
function makeStubSprite(bodyChar: Char, aboveChar?: Char): Sprite {
  const stub: StubSprite = {
    id: 0,
    x: 0,
    y: 0,
    priority: { value: 2, source: 'level' },   // OBJ.2, the common case
    appearance: {
      render: (t, x, y, _b, ms) => {
        t.blit8x8(bodyChar.getPixels(), { x, y }, ms.palette.row(0), false, false)
      },
    },
    behavior: { kind: 'stub' },
    render(t, ms) {
      this.appearance.render(t, this.x, this.y, this.behavior, ms)
    },
    renderAboveL1(t, ms) {
      this.appearance.renderAboveL1?.(t, this.x, this.y, this.behavior, ms)
    },
  }
  if (aboveChar) {
    stub.appearance.renderAboveL1 = (t, x, y, _b, ms) => {
      t.blit8x8(aboveChar.getPixels(), { x, y }, ms.palette.row(0), false, false)
    }
  }
  return stub as unknown as Sprite
}

/** Minimal L3 layer that blits one identifiable char, for ordering tests. */
function makeStubL3(char: Char): L3Layer {
  return new class extends L3Layer {
    render(t: RenderTarget, ms: MapStore): void {
      t.blit8x8(char.getPixels(), { x: 0, y: 0 }, ms.palette.row(0), false, false)
    }
    // Priority only. Both call sites exercise where the L3 PRIORITY pass
    // sits relative to the above-L1 annotation pass; claiming nonPriority
    // too would put a second L3 draw at the back of the order and change
    // what those tests are measuring.
    phases(): Set<Phase> { return new Set<Phase>(['priority']) }
  }()
}

/**
 * `SmwMap` takes 14 positional arguments, five of which every test in
 * this file passes the same placeholder for. Spelling them out per test
 * buried the one or two that actually varied.
 */
function makeMap(opts: {
  l1?:            (number | null)[][]
  l2?:            L2Layer | null
  l3?:            L3Layer | null
  sprites?:       Sprite[]
  l1Tiles?:       Map<number, Tile>
  palette?:       Palette
  mapStore?:      MapStore
  layer3Priority?: boolean
}): SmwMap {
  const palette  = opts.palette  ?? makePalette()
  const mapStore = opts.mapStore ?? makeMapStore(palette)
  return new SmwMap(
    0,
    {
      mode: 0, music: 0, tileset: 0, orientation: 'horizontal',
      initialCameraYPx: 0, timeLimit: 0, marioStartPx: { x: 0, y: 0 },
      ...(opts.layer3Priority === undefined ? {} : { layer3Priority: opts.layer3Priority }),
    },
    opts.l1 ?? [[0]],
    opts.l2 ?? null,
    opts.l3 ?? null,
    opts.sprites ?? [],
    palette,
    0,
    1,
    [0],
    opts.l1Tiles ?? new Map(),
    new Map(),
    mapStore,
  )
}

describe('SmwMap.render', () => {
  beforeEach(resetEditorStore)

  it('draws tile subtiles at correct pixel positions', () => {
    const mock = new MockRenderTarget()
    const tile = makeStaticTile(0, makeQuad([10, 11, 12, 13], mock))
    const l1Tiles = new Map([[0, tile]])
    const palette = makePalette()
    const mapStore = makeMapStore(palette)
    const map = makeMap({ l1Tiles, palette, mapStore })

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
    const sprite = makeStubSprite(spriteChar)

    const palette = makePalette()
    const mapStore = makeMapStore(palette)
    const map = makeMap({ l2, sprites: [sprite], l1Tiles, palette, mapStore })
    map.render(mock)

    const charIds = mock.calls.filter((c): c is BlitCall => c.kind === 'blit').map(c => c.charId)

    // Expected order:
    // L2: [20, 21, 22, 23] (all non-priority)
    // L1 non-priority of l1Tile: [32, 33]
    // Sprite: [40]
    // L1 priority of l1Tile: [30, 31]
    expect(charIds).toEqual([20, 21, 22, 23, 32, 33, 40, 30, 31])
  })

  it('runs the above-L1 sprite pass AFTER L1 priority tiles', () => {
    // The buried-sprite lift ($4D/$4E Monty Mole). The normal sprite pass
    // still draws under the priority tiles; the second pass must land after
    // them or the lift buys nothing.
    const mock = new MockRenderTarget()
    const l1Tiles = new Map<number, Tile>()
    const priorityQuad: SubtileQuad = [
      new SubTile(makeCharWithPixels(30, mock), 0, false, false, true),
      new SubTile(makeCharWithPixels(31, mock), 0, false, false, true),
      new SubTile(makeCharWithPixels(32, mock), 0, false, false, false),
      new SubTile(makeCharWithPixels(33, mock), 0, false, false, false),
    ]
    l1Tiles.set(0, makeStaticTile(0, priorityQuad))

    const bodyChar  = makeCharWithPixels(40, mock)
    const aboveChar = makeCharWithPixels(41, mock)
    const sprite    = makeStubSprite(bodyChar, aboveChar)

    const palette  = makePalette()
    const mapStore = makeMapStore(palette)
    const map = makeMap({ sprites: [sprite], l1Tiles, palette, mapStore })
    map.render(mock)

    const charIds = mock.calls.filter((c): c is BlitCall => c.kind === 'blit').map(c => c.charId)
    // L1 non-priority [32,33] → sprite body [40] → L1 priority [30,31] → lift [41]
    expect(charIds).toEqual([32, 33, 40, 30, 31, 41])
  })

  it('skips the above-L1 sprite pass when the sprite layer is toggled off', () => {
    const mock = new MockRenderTarget()
    const l1Tiles = new Map<number, Tile>([[0, makeStaticTile(0, makeQuad([30, 31, 32, 33], mock))]])
    const sprite = makeStubSprite(makeCharWithPixels(40, mock), makeCharWithPixels(41, mock))
    const palette  = makePalette()
    const mapStore = makeMapStore(palette)
    const map = makeMap({ sprites: [sprite], l1Tiles, palette, mapStore })
    editorStore.setLayerToggles({ ...editorStore.layerToggles, sprites: false })
    map.render(mock)

    const charIds = mock.calls.filter((c): c is BlitCall => c.kind === 'blit').map(c => c.charId)
    expect(charIds).not.toContain(40)
    expect(charIds).not.toContain(41)
  })

  it('runs the above-L1 sprite pass BEFORE the L3 priority pass', () => {
    // SmwMap.render documents this ordering: an annotation is lifted over
    // layer 1 only, it is not promoted over the foreground BG. The
    // sibling ordering test builds with l3 = null and cannot see it.
    const mock = new MockRenderTarget()
    const l1Tiles = new Map<number, Tile>([[0, makeStaticTile(0, makeQuad([30, 31, 32, 33], mock))]])
    const sprite  = makeStubSprite(makeCharWithPixels(40, mock), makeCharWithPixels(41, mock))
    const map = makeMap({
      sprites: [sprite],
      l1Tiles,
      l3: makeStubL3(makeCharWithPixels(50, mock)),
      layer3Priority: true,
    })
    map.render(mock)

    const charIds = mock.calls.filter((c): c is BlitCall => c.kind === 'blit').map(c => c.charId)
    // L1 [30..33] -> sprite body [40] -> above-L1 annotation [41] -> L3 [50]
    expect(charIds).toEqual([30, 31, 32, 33, 40, 41, 50])
  })

  it('draws a non-priority L3 first, so the annotation lands on top of it', () => {
    // The other side of the same branch: layer3Priority = false puts L3
    // before everything, annotation included.
    const mock = new MockRenderTarget()
    const l1Tiles = new Map<number, Tile>([[0, makeStaticTile(0, makeQuad([30, 31, 32, 33], mock))]])
    const sprite  = makeStubSprite(makeCharWithPixels(40, mock), makeCharWithPixels(41, mock))
    const map = makeMap({
      sprites: [sprite],
      l1Tiles,
      l3: makeStubL3(makeCharWithPixels(50, mock)),
      layer3Priority: false,
    })
    map.render(mock)

    const charIds = mock.calls.filter((c): c is BlitCall => c.kind === 'blit').map(c => c.charId)
    expect(charIds).toEqual([50, 30, 31, 32, 33, 40, 41])
  })

  it('honors layer toggles', () => {
    const mock = new MockRenderTarget()
    const l2Tile = makeStaticTile(100, makeQuad([20, 21, 22, 23], mock))
    const l1Tile = makeStaticTile(0, makeQuad([30, 31, 32, 33], mock))
    const l1Tiles = new Map<number, Tile>([[0, l1Tile], [100, l2Tile]])
    const palette = makePalette()
    const mapStore = makeMapStore(palette)
    const map = makeMap({
      l2: new L2ObjectStream([[100]], l1Tiles), l1Tiles, palette, mapStore,
    })

    editorStore.setLayerToggles({
      ...editorStore.layerToggles,
      l1: false,
    })
    map.render(mock)

    const charIds = mock.calls.filter((c): c is BlitCall => c.kind === 'blit').map(c => c.charId)
    expect(charIds).toEqual([20, 21, 22, 23]) // only L2 drew
  })
})
