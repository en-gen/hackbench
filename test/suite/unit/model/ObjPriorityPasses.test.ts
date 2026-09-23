/**
 * The compositor pass list, and the bug it fixes.
 *
 * Test tree:
 *   pass table   : ppuDrawOrder covers every (layer, priority) pair, in the
 *                  order docs/snes-superfamicom-selected.md:501-518 gives
 *   livePasses   : filters to occupied pairs, preserves PPU order
 *   the bug      : an OBJ.1 sprite draws UNDER a priority BG tile at the
 *                  same cell -- this is what the single-pass render got
 *                  wrong (docs/rom/obj-priority.md)
 *   layer 2 / 3  : both phases are real passes, not two calls in a row
 */

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
import { L2ObjectStream, L2Preset } from '../../../../src/rom/model/L2Layer'
import { L3TilemapLayer } from '../../../../src/rom/model/L3Layer'
import { L3_HUD_ROW_CUTOFF, L3_TILEMAP_COLS } from '../../../../src/rom/L3Loader'
import { Sprite } from '../../../../src/rom/model/sprites/Sprite'
import type { SpriteAppearance } from '../../../../src/rom/model/sprites/SpriteAppearance'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import { SmwMap } from '../../../../src/rom/model/SmwMap'
import { livePasses, ppuDrawOrder } from '../../../../src/rom/model/RenderPass'
import type { MapStore } from '../../../../src/rom/model/stores/mapStore'
import type { PixelPos, PixelSize, RenderTarget } from '../../../../src/rom/model/RenderTarget'
import { editorStore, makeTestMapStore, resetEditorStore } from '../fixtures/stores'
import type { ScrollSimulator } from '../../../../src/rom/scrollSim'

class OrderRecorder implements RenderTarget {
  readonly order: number[] = []
  private readonly ids = new Map<Uint8Array, number>()
  char(id: number): Char {
    const pixels = new Uint8Array(64).fill(1)
    this.ids.set(pixels, id)
    return new Char(id, new StaticPixelsBehavior(pixels))
  }
  blit8x8(pixels: Uint8Array, _p: PixelPos, _r: RgbaColor[], _fx: boolean, _fy: boolean): void {
    this.order.push(this.ids.get(pixels) ?? -1)
  }
  fillRect(_p: PixelPos, _s: PixelSize, _c: RgbaColor): void {}
}

function quad(
  t: OrderRecorder,
  ids: [number, number, number, number],
  priority: boolean,
): SubtileQuad {
  return ids.map(id => new SubTile(t.char(id), 0, false, false, priority)) as unknown as SubtileQuad
}

const tileOf = (id: number, q: SubtileQuad): Tile => new Tile(id, new StaticQuadBehavior(q))

function makePalette(): Palette {
  const black: RgbaColor = [0, 0, 0, 255]
  return new Palette(
    Array.from({ length: 16 }, () =>
      Array.from({ length: 16 }, () => new Color(new StaticColorBehavior(black))),
    ),
    new Color(new StaticColorBehavior(black)),
  )
}

/** A sprite that blits one char at its own origin, at OBJ priority `pri`. */
function spriteAt(t: OrderRecorder, charId: number, pri: number): Sprite {
  const char = t.char(charId)
  const appearance: SpriteAppearance = {
    hitRect: { dx: 0, dy: 0, w: 16, h: 16 },
    render: (target, x, y, _b, ms) => {
      target.blit8x8(char.getPixels(), { x, y }, ms.palette.row(0), false, false)
    },
  }
  const s = new Sprite(0, 0, 0, appearance, { kind: 'stub' } as unknown as SpriteBehavior)
  s.priority = { value: pri, source: 'handler' }
  return s
}

interface MapParts {
  l1?: (number | null)[][]
  l1Tiles?: Map<number, Tile>
  l2?: L2ObjectStream | L2Preset | null
  l3?: L3TilemapLayer | null
  sprites?: Sprite[]
  layer3Priority?: boolean
}

function buildMap(parts: MapParts, mapStore: MapStore, palette: Palette): SmwMap {
  return new SmwMap(
    0,
    {
      mode: 0,
      music: 0,
      tileset: 0,
      orientation: 'horizontal',
      layer3Priority: parts.layer3Priority ?? false,
      initialCameraYPx: 0,
      timeLimit: 0,
      marioStartPx: { x: 0, y: 0 },
    },
    parts.l1 ?? [[0]],
    parts.l2 ?? null,
    parts.l3 ?? null,
    parts.sprites ?? [],
    palette,
    0,
    1,
    [0],
    parts.l1Tiles ?? new Map(),
    new Map(),
    mapStore,
  )
}

