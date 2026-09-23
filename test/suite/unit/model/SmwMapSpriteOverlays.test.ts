/**
 * Direct oracle for the sprite-annotation extension point.
 *
 * `SpriteAppearance.renderOverlay` has no implementations today (see
 * docs/sprites/sprite-overlay-removal.md). Until they were removed, 19 of them
 * plus AppearanceGuards.test.ts exercised the pre-pass incidentally;
 * afterwards nothing did, so `SmwMap.renderSpriteOverlays` could have been
 * gutted or deleted without a single test going red. Preserving that
 * capability is the whole point of the removal commit, so it gets a test
 * that fails when the capability breaks.
 *
 * A stub appearance implements the hook and records every argument the
 * pre-pass hands it.
 *
 * Test tree:
 *   dispatch
 *     - one call per sprite whose appearance implements the hook
 *     - sprites without the hook are skipped
 *     - sprite origin, behavior and the map's own mapStore are forwarded
 *     - levelCols / levelRows come from the L1 grid
 *   isActive and key agreement
 *     - isActive is true only for the key `spriteOverlayKey` produces
 *     - that key is the literal "id:x,y" both sides depend on
 *   getL1 closure
 *     - null off-grid and for an empty cell
 *     - actsLike from the Tile; falls back to the id when the Tile is unknown
 *     - isPriority only when all four subtiles are priority
 *     - collision forwarded from the Tile
 */

import { describe, it, expect } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { Color } from '../../../../src/rom/model/palette/Color'
import { Palette } from '../../../../src/rom/model/palette/Palette'
import { StaticColorBehavior } from '../../../../src/rom/model/palette/behaviors/StaticColorBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { Tile, type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { NO_COLLISION, type TileCollision } from '../../../../src/rom/model/tiles/TileCollision'
import { SmwMap, type LevelHeader } from '../../../../src/rom/model/SmwMap'
import { Sprite, spriteOverlayKey } from '../../../../src/rom/model/sprites/Sprite'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import type { HitRect, SpriteAppearance } from '../../../../src/rom/model/sprites/SpriteAppearance'
import type { GetL1Tile, L1Cell, OverlayContext } from '../../../../src/rom/model/OverlayContext'
import type { MapStore } from '../../../../src/rom/model/stores/mapStore'
import type { RenderTarget } from '../../../../src/rom/model/RenderTarget'
import { makeMockCtx } from '../fixtures/mockOverlayCtx'
import { makeTestMapStore } from '../fixtures/stores'

interface OverlayCall {
  ctx: OverlayContext
  x: number
  y: number
  isActive: boolean
  getL1: GetL1Tile
  levelCols: number
  levelRows: number
  behavior: SpriteBehavior | undefined
  mapStore: MapStore
}

/** Records the pre-pass arguments. Draws nothing - the hook's contract is the arguments. */
class RecordingAppearance implements SpriteAppearance {
  readonly hitRect: HitRect = { dx: 0, dy: 0, w: 16, h: 16 }
  readonly calls: OverlayCall[] = []

  render(): void {
    /* pixels are not what this file is about */
  }

  renderOverlay(
    ctx: OverlayContext,
    x: number,
    y: number,
    isActive: boolean,
    getL1: GetL1Tile,
    levelCols: number,
    levelRows: number,
    behavior: SpriteBehavior | undefined,
    mapStore: MapStore,
  ): void {
    this.calls.push({ ctx, x, y, isActive, getL1, levelCols, levelRows, behavior, mapStore })
  }
}

/** No `renderOverlay` at all - the pre-pass must skip this one. */
class PlainAppearance implements SpriteAppearance {
  readonly hitRect: HitRect = { dx: 0, dy: 0, w: 16, h: 16 }
  render(_t: RenderTarget): void {
    /* no-op */
  }
}

function makeChar(id: number): Char {
  return new Char(id, new StaticPixelsBehavior(new Uint8Array(64)))
}

function makeQuad(priority: boolean | [boolean, boolean, boolean, boolean]): SubtileQuad {
  const p = typeof priority === 'boolean' ? [priority, priority, priority, priority] : priority
  return [
    new SubTile(makeChar(0), 0, false, false, p[0]),
    new SubTile(makeChar(1), 0, false, false, p[1]),
    new SubTile(makeChar(2), 0, false, false, p[2]),
    new SubTile(makeChar(3), 0, false, false, p[3]),
  ]
}

