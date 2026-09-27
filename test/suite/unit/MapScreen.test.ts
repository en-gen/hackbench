/**
 * The map tab's backend screen (theia/extension/src/node/map-screen.ts,
 * #421 step 3) and the core inputs it draws from (src/rom/model/L1Model.ts).
 *
 * Synthetic cases (no ROM) cover every decision this code makes, because CI
 * has no ROM: the priority planes, the screen bounds, the seams in both
 * orientations, the pipe set per screen, the backdrop, the palette override
 * block, the boss-arena refusal, the switch flags reaching `expandMap`, and
 * the cache keys. The corpus cases then check the drawing against the Map16
 * atlas path (`renderMap16Tile`) on real screens.
 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import * as Expander from '../../../src/rom/ObjectExpander'
import {
  SWITCH_FLAGS_UNCLEARED as UNCLEARED,
  type SwitchFlags,
} from '../../../src/rom/ObjectExpander'
import {
  isLevelModeVertical,
  parseLevelHeader,
  parseLevelObjects,
} from '../../../src/rom/LevelParser'
import {
  PIPE_VARIANT_TILE_COUNT,
  PIPE_VARIANT_TILE_START,
  pipeVariantIndex,
  type Map16Tile,
} from '../../../src/rom/Map16'
import { renderMap16Tile } from '../../../src/rom/TileRenderer'
import { ADDR_CUSTOM_PALETTE_TABLE } from '../../../src/rom/PaletteLoader'
import { Char } from '../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { buildL1Inputs, levelColors, type L1Inputs } from '../../../src/rom/model/L1Model'
import { switchBlockTile } from '../../../src/rom/SwitchBlockTiles'
import type { RgbaColor } from '../../../src/rom/GraphicsDecoder'
import {
  buildL1Model,
  drawL1Screen,
  L1ModelCache,
  mapScreen,
  modelFromInputs,
  palaceIconsOf,
  screenResult,
  type L1Model,
} from '../../../theia/extension/src/node/map-screen'
import { SYNTHETIC_VERTICAL_TABLE } from '../support/verticalTable'
import { VANILLA, hasRom, romPath } from '../support/corpus'

vi.mock('../../../src/rom/ObjectExpander', async importOriginal => {
  const real = await importOriginal<typeof Expander>()
  return { ...real, expandMap: vi.fn(real.expandMap) }
})

const romPresent = hasRom(VANILLA)
const YELLOW: SwitchFlags = { ...UNCLEARED, yellow: true }
const BACKDROP: RgbaColor = [250, 9, 9, 255]

// ── Synthetic inputs ─────────────────────────────────────────────────────────

/** A solid char whose every pixel is color index `v`. */
const solid = (v: number) => new Char(v, new StaticPixelsBehavior(new Uint8Array(64).fill(v)))
const sub = (charNum: number, palette = 0, priority = false) => ({ charNum, palette, priority, flipX: false, flipY: false }) // prettier-ignore
const tile = (id: number, q: ReturnType<typeof sub>[]): Map16Tile => ({ id, tl: q[0]!, tr: q[1]!, bl: q[2]!, br: q[3]! }) // prettier-ignore

/** Color index c of row r is [r * 16 + c, 100, 200]; index 0 is transparent. */
const COLORS: RgbaColor[] = Array.from({ length: 256 }, (_, i) => (i % 16 === 0 ? [0, 0, 0, 0] : [i, 100, 200, 255])) // prettier-ignore

/**
 * Inputs with tile 1 (chars 1-4, one per quadrant), an empty tile 0, and the
 * eight pipe tiles whose variant v draws char 1 in palette row v.
 */