describe('ppuDrawOrder', () => {
  it('lists every (layer, priority) pair mode 1 can show, once', () => {
    for (const bit of [false, true]) {
      const keys = ppuDrawOrder(bit).map(p => `${p.layer}.${p.priority}`)
      expect(new Set(keys).size).toBe(keys.length)
      expect(keys.sort()).toEqual([
        'l1.0',
        'l1.1',
        'l2.0',
        'l2.1',
        'l3.0',
        'l3.1',
        'sprites.0',
        'sprites.1',
        'sprites.2',
        'sprites.3',
      ])
    }
  })

  it('places OBJ.1 under both BG1 and BG2, and OBJ.3 over both', () => {
    // The whole point: a single sprite pass between "BG" and "foreground BG"
    // cannot express this. docs/snes-superfamicom-selected.md:505-514.
    for (const bit of [false, true]) {
      const at = (key: string): number =>
        ppuDrawOrder(bit).findIndex(p => `${p.layer}.${p.priority}` === key)
      expect(at('sprites.1')).toBeLessThan(at('l1.0'))
      expect(at('sprites.1')).toBeLessThan(at('l2.0'))
      expect(at('sprites.2')).toBeGreaterThan(at('l1.0'))
      expect(at('sprites.2')).toBeLessThan(at('l1.1'))
      expect(at('sprites.3')).toBeGreaterThan(at('l1.1'))
      expect(at('sprites.3')).toBeGreaterThan(at('l2.1'))
    }
  })

  it('moves BG3.1 with the header bit and leaves BG3.0 at the back', () => {
    const key = (p: { layer: string; priority: number }): string => `${p.layer}.${p.priority}`
    expect(ppuDrawOrder(true).map(key).at(-1)).toBe('l3.1')
    expect(ppuDrawOrder(false).map(key).at(-1)).toBe('sprites.3')
    for (const bit of [false, true]) expect(ppuDrawOrder(bit).map(key)[0]).toBe('l3.0')
  })
})

describe('livePasses', () => {
  const none = new Set<number>()
  it('keeps only occupied pairs and never reorders them', () => {
    const passes = livePasses(false, {
      l1: new Set([0, 1]),
      l2: none,
      l3: none,
      sprites: new Set([1, 2]),
    })
    expect(passes.map(p => `${p.layer}.${p.priority}`)).toEqual([
      'sprites.1',
      'l1.0',
      'sprites.2',
      'l1.1',
    ])
  })

  it('returns nothing for an empty level', () => {
    expect(livePasses(true, { l1: none, l2: none, l3: none, sprites: none })).toEqual([])
  })
})

describe('SmwMap composites by OBJ priority', () => {
  beforeEach(resetEditorStore)

  const setup = (): { t: OrderRecorder; palette: Palette; mapStore: MapStore } => {
    const t = new OrderRecorder()
    const palette = makePalette()
    return {
      t,
      palette,
      mapStore: makeTestMapStore({
        palette,
        levelOrientation: 'horizontal',
        screenPipeVariantIdx: [0],
      }),
    }
  }

  it('draws an OBJ.1 sprite UNDER a priority BG1 tile in the same cell', () => {
    // THE BUG. `ClassicPiranhas` lowers OBJ priority to 1
    // (bank_01.asm:2113-2114); at OBJ.1 the plant belongs beneath every BG1
    // and BG2 tile, not just the priority ones. The old fixed order --
    // L2, L1 non-priority, sprites, L1 priority -- put it above the
    // non-priority tiles, so this assertion fails on it.
    const { t, palette, mapStore } = setup()
    const l1Tiles = new Map([
      [0, tileOf(0, quad(t, [30, 31, 32, 33], true))], // priority subtiles
      [1, tileOf(1, quad(t, [40, 41, 42, 43], false))], // non-priority subtiles
    ])
    const map = buildMap(
      { l1: [[0, 1]], l1Tiles, sprites: [spriteAt(t, 99, 1)] },
      mapStore,
      palette,
    )

    map.render(t)

    expect(t.order[0]).toBe(99)
    expect(t.order).toEqual([99, 40, 41, 42, 43, 30, 31, 32, 33])
  })

  it('draws an OBJ.3 sprite OVER a priority BG1 tile in the same cell', () => {
    // The other end of the range, and the reason a single sprite pass is
    // wrong in both directions. bank_03.asm:4579-4580 raises to OBJ.3.
    const { t, palette, mapStore } = setup()
    const l1Tiles = new Map([[0, tileOf(0, quad(t, [30, 31, 32, 33], true))]])
    const map = buildMap({ l1: [[0]], l1Tiles, sprites: [spriteAt(t, 99, 3)] }, mapStore, palette)

    map.render(t)

    expect(t.order).toEqual([30, 31, 32, 33, 99])
  })

  it('keeps OBJ.2 between the two BG1 phases, as before', () => {
    // Regression guard: the default case must not move.
    const { t, palette, mapStore } = setup()
    const l1Tiles = new Map([
      [0, tileOf(0, quad(t, [30, 31, 32, 33], true))],
      [1, tileOf(1, quad(t, [40, 41, 42, 43], false))],
    ])
    const map = buildMap(
      { l1: [[0, 1]], l1Tiles, sprites: [spriteAt(t, 99, 2)] },
      mapStore,
      palette,
    )

    map.render(t)

    expect(t.order).toEqual([40, 41, 42, 43, 99, 30, 31, 32, 33])
  })

  it('orders three sprites at three OBJ priorities around the BG phases', () => {
    const { t, palette, mapStore } = setup()
    const l1Tiles = new Map([
      [0, tileOf(0, quad(t, [30, 31, 32, 33], true))],
      [1, tileOf(1, quad(t, [40, 41, 42, 43], false))],
    ])
    const map = buildMap(
      {
        l1: [[0, 1]],
        l1Tiles,
        sprites: [spriteAt(t, 97, 1), spriteAt(t, 98, 2), spriteAt(t, 99, 3)],
      },
      mapStore,
      palette,
    )

    map.render(t)

    expect(t.order).toEqual([97, 40, 41, 42, 43, 98, 30, 31, 32, 33, 99])
  })
})