function makeTile(
  id: number,
  opts: {
    priority?: boolean | [boolean, boolean, boolean, boolean]
    actsLike?: number
    collision?: TileCollision
  } = {},
): Tile {
  return new Tile(
    id,
    new StaticQuadBehavior(makeQuad(opts.priority ?? false)),
    opts.actsLike ?? id,
    opts.collision ?? NO_COLLISION,
  )
}

function makePalette(): Palette {
  const black: RgbaColor = [0, 0, 0, 255]
  const cells: Color[][] = Array.from({ length: 16 }, () =>
    Array.from({ length: 16 }, () => new Color(new StaticColorBehavior(black))),
  )
  return new Palette(cells, new Color(new StaticColorBehavior(black)))
}

const HEADER: LevelHeader = {
  mode: 0,
  music: 0,
  tileset: 0,
  orientation: 'horizontal',
  initialCameraYPx: 0,
  timeLimit: 0,
  marioStartPx: { x: 0, y: 0 },
}

function makeMap(
  l1: (number | null)[][],
  sprites: Sprite[],
  l1Tiles: Map<number, Tile> = new Map(),
  mapStore: MapStore = makeTestMapStore({ palette: makePalette() }),
): SmwMap {
  return new SmwMap(
    0,
    HEADER,
    l1,
    null,
    null,
    sprites,
    mapStore.palette,
    0,
    1,
    [0],
    l1Tiles,
    new Map(),
    mapStore,
  )
}

const STUB_BEHAVIOR: SpriteBehavior = { kind: 'stub' }

describe('SmwMap.renderSpriteOverlays - dispatch', () => {
  it('calls renderOverlay once for each sprite whose appearance implements it', () => {
    const a = new RecordingAppearance()
    const b = new RecordingAppearance()
    const map = makeMap(
      [[null]],
      [new Sprite(0x04, 16, 32, a, STUB_BEHAVIOR), new Sprite(0x1d, 48, 64, b, STUB_BEHAVIOR)],
    )

    map.renderSpriteOverlays(makeMockCtx(), new Set())

    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
  })

  it('skips sprites whose appearance does not implement the hook', () => {
    const withHook = new RecordingAppearance()
    const map = makeMap(
      [[null]],
      [
        new Sprite(0x0c, 0, 0, new PlainAppearance(), STUB_BEHAVIOR),
        new Sprite(0x04, 16, 32, withHook, STUB_BEHAVIOR),
      ],
    )

    // The hookless sprite must neither throw nor stop the walk: the sprite
    // after it still has to be visited.
    expect(() => map.renderSpriteOverlays(makeMockCtx(), new Set())).not.toThrow()
    expect(withHook.calls).toHaveLength(1)
  })

  it('forwards the sprite origin, its behavior and the map mapStore', () => {
    const app = new RecordingAppearance()
    const mapStore = makeTestMapStore({ palette: makePalette(), marioSpawnX: 123 })
    const behavior: SpriteBehavior = { kind: 'koopa_walk' }
    const ctx = makeMockCtx()
    const map = makeMap([[null]], [new Sprite(0x04, 80, 96, app, behavior)], new Map(), mapStore)

    map.renderSpriteOverlays(ctx, new Set())

    const call = app.calls[0]
    expect(call.x).toBe(80)
    expect(call.y).toBe(96)
    expect(call.behavior).toBe(behavior)
    expect(call.mapStore).toBe(mapStore)
    expect(call.ctx).toBe(ctx)
  })

  it('reports level dimensions taken from the L1 grid', () => {
    const app = new RecordingAppearance()
    // 3 rows x 5 cols.
    const l1: (number | null)[][] = [
      [null, null, null, null, null],
      [null, null, null, null, null],
      [null, null, null, null, null],
    ]
    const map = makeMap(l1, [new Sprite(0x04, 0, 0, app, STUB_BEHAVIOR)])

    map.renderSpriteOverlays(makeMockCtx(), new Set())

    expect(app.calls[0].levelCols).toBe(5)
    expect(app.calls[0].levelRows).toBe(3)
  })
})

