/**
 * The map tab's backend screen (theia/extension/src/node/map-screen.ts,
 * #421 step 3): one L1 (foreground) screen drawn through the core renderer
 * (`Tile.render` -> `BufferRenderTarget` -> `composeTile`), planes in
 * `RenderPass` order.
 *
 * The oracle for the drawing is the Map16 atlas path (`renderMap16Tile`),
 * which the Map16 view already ships: the screen must equal the same cells
 * composited tile by tile from it. The grid is re-expanded here rather than
 * taken from the model, so a screen offset or orientation slip cannot hide
 * in both. VRAM, CGRAM and the Map16 table come from the model's own inputs:
 * their correctness is the L1 data gate's job (capture_gate.ts), not this
 * file's.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import {
  isLevelModeVertical,
  parseLevelHeader,
  parseLevelObjects,
} from '../../../src/rom/LevelParser'
import { expandMap, SwitchFlags } from '../../../src/rom/ObjectExpander'
import {
  PIPE_VARIANT_TILE_COUNT,
  PIPE_VARIANT_TILE_START,
  pipeVariantIndex,
} from '../../../src/rom/Map16'
import { renderMap16Tile } from '../../../src/rom/TileRenderer'
import { Char } from '../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../src/rom/model/tiles/SubTile'
import { Tile } from '../../../src/rom/model/tiles/Tile'
import { StaticQuadBehavior } from '../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { Palette } from '../../../src/rom/model/palette/Palette'
import { Color } from '../../../src/rom/model/palette/Color'
import { StaticColorBehavior } from '../../../src/rom/model/palette/behaviors/StaticColorBehavior'
import { createMapStore } from '../../../src/rom/model/stores/mapStore'
import {
  buildL1Model,
  drawL1Screen,
  L1Model,
  L1ModelCache,
  mapScreen,
  UNCLEARED,
} from '../../../theia/extension/src/node/map-screen'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const romPresent = hasRom(VANILLA)
const YELLOW: SwitchFlags = { ...UNCLEARED, yellow: true }

// ── Synthetic: no ROM ────────────────────────────────────────────────────────

/** One solid char per color index, so each quadrant is fully opaque. */
const solid = (v: number) => new Char(v, new StaticPixelsBehavior(new Uint8Array(64).fill(v)))

/** A one-screen horizontal model with a single tile at (0, 0). */
function syntheticModel(prio: [boolean, boolean, boolean, boolean]): L1Model {
  const q = (i: number) => new SubTile(solid(i + 1), 0, false, false, prio[i]!)
  const tile = new Tile(1, new StaticQuadBehavior([q(0), q(1), q(2), q(3)]))
  const colors = Array.from({ length: 16 }, (_, c) => new Color(new StaticColorBehavior([c * 10, c, 0, 255]))) // prettier-ignore
  const rows = Array.from({ length: 16 }, () => colors)
  const palette = new Palette(rows, new Color(new StaticColorBehavior([0, 0, 0, 255])))
  const grid = Array.from({ length: 27 }, () => new Array<number>(16).fill(0x999))
  grid[0]![0] = 1
  return {
    grid,
    tiles: new Map([[1, tile]]),
    mapStore: createMapStore({ palette }),
    isVertical: false,
    screenCount: 1,
  }
}

/** Whether the 8x8 quadrant at (qx, qy) of the top-left tile is opaque. */
const opaque = (buf: Uint8ClampedArray, qx: number, qy: number) =>
  buf[((qy * 8 + 3) * 256 + qx * 8 + 3) * 4 + 3] === 255

describe('drawL1Screen - priority planes (synthetic)', () => {
  // tl and br carry the priority bit; tr and bl do not.
  const model = syntheticModel([true, false, false, true])

  it('the priority plane holds exactly the two flagged quadrants', () => {
    const buf = drawL1Screen(model, 0, ['priority'])
    expect([opaque(buf, 0, 0), opaque(buf, 1, 0), opaque(buf, 0, 1), opaque(buf, 1, 1)]).toEqual([
      true,
      false,
      false,
      true,
    ])
  })

  it('the non-priority plane holds the other two', () => {
    const buf = drawL1Screen(model, 0, ['nonPriority'])
    expect([opaque(buf, 0, 0), opaque(buf, 1, 0), opaque(buf, 0, 1), opaque(buf, 1, 1)]).toEqual([
      false,
      true,
      true,
      false,
    ])
  })

  it('the default composite draws both planes', () => {
    const buf = drawL1Screen(model, 0)
    expect([opaque(buf, 0, 0), opaque(buf, 1, 0), opaque(buf, 0, 1), opaque(buf, 1, 1)]).toEqual([
      true,
      true,
      true,
      true,
    ])
    // Each quadrant keeps its own color index: tl=1, tr=2, bl=3, br=4.
    expect(buf[(3 * 256 + 3) * 4]).toBe(10)
    expect(buf[(3 * 256 + 11) * 4]).toBe(20)
  })
})