describe('Layer 2 has a real phase split', () => {
  beforeEach(resetEditorStore)

  it('draws a priority L2 tile above an OBJ.2 sprite, not below it', () => {
    // L2Layer used to call render(..., 'nonPriority') and
    // render(..., 'priority') back to back into one target, so BG2.1 always
    // landed with BG2.0 -- under every sprite. Vanilla never exercises it
    // (0 of 1,058,766 L2 cells carry the bit, per docs/ideas/
    // map-rendering-engines.md section 3.1), but a hack can set it.
    const t = new OrderRecorder()
    const palette = makePalette()
    const mapStore = makeTestMapStore({
      palette,
      levelOrientation: 'horizontal',
      screenPipeVariantIdx: [0],
    })
    const l2Tiles = new Map([
      [100, tileOf(100, quad(t, [20, 21, 22, 23], false))],
      [101, tileOf(101, quad(t, [50, 51, 52, 53], true))],
    ])
    const map = buildMap(
      {
        l1: [[null]],
        l2: new L2ObjectStream([[100, 101]], l2Tiles),
        sprites: [spriteAt(t, 99, 2)],
      },
      mapStore,
      palette,
    )

    map.render(t)

    expect(t.order).toEqual([20, 21, 22, 23, 99, 50, 51, 52, 53])
  })

  it('splits L2Preset too, not just the object-stream variant', () => {
    // The two L2 variants have separate render loops; a mutation that
    // reverted only the preset one survived the object-stream test.
    const t = new OrderRecorder()
    const palette = makePalette()
    const mapStore = makeTestMapStore({
      palette,
      levelOrientation: 'horizontal',
      screenPipeVariantIdx: [0],
    })
    const bgTiles = new Map([
      [100, tileOf(100, quad(t, [20, 21, 22, 23], false))],
      [101, tileOf(101, quad(t, [50, 51, 52, 53], true))],
    ])
    const map = buildMap(
      {
        l1: [[null]],
        l2: new L2Preset(0, [[100, 101]], bgTiles),
        sprites: [spriteAt(t, 99, 2)],
      },
      mapStore,
      palette,
    )

    map.render(t)

    expect(t.order).toEqual([20, 21, 22, 23, 99, 50, 51, 52, 53])
  })

  it('splits the frame-accurate scroll path too, which has its own loop', () => {
    // L2ObjectStream has three render modes; the auto-scroll one wraps the
    // grid 3x3 and is a separate loop from the dy-range fallback the test
    // above exercises. A mutation reverting just this loop survived until
    // this case existed.
    const t = new OrderRecorder()
    const palette = makePalette()
    const sim = {
      stateAtFrame: () => ({ layer1XPos: 0, layer1YPos: 0, layer2XPos: 0, layer2YPos: 0 }),
    } as unknown as ScrollSimulator
    const mapStore = makeTestMapStore({
      palette,
      levelOrientation: 'horizontal',
      screenPipeVariantIdx: [0],
      scrollSimulator: sim,
    })
    editorStore.setFrameL2(0)
    const tiles = new Map([
      [100, tileOf(100, quad(t, [20, 21, 22, 23], false))],
      [101, tileOf(101, quad(t, [50, 51, 52, 53], true))],
    ])
    const map = buildMap(
      {
        l1: [[null]],
        l2: new L2ObjectStream([[100, 101]], tiles),
        sprites: [spriteAt(t, 99, 2)],
      },
      mapStore,
      palette,
    )

    map.render(t)

    // 3x3 wrap copies, so each char appears 9 times; only the phase
    // boundary matters here.
    expect(t.order.indexOf(99)).toBeGreaterThan(t.order.lastIndexOf(23))
    expect(t.order.indexOf(99)).toBeLessThan(t.order.indexOf(50))
  })

  it('reports only the phases its grid occupies', () => {
    const t = new OrderRecorder()
    const tiles = new Map([[100, tileOf(100, quad(t, [20, 21, 22, 23], false))]])
    expect([
      ...new L2ObjectStream([[100]], tiles).phases(
        makeTestMapStore({
          palette: makePalette(),
          levelOrientation: 'horizontal',
          screenPipeVariantIdx: [0],
        }),
      ),
    ]).toEqual(['nonPriority'])
  })
})