function inputs(grid: number[][], isVertical: boolean, screenCount: number): L1Inputs {
  const tiles = [
    tile(0, [sub(0), sub(0), sub(0), sub(0)]),
    tile(1, [sub(1), sub(2), sub(3), sub(4)]),
  ]
  const pipeVariants = [0, 1, 2, 3].map(
    v =>
    Array.from({ length: PIPE_VARIANT_TILE_COUNT }, (_, i) => tile(PIPE_VARIANT_TILE_START + i, [sub(1, v), sub(1, v), sub(1, v), sub(1, v)])), // prettier-ignore
  )
  for (let i = 0; i < PIPE_VARIANT_TILE_COUNT; i++) tiles.push(tile(PIPE_VARIANT_TILE_START + i, [sub(0), sub(0), sub(0), sub(0)])) // prettier-ignore
  return {
    header: parseLevelHeader([0, 0, 0, 0, 0]),
    isVertical,
    screenCount,
    grid,
    map16: { tiles, pipeVariants },
    rawVram: {},
    anim: null,
    vram: {},
    chars: new Map([0, 1, 2, 3, 4].map(v => [v, solid(v)])),
    colors: COLORS,
    backArea: BACKDROP,
  }
}

const hGrid = (screens: number) => Array.from({ length: 27 }, () => new Array<number>(screens * 16).fill(0)) // prettier-ignore
const vGrid = (screens: number) => Array.from({ length: screens * 16 }, () => new Array<number>(32).fill(0)) // prettier-ignore

/** RGBA of pixel (x, y) in a screen buffer of `width` pixels. */
const px = (buf: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(buf.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))

describe('drawL1Screen - priority planes (synthetic)', () => {
  // tl and br carry the priority bit; tr and bl do not.
  const i = inputs(hGrid(1), false, 1)
  i.map16.tiles[1] = tile(1, [sub(1, 0, true), sub(2), sub(3), sub(4, 0, true)])
  i.grid[0]![0] = 1
  const model = modelFromInputs(i)
  const drawn = (buf: Uint8ClampedArray) =>
    [px(buf, 256, 3, 3), px(buf, 256, 11, 3), px(buf, 256, 3, 11), px(buf, 256, 11, 11)].map(
      p => p[0] !== BACKDROP[0],
    )

  it('the priority plane holds exactly the two flagged quadrants', () => {
    expect(drawn(drawL1Screen(model, 0, ['priority']))).toEqual([true, false, false, true])
  })

  it('the non-priority plane holds the other two', () => {
    expect(drawn(drawL1Screen(model, 0, ['nonPriority']))).toEqual([false, true, true, false])
  })

  it('the composite draws both, each quadrant in its own color', () => {
    const buf = drawL1Screen(model, 0)
    expect([px(buf, 256, 3, 3)[0], px(buf, 256, 11, 3)[0], px(buf, 256, 3, 11)[0], px(buf, 256, 11, 11)[0]]).toEqual([1, 2, 3, 4]) // prettier-ignore
  })
})