/** A ROM with a LoROM header and nothing else: no level data anywhere. */
function emptyRom(): Uint8Array {
  const buf = Buffer.alloc(0x40000, 0x00)
  buf[0x7fd5] = 0x20
  return buf
}

/** One level with an L1 stream but no VerticalTable read anywhere. */
function levelWithoutVerticalTable(): Uint8Array {
  const buf = Buffer.alloc(0x40000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  rom.writeAt(ADDR.LEVEL_L1_PTR + 0x105 * 3, [0x00, 0x80, 0x06])
  rom.writeAt(0x068000, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x35, 0x01, 0xff])
  return buf
}

describe('mapScreen - an unbuildable map returns a reason (synthetic)', () => {
  it('a slot with no level data', () => {
    const r = mapScreen(new L1ModelCache(), emptyRom(), 'synthetic.sfc', 0x105, 0, UNCLEARED)
    expect(r.status).toBe('unavailable')
    if (r.status !== 'unavailable') return
    expect(r.reason).toMatch(/\$105/)
  })

  it('a level whose orientation cannot be read', () => {
    const rom = new SmwRom(RomFile.fromBytes('s.sfc', Buffer.from(levelWithoutVerticalTable())))
    const r = buildL1Model(rom, 0x105, UNCLEARED)
    expect(r.status).toBe('unavailable')
    if (r.status !== 'unavailable') return
    expect(r.reason).toMatch(/VerticalTable/)
  })
})

// ── Corpus: the vanilla ROM ──────────────────────────────────────────────────

/** The same screen composited tile by tile from the Map16 atlas path. */
function atlasScreen(
  rom: SmwRom,
  model: L1Model,
  index: number,
  screen: number,
  flags: SwitchFlags,
) {
  const raw = rom.getLevelRawData(index)!
  const table = rom.requireVerticalTable()
  const header = parseLevelHeader(raw)
  const vertical = isLevelModeVertical(header.levelMode, table)
  const objects = parseLevelObjects(raw, table).objects
  const grid = expandMap(objects, header.levelLength, rom.rom, header.objectTileset, vertical, header.levelMode, undefined, flags) // prettier-ignore
  const [w, h] = vertical ? [32, 16] : [16, 27]
  const [x0, y0] = vertical ? [0, screen * 16] : [screen * 16, 0]
  const { vram, colors, map16 } = model.inputs!
  const out = new Uint8ClampedArray(w * 16 * h * 16 * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const id = grid[y0 + y]![x0 + x]!
      const pipe = id - PIPE_VARIANT_TILE_START
      const def =
        pipe >= 0 && pipe < PIPE_VARIANT_TILE_COUNT && map16.pipeVariants.length > 0
          ? map16.pipeVariants[pipeVariantIndex(vertical ? y0 + y : x0 + x)]![pipe]!
          : map16.tiles[id]!
      const px = renderMap16Tile(def, vram, { colors })
      for (let py = 0; py < 16; py++)
        for (let pxl = 0; pxl < 16; pxl++) {
          const s = (py * 16 + pxl) * 4
          if (px[s + 3] === 0) continue
          out.set(px.subarray(s, s + 4), ((y * 16 + py) * w * 16 + x * 16 + pxl) * 4)
        }
    }
  return out
}

function distinctColors(buf: Uint8ClampedArray): number {
  const seen = new Set<number>()
  for (let i = 0; i < buf.length; i += 4)
    seen.add((buf[i]! << 16) | (buf[i + 1]! << 8) | buf[i + 2]!)
  return seen.size
}