describe('SmwMap.passes is per level', () => {
  beforeEach(resetEditorStore)

  it('lists only the passes the level occupies, in PPU order', () => {
    const t = new OrderRecorder()
    const palette = makePalette()
    const mapStore = makeTestMapStore({
      palette,
      levelOrientation: 'horizontal',
      screenPipeVariantIdx: [0],
    })
    const l1Tiles = new Map([[0, tileOf(0, quad(t, [30, 31, 32, 33], false))]])
    const map = buildMap({ l1: [[0]], l1Tiles, sprites: [spriteAt(t, 99, 2)] }, mapStore, palette)

    expect(map.passes().map(p => `${p.layer}.${p.priority}`)).toEqual(['l1.0', 'sprites.2'])
  })

  it('drops the sprite pass entirely when a level has no sprites', () => {
    const t = new OrderRecorder()
    const palette = makePalette()
    const mapStore = makeTestMapStore({
      palette,
      levelOrientation: 'horizontal',
      screenPipeVariantIdx: [0],
    })
    const l1Tiles = new Map([[0, tileOf(0, quad(t, [30, 31, 32, 33], false))]])
    const map = buildMap({ l1: [[0]], l1Tiles }, mapStore, palette)

    expect(map.passes().map(p => p.layer)).toEqual(['l1'])
  })
})

/**
 * A BG3 layer with one non-priority and one priority cell on the first
 * gameplay row. Tile word: [13] priority, [12:10] palette, [9:0] charIdx.
 */
function l3With(t: OrderRecorder, plainChar: number, priChar: number): L3TilemapLayer {
  const tilemap = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_COLS)
  const base = L3_HUD_ROW_CUTOFF * L3_TILEMAP_COLS
  tilemap[base] = 1
  tilemap[base + 1] = 0x2000 | 2
  const sheet: Uint8Array[] = []
  sheet[1] = t.char(plainChar).getPixels()
  sheet[2] = t.char(priChar).getPixels()
  return new L3TilemapLayer(tilemap, [sheet], 0, 16, 432)
}

describe('Layer 3 has a phase, and the header bit moves only BG3.1', () => {
  beforeEach(resetEditorStore)

  const env = (): { t: OrderRecorder; palette: Palette; mapStore: MapStore } => {
    const t = new OrderRecorder()
    const palette = makePalette()
    return {
      t,
      palette,
      mapStore: makeTestMapStore({
        palette,
        levelOrientation: 'horizontal',
        screenPipeVariantIdx: [0],
      }),
    }
  }

  it('bit clear: BG3.0 behind everything, BG3.1 between OBJ.1 and OBJ.0', () => {
    const { t, palette, mapStore } = env()
    const l3 = l3With(t, 60, 61)
    const map = buildMap(
      {
        l1: [[null]],
        l3,
        layer3Priority: false,
        sprites: [spriteAt(t, 96, 0), spriteAt(t, 97, 1)],
      },
      mapStore,
      palette,
    )

    map.render(t)

    expect(t.order).toEqual([60, 96, 61, 97])
  })

  it('bit set: BG3.1 is the frontmost pass on the level', () => {
    const { t, palette, mapStore } = env()
    const l3 = l3With(t, 60, 61)
    const map = buildMap(
      {
        l1: [[null]],
        l3,
        layer3Priority: true,
        sprites: [spriteAt(t, 96, 0), spriteAt(t, 99, 3)],
      },
      mapStore,
      palette,
    )

    map.render(t)

    expect(t.order).toEqual([60, 96, 99, 61])
  })
})