describe('screens (synthetic)', () => {
  it('fills the backdrop where L1 is transparent', () => {
    const buf = drawL1Screen(modelFromInputs(inputs(hGrid(1), false, 1)), 0)
    expect(px(buf, 256, 100, 300)).toEqual([...BACKDROP])
  })

  it('a horizontal seam: column 15 ends screen 0, column 16 starts screen 1', () => {
    const g = hGrid(2)
    g[26]![15] = 1
    g[26]![16] = 1
    const m = modelFromInputs(inputs(g, false, 2))
    const s0 = drawL1Screen(m, 0)
    const s1 = drawL1Screen(m, 1)
    expect(px(s0, 256, 255, 26 * 16 + 15)[0]).toBe(4) // br of col 15
    expect(px(s0, 256, 239, 26 * 16)[0]).toBe(BACKDROP[0]) // col 14 empty
    expect(px(s1, 256, 0, 26 * 16)[0]).toBe(1) // tl of col 16
    expect(px(s1, 256, 16, 26 * 16)[0]).toBe(BACKDROP[0]) // col 17 empty
  })

  it('a vertical seam: row 15 ends screen 0, row 16 starts screen 1, 32 columns wide', () => {
    const g = vGrid(2)
    g[15]![31] = 1
    g[16]![0] = 1
    const m = modelFromInputs(inputs(g, true, 2))
    const s0 = drawL1Screen(m, 0)
    const s1 = drawL1Screen(m, 1)
    expect(px(s0, 512, 511, 255)[0]).toBe(4)
    expect(px(s1, 512, 0, 0)[0]).toBe(1)
    expect(px(s1, 512, 511, 255)[0]).toBe(BACKDROP[0])
  })

  it('each screen draws the pipe set MAP16AppTable gives its strips', () => {
    const g = hGrid(5)
    for (let s = 0; s < 5; s++) g[0]![s * 16] = PIPE_VARIANT_TILE_START
    const m = modelFromInputs(inputs(g, false, 5))
    // Variant v draws palette row v, whose color 1 has red channel v*16+1.
    const rows = [0, 1, 2, 3, 4].map(s => (px(drawL1Screen(m, s), 256, 0, 0)[0]! - 1) / 16)
    expect(rows).toEqual([0, 1, 2, 3, 0])
    expect(rows).toEqual([0, 1, 2, 3, 4].map(s => pipeVariantIndex(s * 16)))
  })

  it('bounds the screen index by the map screen count, not the grid width', () => {
    // A handler that wrote past the end leaves a grid wider than the map.
    const m = modelFromInputs(inputs(hGrid(3), false, 2))
    expect(screenResult(m, 1)).toMatchObject({ status: 'ok', screenCount: 2, width: 256, height: 432 }) // prettier-ignore
    for (const bad of [2, -1, 0.5]) {
      const r = screenResult(m, bad)
      expect(r.status).toBe('unavailable')
      if (r.status === 'unavailable') expect(r.reason).toMatch(/2 screens/)
    }
    expect(screenResult(modelFromInputs(inputs(vGrid(1), true, 1)), 0)).toMatchObject({ width: 512, height: 256, orientation: 'vertical' }) // prettier-ignore
  })

  it('an unreadable palace tile falls back to its reason', () => {
    const m: L1Model = { ...modelFromInputs(inputs(hGrid(1), false, 1)), palaceTiles: { yellow: { uncleared: 1, cleared: 0 }, green: { reason: 'nope' } } } // prettier-ignore
    const icons = palaceIconsOf(m).status === 'ok' ? (palaceIconsOf(m) as { icons: object[] }).icons : [] // prettier-ignore
    expect(icons[0]).toMatchObject({ palace: 'yellow' })
    expect(icons[0]).toHaveProperty('cleared')
    expect(icons[1]).toEqual({ palace: 'green', unavailable: 'nope' })
  })
})

// ── Synthetic ROM reads ──────────────────────────────────────────────────────

/** A fake SmwRom: one level's raw bytes, a synthetic VerticalTable, an empty ROM behind it. */
function fakeRom(levelMode: number): SmwRom {
  const buf = Buffer.alloc(0x40000, 0)
  buf[0x7fd5] = 0x20
  const raw = Buffer.from([0x00, levelMode, 0, 0, 0, 0xff])
  return {
    rom: new RomFile('fake.sfc', buf),
    getLevelRawData: () => raw,
    getVerticalTable: () => ({ ok: true, table: SYNTHETIC_VERTICAL_TABLE }),
  } as unknown as SmwRom
}