describe('SmwMap.renderSpriteOverlays - isActive and the toggle key', () => {
  it('sets isActive only for the sprite whose key is in the active set', () => {
    const on = new RecordingAppearance()
    const off = new RecordingAppearance()
    const onSprite = new Sprite(0x04, 32, 48, on, STUB_BEHAVIOR)
    const offSprite = new Sprite(0x04, 32, 64, off, STUB_BEHAVIOR)
    const map = makeMap([[null]], [onSprite, offSprite])

    map.renderSpriteOverlays(makeMockCtx(), new Set([spriteOverlayKey(onSprite)]))

    expect(on.calls[0].isActive).toBe(true)
    expect(off.calls[0].isActive).toBe(false)
  })

  it('agrees with the literal "id:x,y" format the webview hit test toggles', () => {
    // `spriteOverlayKey` is the single source of truth for this string
    // (SmwMap.renderSpriteOverlays and main.ts's spriteOverlayKeyAt both
    // call it). Pinning the literal here means a change to the format is a
    // deliberate act with a red test, not a silent drift.
    expect(spriteOverlayKey(new Sprite(0x4d, 32, 48, new PlainAppearance(), STUB_BEHAVIOR))).toBe(
      '77:32,48',
    )

    // And the pre-pass really keys off that string, not something adjacent.
    const app = new RecordingAppearance()
    const map = makeMap([[null]], [new Sprite(0x4d, 32, 48, app, STUB_BEHAVIOR)])
    map.renderSpriteOverlays(makeMockCtx(), new Set(['77:32,48']))
    expect(app.calls[0].isActive).toBe(true)
  })

  it('ignores a key of a plausible but wrong shape', () => {
    // The shape EditorStoreActions.test.ts used to use. The store accepts
    // any string, so only this side can catch a mismatch.
    const app = new RecordingAppearance()
    const map = makeMap([[null]], [new Sprite(0x4d, 32, 48, app, STUB_BEHAVIOR)])

    map.renderSpriteOverlays(makeMockCtx(), new Set(['spr_32_48']))

    expect(app.calls[0].isActive).toBe(false)
  })
})

describe('SmwMap.renderSpriteOverlays - the getL1 closure', () => {
  const SOLID: TileCollision = { ...NO_COLLISION, floor: true, wall: true }

  /** Run the pre-pass over `l1` / `l1Tiles` and hand back the closure it built. */
  function captureGetL1(l1: (number | null)[][], l1Tiles: Map<number, Tile>): GetL1Tile {
    const app = new RecordingAppearance()
    const map = makeMap(l1, [new Sprite(0x04, 0, 0, app, STUB_BEHAVIOR)], l1Tiles)
    map.renderSpriteOverlays(makeMockCtx(), new Set())
    return app.calls[0].getL1
  }

  it('returns null off the grid and for an empty cell', () => {
    const getL1 = captureGetL1([[null, 0x100]], new Map([[0x100, makeTile(0x100)]]))

    expect(getL1(0, 0)).toBeNull() // empty cell
    expect(getL1(5, 0)).toBeNull() // past the last column
    expect(getL1(0, 3)).toBeNull() // past the last row
    expect(getL1(-1, -1)).toBeNull() // negative
  })

  it('reports the Tile acts-like value, falling back to the id when the Tile is unknown', () => {
    const l1Tiles = new Map([[0x100, makeTile(0x100, { actsLike: 0x130 })]])
    // 0x1FF has no Tile in the map at all.
    const getL1 = captureGetL1([[0x100, 0x1ff]], l1Tiles)

    expect(getL1(0, 0)).toMatchObject({ id: 0x100, actsLike: 0x130 })
    expect(getL1(1, 0)).toMatchObject({ id: 0x1ff, actsLike: 0x1ff })
  })

  it('flags a cell as priority only when all four subtiles are priority', () => {
    const l1Tiles = new Map([
      [0x100, makeTile(0x100, { priority: true })],
      [0x101, makeTile(0x101, { priority: [true, true, true, false] })],
      [0x102, makeTile(0x102, { priority: false })],
    ])
    const getL1 = captureGetL1([[0x100, 0x101, 0x102, 0x1ff]], l1Tiles)

    expect(getL1(0, 0)?.isPriority).toBe(true)
    expect(getL1(1, 0)?.isPriority).toBe(false)
    expect(getL1(2, 0)?.isPriority).toBe(false)
    // Unknown tile: nothing to inspect, so not priority.
    expect(getL1(3, 0)?.isPriority).toBe(false)
  })

  it('forwards the per-tile collision classification', () => {
    const l1Tiles = new Map([[0x100, makeTile(0x100, { collision: SOLID })]])
    const getL1 = captureGetL1([[0x100]], l1Tiles)

    const cell = getL1(0, 0) as L1Cell
    expect(cell.collision).toEqual(SOLID)
  })
})