describe.skipIf(!romPresent)('map-screen (vanilla ROM)', () => {
  const bytes = romPresent ? new Uint8Array(fs.readFileSync(romPath(VANILLA))) : new Uint8Array()
  const rom = romPresent ? new SmwRom(RomFile.fromBytes(romPath(VANILLA), Buffer.from(bytes))) : null! // prettier-ignore
  const model = (index: number, flags: SwitchFlags = UNCLEARED): L1Model => {
    const r = buildL1Model(rom, index, flags)
    if (r.status !== 'ok') throw new Error(r.reason)
    return r.model
  }

  // $105 is horizontal, 20 screens: screens 7 and 8 straddle column 128 and
  // both hold pipes, as does 17, whose pipe set is not variant 0.
  // $109 is vertical, 7 screens of 32 x 16 tiles.
  it.each([
    ['105', 0],
    ['105', 7],
    ['105', 8],
    ['105', 17],
    ['109', 0],
    ['109', 1],
  ])('map $%s screen %i equals the atlas composite', (slot, screen) => {
    const index = parseInt(slot, 16)
    const m = model(index)
    const drawn = drawL1Screen(m, screen)
    const expected = atlasScreen(rom, m, index, screen, UNCLEARED)
    expect(drawn.length).toBe(expected.length)
    // Not two blank buffers agreeing.
    expect(distinctColors(drawn)).toBeGreaterThan(4)
    expect(Buffer.from(drawn).equals(Buffer.from(expected))).toBe(true)
  })

  it('reports the layout the widget sizes itself from', () => {
    const h = mapScreen(new L1ModelCache(), bytes, romPath(VANILLA), 0x105, 0, UNCLEARED)
    const v = mapScreen(new L1ModelCache(), bytes, romPath(VANILLA), 0x109, 0, UNCLEARED)
    expect(h).toMatchObject({ status: 'ok', screenCount: 20, orientation: 'horizontal', width: 256, height: 432 }) // prettier-ignore
    expect(v).toMatchObject({ status: 'ok', screenCount: 7, orientation: 'vertical', width: 512, height: 256 }) // prettier-ignore
  })

  it('a screen past the end is unavailable, with why', () => {
    const r = mapScreen(new L1ModelCache(), bytes, romPath(VANILLA), 0x105, 20, UNCLEARED)
    expect(r).toMatchObject({ status: 'unavailable' })
    if (r.status === 'unavailable') expect(r.reason).toMatch(/20 screens/)
  })

  /** Decoded RGBA of one screen, through the function the RPC calls. */
  function rpcScreen(index: number, screen: number, flags: SwitchFlags): Buffer {
    const r = mapScreen(new L1ModelCache(), bytes, romPath(VANILLA), index, screen, flags)
    if (r.status !== 'ok') throw new Error(r.status)
    return Buffer.from(r.rgbaBase64, 'base64')
  }

  /** The 16x16 cells (local col, row) whose pixels differ between two screens. */
  function changedCells(a: Buffer, b: Buffer, widthTiles: number): string[] {
    const cells = new Set<string>()
    for (let i = 0; i < a.length; i += 4) {
      if (a.readUInt32LE(i) === b.readUInt32LE(i)) continue
      const p = i / 4
      cells.add(
        `${Math.floor((p % (widthTiles * 16)) / 16)},${Math.floor(p / (widthTiles * 16) / 16)}`,
      )
    }
    return [...cells].sort()
  }

  it('switchFlags reach expandMap: yellow changes exactly the yellow switch-block cells on $105', () => {
    // The five cells where the grid itself differs ($06B -> $16B), measured
    // by expanding $105 both ways: (156,20) on screen 9, and (213,24),
    // (214,24), (228,24), (229,24) on screens 13 and 14.
    expect(changedCells(rpcScreen(0x105, 9, UNCLEARED), rpcScreen(0x105, 9, YELLOW), 16)).toEqual(['12,20']) // prettier-ignore
    expect(changedCells(rpcScreen(0x105, 13, UNCLEARED), rpcScreen(0x105, 13, YELLOW), 16)).toEqual(['5,24', '6,24']) // prettier-ignore
    // A screen with no yellow block is untouched.
    expect(changedCells(rpcScreen(0x105, 0, UNCLEARED), rpcScreen(0x105, 0, YELLOW), 16)).toEqual([]) // prettier-ignore
  })

  it('the cache keys on the working copy bytes and the flags', () => {
    const cache = new L1ModelCache()
    const a = cache.get(bytes, romPath(VANILLA), 0x105, UNCLEARED)
    expect(cache.get(bytes, romPath(VANILLA), 0x105, UNCLEARED)).toBe(a)
    expect(cache.get(bytes, romPath(VANILLA), 0x105, YELLOW)).not.toBe(a)
    // An edit produces a new bytes array: never served the old model.
    expect(cache.get(new Uint8Array(bytes), romPath(VANILLA), 0x105, UNCLEARED)).not.toBe(a)
  })
})