describe('buildL1Inputs (synthetic)', () => {
  it('passes the switch flags to expandMap', () => {
    const spy = vi.mocked(Expander.expandMap)
    spy.mockClear()
    buildL1Inputs(fakeRom(0), 0x105, YELLOW)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![7]).toEqual(YELLOW)
  })

  it.each([0x09, 0x0b, 0x10])(
    'refuses boss-arena mode $%s, whose L1 the game never loads',
    mode => {
      const r = buildL1Inputs(fakeRom(mode), 0x105, UNCLEARED)
      expect(r).toMatchObject({ ok: false })
      if (!r.ok) expect(r.reason).toMatch(/boss arena/)
    },
  )

  it('an unreadable part refuses with a reason rather than an empty picture', () => {
    const r = buildL1Inputs(fakeRom(0), 0x105, UNCLEARED)
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.reason).toMatch(/GFX/)
    const none = mapScreen(new L1ModelCache(), Buffer.alloc(0x40000), 'x.sfc', 0x105, 0, UNCLEARED)
    expect(none).toMatchObject({ status: 'unavailable' })
  })

  it('applies a level palette override block, backdrop included', () => {
    const rom = new RomFile('pal.sfc', Buffer.alloc(0x80000, 0))
    rom.writeAt(ADDR_CUSTOM_PALETTE_TABLE + 0x105 * 3, [0x00, 0x80, 0x0f]) // -> $0F8000
    const block = Buffer.alloc(0x202)
    block.writeUInt16LE(0x001f, 0) // backdrop: pure red
    block.writeUInt16LE(0x03e0, 2 + (2 * 16 + 5) * 2) // row 2 color 5: pure green
    rom.writeAt(0x0f8000, block)
    const { colors, backArea } = levelColors(rom, 0x105, parseLevelHeader([0, 0, 0, 0, 0]), { bg: 0, obj: 0 }) // prettier-ignore
    expect(backArea.slice(0, 3)).toEqual([255, 0, 0])
    expect(colors[2 * 16 + 5]!.slice(0, 3)).toEqual([0, 255, 0])
  })

  it('a ROM that routes no object to a palace routine names why', () => {
    const t = switchBlockTile(new RomFile('e.sfc', Buffer.alloc(0x80000, 0)), 0, 'yellow')
    expect(t).toEqual({ reason: expect.stringMatching(/yellow/) })
  })
})

describe('L1ModelCache (synthetic)', () => {
  it('keys on the bytes array, the map and the flags, and passes them to the builder', () => {
    const calls: [number, SwitchFlags][] = []
    const cache = new L1ModelCache((_rom, index, flags) => {
      calls.push([index, flags])
      return { status: 'unavailable', reason: 'stub' }
    })
    const a = new Uint8Array(0x40000)
    a[0x7fd5] = 0x20 // LoROM, so the SmwRom the cache builds is valid
    cache.get(a, 'r.sfc', 0x105, UNCLEARED)
    cache.get(a, 'r.sfc', 0x105, UNCLEARED)
    expect(calls).toHaveLength(1)
    cache.get(a, 'r.sfc', 0x105, YELLOW)
    cache.get(a, 'r.sfc', 0x106, UNCLEARED)
    cache.get(new Uint8Array(a), 'r.sfc', 0x105, UNCLEARED)
    expect(calls).toEqual([
      [0x105, UNCLEARED],
      [0x105, YELLOW],
      [0x106, UNCLEARED],
      [0x105, UNCLEARED],
    ])
    mapScreen(cache, a, 'r.sfc', 0x107, 0, { ...UNCLEARED, blue: true })
    expect(calls.at(-1)).toEqual([0x107, { ...UNCLEARED, blue: true }])
  })
})

// ── Corpus: the vanilla ROM ──────────────────────────────────────────────────

/** The same screen composited tile by tile from the Map16 atlas path, over the backdrop. */
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
  const grid = Expander.expandMap(objects, header.levelLength, rom.rom, header.objectTileset, vertical, header.levelMode, undefined, flags) // prettier-ignore
  const [w, h] = vertical ? [32, 16] : [16, 27]
  const [x0, y0] = vertical ? [0, screen * 16] : [screen * 16, 0]
  const { vram, colors, map16, backArea } = model.inputs!
  const out = new Uint8ClampedArray(w * 16 * h * 16 * 4)
  for (let i = 0; i < out.length; i += 4) out.set(backArea, i)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const id = grid[y0 + y]![x0 + x]!
      const pipe = id - PIPE_VARIANT_TILE_START
      const def =
        pipe >= 0 && pipe < PIPE_VARIANT_TILE_COUNT && map16.pipeVariants.length > 0
          ? map16.pipeVariants[pipeVariantIndex(vertical ? y0 + y : x0 + x)]![pipe]!
          : map16.tiles[id]!
      const p = renderMap16Tile(def, vram, { colors })
      for (let py = 0; py < 16; py++)
        for (let pxl = 0; pxl < 16; pxl++) {
          const s = (py * 16 + pxl) * 4
          if (p[s + 3] === 0) continue
          out.set(p.subarray(s, s + 4), ((y * 16 + py) * w * 16 + x * 16 + pxl) * 4)
        }
    }
  return out
}

function distinctColors(buf: Uint8ClampedArray): number {
  const seen = new Set<number>()
  for (let i = 0; i < buf.length; i += 4) seen.add((buf[i]! << 16) | (buf[i + 1]! << 8) | buf[i + 2]!) // prettier-ignore
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
    expect(distinctColors(drawn)).toBeGreaterThan(4)
    expect(Buffer.from(drawn).equals(Buffer.from(expected))).toBe(true)
  })

  it('reports the layout the widget sizes itself from', () => {
    const h = mapScreen(new L1ModelCache(), bytes, romPath(VANILLA), 0x105, 0, UNCLEARED)
    const v = mapScreen(new L1ModelCache(), bytes, romPath(VANILLA), 0x109, 0, UNCLEARED)
    expect(h).toMatchObject({ status: 'ok', screenCount: 20, orientation: 'horizontal', width: 256, height: 432 }) // prettier-ignore
    expect(v).toMatchObject({ status: 'ok', screenCount: 7, orientation: 'vertical', width: 512, height: 256 }) // prettier-ignore
  })

  it('reads each palace block from the handler tables, both states', () => {
    const tiles = (['yellow', 'green', 'red', 'blue'] as const).map(p => switchBlockTile(rom.rom, 7, p)) // prettier-ignore
    expect(tiles).toEqual([
      { uncleared: 0x06b, cleared: 0x16b },
      { uncleared: 0x06a, cleared: 0x16a },
      { uncleared: 0x06d, cleared: 0x16d },
      { uncleared: 0x06c, cleared: 0x16c },
    ])
    const icons = palaceIconsOf(model(0x105))
    if (icons.status !== 'ok') throw new Error('no icons')
    for (const i of icons.icons) {
      if (!('cleared' in i)) throw new Error(i.unavailable)
      expect(i.cleared).not.toBe(i.uncleared)
    }
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
      cells.add(`${Math.floor((p % (widthTiles * 16)) / 16)},${Math.floor(p / (widthTiles * 16) / 16)}`) // prettier-ignore
    }
    return [...cells].sort()
  }

  it('yellow changes exactly the yellow switch-block cells on $105', () => {
    // The five cells where the grid differs ($06B -> $16B), measured by
    // expanding $105 both ways: (156,20) on screen 9, and (213,24),
    // (214,24), (228,24), (229,24) on screens 13 and 14.
    expect(changedCells(rpcScreen(0x105, 9, UNCLEARED), rpcScreen(0x105, 9, YELLOW), 16)).toEqual(['12,20']) // prettier-ignore
    expect(changedCells(rpcScreen(0x105, 13, UNCLEARED), rpcScreen(0x105, 13, YELLOW), 16)).toEqual(['5,24', '6,24']) // prettier-ignore
    expect(changedCells(rpcScreen(0x105, 0, UNCLEARED), rpcScreen(0x105, 0, YELLOW), 16)).toEqual([]) // prettier-ignore
  })

  it('counts screens from the header, not a grid a handler wrote past the end of', () => {
    // $0BD's grid is 17 columns wide (a handler writes column 16); it has one screen.
    expect(mapScreen(new L1ModelCache(), bytes, romPath(VANILLA), 0x0bd, 0, UNCLEARED)).toMatchObject({ status: 'ok', screenCount: 1 }) // prettier-ignore
  })

  it('refuses a vanilla boss arena', () => {
    const r = mapScreen(new L1ModelCache(), bytes, romPath(VANILLA), 0x0d9, 0, UNCLEARED)
    expect(r).toMatchObject({ status: 'unavailable' })
  })
})
