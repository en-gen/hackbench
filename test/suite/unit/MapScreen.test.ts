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
import { createHash } from 'crypto'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import * as Expander from '../../../src/rom/ObjectExpander'
import {
  SWITCH_FLAGS_UNCLEARED as UNCLEARED,
  type SwitchFlags,
} from '../../../src/rom/ObjectExpander'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import {
  PIPE_VARIANT_TILE_COUNT,
  PIPE_VARIANT_TILE_START,
  loadMap16WithPipeVariants,
  pipeVariantIndex,
  type Map16Tile,
} from '../../../src/rom/Map16'
import { buildTileAtlas } from '../../../src/rom/TileRenderer'
import { loadVram, type VramState } from '../../../src/rom/GfxLoader'
import { renderCell } from '../../../src/rom/render/CellRenderer'
import { HIDDEN_TILE_DIM_ALPHA, hiddenPixelStrength } from '../../../src/rom/render/HiddenTiles'
import { choosePalaceArt, majority, palaceArt } from '../../../src/rom/SwitchArt'
import { withHiddenTiles } from '../../../theia/extension/src/browser/map16-view-model'
import { switchArtOf } from '../../../src/rom/SwitchAlternates'
import { screenKey } from '../../../theia/extension/src/browser/map-view-model'
import { ADDR_CUSTOM_PALETTE_TABLE } from '../../../src/rom/PaletteLoader'
import {
  applyPaletteFrame0,
  assembleL1Inputs,
  buildL1Inputs,
  levelColors,
  readNoL1Modes,
  type L1Inputs,
  type L1Readings,
} from '../../../src/rom/model/L1Model'
import { buildLevelCgram, loadRomPalettes, STOCK_COL1 } from '../../../src/rom/PaletteLoader'
import {
  detectPaletteAnimation,
  type PaletteAnimContext,
} from '../../../src/rom/PaletteAnimationDetect'
import { bgr555ToRgba } from '../../../src/rom/GraphicsDecoder'
import { switchBlockTile, PALACES } from '../../../src/rom/SwitchBlockTiles'
import { objectsDispatchedTo } from '../../../src/rom/objectHandlers/dispatch'
import { handle_0DB583 } from '../../../src/rom/objectHandlers/extendedHandlers'
import { handle_0DB916 } from '../../../src/rom/objectHandlers/standardHandlers'
import {
  ADDR_EXTENDED_DISPATCH,
  ADDR_TILESET_DISPATCH,
} from '../../../src/rom/objectHandlers/romData'
import type { RgbaColor } from '../../../src/rom/GraphicsDecoder'
import {
  drawL1Screen,
  L1ModelCache,
  mapScreen,
  palaceIconsOf,
  toolbarArtOf,
  screenResult,
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

const sub = (charNum: number, palette = 0) => ({ charNum, palette, priority: false, flipX: false, flipY: false }) // prettier-ignore
const tile = (id: number, q: ReturnType<typeof sub>[]): Map16Tile => ({ id, tl: q[0]!, tr: q[1]!, bl: q[2]!, br: q[3]! }) // prettier-ignore
/** fg1 chars 0-4, each solid in its own color index (char 0 transparent); 5 blank; 6 solid color 4; 7-9 blank. */
const VRAM: VramState = { fg1: [0, 1, 2, 3, 4, 0, 4, 0, 0, 0].map(v => new Uint8Array(64).fill(v)) }
/** The blue switch swaps chars 2-4 to solid color 7 and char 5's top half to color 7 (frame 0 as loaded when off). */
/** ON/OFF on blanks char 6: a tile drawn with the switch off, gone with it on. */
const ONOFF_SLOT = { charBase: 6, tiles: [4, 0, 0, 0].map(v => new Uint8Array(64).fill(v)), alt: { switch: 'onOff' as const, tiles: [0, 1, 2, 3].map(() => new Uint8Array(64)) } } // prettier-ignore
const BLUE_SLOT = { charBase: 2, tiles: [2, 3, 4, 0].map(v => new Uint8Array(64).fill(v)), alt: { switch: 'blue' as const, tiles: [0, 1, 2, 3].map(i => new Uint8Array(64).fill(7, 0, i === 3 ? 32 : 64)) } } // prettier-ignore

/** Color index c of row r is [r * 16 + c, 100, 200]; index 0 is transparent. */
const COLORS: RgbaColor[] = Array.from({ length: 256 }, (_, i) => (i % 16 === 0 ? [0, 0, 0, 0] : [i, 100, 200, 255])) // prettier-ignore

/**
 * Inputs with tile 1 (chars 1-4, one per quadrant), empty tile 0, tile 2
 * hidden until blue is on, tile 4 drawn until ON/OFF is on, and the eight
 * pipe tiles whose variant v draws char 1 in palette row v. Tiles sit at
 * their own ids, as the Map16 table does.
 */
function inputs(grid: number[][], isVertical: boolean, screenCount: number): L1Inputs {
  const tiles: Map16Tile[] = []
  const put = (t: Map16Tile) => (tiles[t.id] = t)
  put(tile(0, [sub(0), sub(0), sub(0), sub(0)]))
  put(tile(1, [sub(1), sub(2), sub(3), sub(4)]))
  put(tile(2, [sub(5), sub(5), sub(5), sub(5)])) // hidden: blank until blue is on
  put(tile(3, [sub(1), sub(1), sub(1), sub(1)])) // cites no switched char
  put(tile(4, [sub(6), sub(6), sub(6), sub(6)])) // vanishes: drawn until ON/OFF is on
  const pipeVariants = [0, 1, 2, 3].map(
    v =>
    Array.from({ length: PIPE_VARIANT_TILE_COUNT }, (_, i) => tile(PIPE_VARIANT_TILE_START + i, [sub(1, v), sub(1, v), sub(1, v), sub(1, v)])), // prettier-ignore
  )
  for (let i = 0; i < PIPE_VARIANT_TILE_COUNT; i++) put(tile(PIPE_VARIANT_TILE_START + i, [sub(0), sub(0), sub(0), sub(0)])) // prettier-ignore
  return {
    header: parseLevelHeader([0, 0, 0, 0, 0]),
    isVertical,
    screenCount,
    grid,
    map16: { tiles, pipeVariants },
    rawVram: VRAM,
    anim: { frameCount: 1, intervalMs: 100, frames: [[BLUE_SLOT, ONOFF_SLOT]] },
    vram: VRAM,
    colors: COLORS,
    backArea: BACKDROP,
    switchArt: switchArtOf({ frameCount: 1, intervalMs: 100, frames: [[BLUE_SLOT, ONOFF_SLOT]] }, tiles, VRAM, { colors: COLORS }), // prettier-ignore
  }
}

const hGrid = (screens: number) => Array.from({ length: 27 }, () => new Array<number>(screens * 16).fill(0)) // prettier-ignore
const vGrid = (screens: number) => Array.from({ length: screens * 16 }, () => new Array<number>(32).fill(0)) // prettier-ignore

/** One channel of `fg` drawn at alpha `a` over `bg`, as the map composites. */
const blend = (fg: number, bg: number, a: number) => Math.round((fg * a + bg * (255 - a)) / 255)
/** A color on the screen door's dim squares, over the synthetic backdrop. */
const dim = (rgb: number[]) => [...rgb.map((v, c) => blend(v, BACKDROP[c]!, Math.round(255 * HIDDEN_TILE_DIM_ALPHA))), 255] // prettier-ignore

/** RGBA of pixel (x, y) in a screen buffer of `width` pixels. */
const px = (buf: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(buf.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))

describe('one renderer for the sheet and the map (synthetic)', () => {
  it('each quadrant draws its own color', () => {
    const i = inputs(hGrid(1), false, 1)
    i.grid[0]![0] = 1
    const buf = drawL1Screen(i, 0)
    expect([px(buf, 256, 3, 3)[0], px(buf, 256, 11, 3)[0], px(buf, 256, 3, 11)[0], px(buf, 256, 11, 11)[0]]).toEqual([1, 2, 3, 4]) // prettier-ignore
  })

  it('a hidden cell is its switched-on art in the screen door over the backdrop', () => {
    const i = inputs(hGrid(1), false, 1)
    i.grid[0]![0] = 2
    const buf = drawL1Screen(i, 0)
    expect(px(buf, 256, 5, 1)).toEqual([7, 100, 200, 255]) // x + y even: full strength
    expect(px(buf, 256, 6, 1)).toEqual(dim([7, 100, 200])) // odd: 25% over the backdrop
  })

  it('a sheet atlas cell and a map cell are the same bytes, hidden art included', () => {
    const i = inputs(hGrid(1), false, 1)
    const def = { ...i.map16.tiles[2]!, id: 0 }
    const alt = i.switchArt.get(2)!.alts[0]!.rgba
    const b64 = (b: Uint8ClampedArray) => Buffer.from(b).toString('base64')
    const { atlas, atlasWidth } = buildTileAtlas([def], VRAM, { colors: COLORS })
    const alternates = [{ kinds: ['blue' as const], altRgbaBase64: b64(alt), hidden: true }]
    const sheet = { width: atlasWidth, tilesPerRow: 16, tiles: [{ id: 0, alternates }] }
    const browsed = withHiddenTiles(atlas, sheet, s => new Uint8ClampedArray(Buffer.from(s, 'base64'))) // prettier-ignore
    const cell = new Uint8ClampedArray(16 * 16 * 4)
    for (let y = 0; y < 16; y++) cell.set(browsed.subarray(y * atlasWidth * 4, y * atlasWidth * 4 + 64), y * 64) // prettier-ignore
    expect(b64(cell)).toBe(b64(renderCell(def, VRAM, { colors: COLORS }, alt)))
    expect([cell[3], cell[7]]).toEqual([255, 64]) // the screen door, not the bare transparent tile
  })
})

describe('char switches on the map (synthetic)', () => {
  const blueOn = { blue: true, silver: false, onOff: false }
  const cells = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    const out = new Set<string>()
    for (let i = 0; i < a.length; i += 4)
      if (a[i] !== b[i]) out.add(`${Math.floor((i / 4) % 256 / 16)},${Math.floor(i / 4 / 256 / 16)}`) // prettier-ignore
    return [...out]
  }

  it('blue on swaps exactly the cells whose chars it touches, and only those quadrants', () => {
    const i = inputs(hGrid(1), false, 1)
    i.grid[0]![0] = 1 // chars 1-4: tl stays, tr/bl/br are switched
    i.grid[0]![1] = 3 // char 1 only
    const off = drawL1Screen(i, 0)
    const on = drawL1Screen(i, 0, blueOn)
    expect(cells(off, on)).toEqual(['0,0'])
    // And through the screen the wire carries.
    const wire = (sw?: typeof blueOn) =>
      (screenResult(i, 0, sw) as { rgbaBase64: string }).rgbaBase64
    expect(wire(blueOn)).not.toBe(wire())
    expect([px(on, 256, 3, 3)[0], px(on, 256, 11, 3)[0], px(on, 256, 3, 11)[0], px(on, 256, 11, 11)[0]]).toEqual([1, 7, 7, 7]) // prettier-ignore
  })

  it('a hidden tile goes from its screen door to full art when its switch is on', () => {
    const i = inputs(hGrid(1), false, 1)
    i.grid[0]![0] = 2
    expect(px(drawL1Screen(i, 0), 256, 6, 1)).toEqual(dim([7, 100, 200])) // a dim square, off
    const on = drawL1Screen(i, 0, blueOn)
    expect(px(on, 256, 6, 1)).toEqual([7, 100, 200, 255]) // the switched chars, in full
    expect(px(on, 256, 5, 5)).toEqual([...BACKDROP]) // and no overlay where they are clear
  })

  it('another switch leaves a blue-hidden tile in its screen door', () => {
    const i = inputs(hGrid(1), false, 1)
    i.grid[0]![0] = 2
    const silver = drawL1Screen(i, 0, { blue: false, silver: true, onOff: false })
    expect(px(silver, 256, 5, 1)).toEqual(px(drawL1Screen(i, 0), 256, 5, 1))
    expect(px(silver, 256, 5, 1)).not.toEqual([...BACKDROP])
  })

  it('a tile its switch blanks shows its switches-off art in the screen door', () => {
    const i = inputs(hGrid(1), false, 1)
    i.grid[0]![0] = 4
    const onOff = drawL1Screen(i, 0, { blue: false, silver: false, onOff: true })
    expect(px(onOff, 256, 5, 5)).toEqual([4, 100, 200, 255])
    expect(px(onOff, 256, 6, 5)).toEqual(dim([4, 100, 200]))
  })

  it('with its switch off, or another on, that tile is drawn as it is', () => {
    const i = inputs(hGrid(1), false, 1)
    i.grid[0]![0] = 4
    expect(px(drawL1Screen(i, 0), 256, 5, 5)).toEqual([4, 100, 200, 255])
    expect(px(drawL1Screen(i, 0, blueOn), 256, 5, 5)).toEqual([4, 100, 200, 255])
  })

  it('a tile blank in every state stays blank', () => {
    const i = inputs(hGrid(1), false, 1)
    i.grid[0]![0] = 0
    for (const sw of [undefined, blueOn, { blue: false, silver: false, onOff: true }])
      expect(px(drawL1Screen(i, 0, sw), 256, 5, 5)).toEqual([...BACKDROP])
  })

  it('palaces and switches both key a cached screen', () => {
    const flags = { yellow: true, green: false, red: false, blue: false }
    expect(screenKey(flags, { blue: false, silver: false, onOff: true }, 3)).toBe('1000:001:3')
  })
})

describe('palace art (synthetic)', () => {
  it('takes the picture more than half the tilesets agree on, or refuses', () => {
    const id = (v: string) => v
    expect(majority(['a', 'a', 'b'], id)).toEqual({ pick: 'a', count: 2 })
    expect(majority(['a', 'b', undefined, 'a'], id)).toEqual({ count: 2 }) // absent votes count against
    expect(majority(['a', 'b'], id)).toEqual({ count: 1 })
  })

  // A tileset's vote: its [uncleared, cleared] block, drawn in color `c`, citing CGRAM `row`.
  const vote = (c: number, row = 5) =>
    [0, 1].map(k => ({ def: tile(k, [sub(1, row), sub(1, row), sub(1, row), sub(1, row)]), rgba: new Uint8ClampedArray(1024).fill(c + k) })) // prettier-ignore

  it('draws the majority picture', () => {
    const art = choosePalaceArt('blue', [vote(10), vote(10), vote(20)])
    expect('uncleared' in art && art.uncleared[0]).toBe(10)
  })

  it('refuses a split vote, saying the tilesets disagree, never taking tileset 0', () => {
    const art = choosePalaceArt('blue', [vote(10), vote(20), vote(30), undefined], 'unused')
    expect(art).toEqual({ reason: 'The blue block cannot be drawn: 1 of 4 tilesets agree; no majority' }) // prettier-ignore
  })

  it('gives the per-tileset reason only when no tileset voted', () => {
    expect(choosePalaceArt('red', [undefined, undefined], 'No object reaches it')).toEqual({ reason: 'The red block cannot be drawn: No object reaches it' }) // prettier-ignore
  })

  it.each([0, 3])('refuses a block citing CGRAM row %i, which a level variant sets', row => {
    expect(choosePalaceArt('green', [vote(10, row), vote(10, row)])).toEqual({ reason: expect.stringMatching(/palette variant/) }) // prettier-ignore
    expect(choosePalaceArt('green', [vote(10, 4), vote(10, 4)])).toHaveProperty('cleared')
  })

  const px16 = new Uint8ClampedArray(1024).fill(9)
  const art = { yellow: { uncleared: px16, cleared: px16 }, green: { reason: 'nope' }, red: { reason: 'r' }, blue: { reason: 'b' } } // prettier-ignore

  it('an unreadable palace falls back to its reason', () => {
    const icons = palaceIconsOf(art)
    expect(icons[0]).toMatchObject({ palace: 'yellow', uncleared: expect.any(String) })
    expect(icons[1]).toEqual({ palace: 'green', unavailable: 'nope' })
  })

  it('switch buttons with no readable art say why, and a map that cannot be built names its reason', () => {
    const empty = new RomFile('e.sfc', Buffer.alloc(0x80000, 0))
    // No P-switch routine, no animation (so no ON/OFF alternate) on this map.
    const r = toolbarArtOf(empty, { ok: true, inputs: { ...inputs(hGrid(1), false, 1), anim: null } }, art) // prettier-ignore
    if (r.status !== 'ok') throw new Error(r.status)
    expect(r.switchArt).toEqual({})
    expect(Object.keys(r.switchUnavailable).sort()).toEqual(['blue', 'onOff', 'silver'])
    expect(r.switchUnavailable.onOff).toMatch(/ON\/OFF/)
    const failed = toolbarArtOf(empty, { ok: false, reason: 'no level data' }, art)
    if (failed.status !== 'ok') throw new Error(failed.status)
    expect(failed.switchUnavailable).toEqual({ blue: 'no level data', silver: 'no level data', onOff: 'no level data' }) // prettier-ignore
    expect(failed.icons[1]).toEqual({ palace: 'green', unavailable: 'nope' })
  })
})

describe('screens (synthetic)', () => {
  it('fills the backdrop where L1 is transparent', () => {
    const buf = drawL1Screen(inputs(hGrid(1), false, 1), 0)
    expect(px(buf, 256, 100, 300)).toEqual([...BACKDROP])
  })

  it('a horizontal seam: column 15 ends screen 0, column 16 starts screen 1', () => {
    const g = hGrid(2)
    g[26]![15] = 1
    g[26]![16] = 1
    const m = inputs(g, false, 2)
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
    const m = inputs(g, true, 2)
    const s0 = drawL1Screen(m, 0)
    const s1 = drawL1Screen(m, 1)
    expect(px(s0, 512, 511, 255)[0]).toBe(4)
    expect(px(s1, 512, 0, 0)[0]).toBe(1)
    expect(px(s1, 512, 511, 255)[0]).toBe(BACKDROP[0])
  })

  it('each screen draws the pipe set MAP16AppTable gives its strips', () => {
    const g = hGrid(5)
    for (let s = 0; s < 5; s++) g[0]![s * 16] = PIPE_VARIANT_TILE_START
    const m = inputs(g, false, 5)
    // Variant v draws palette row v, whose color 1 has red channel v*16+1.
    const rows = [0, 1, 2, 3, 4].map(s => (px(drawL1Screen(m, s), 256, 0, 0)[0]! - 1) / 16)
    expect(rows).toEqual([0, 1, 2, 3, 0])
  })

  it('bounds the screen index by the map screen count, not the grid width', () => {
    // A handler that wrote past the end leaves a grid wider than the map.
    const m = inputs(hGrid(3), false, 2)
    expect(screenResult(m, 1)).toMatchObject({ status: 'ok', screenCount: 2, width: 256, height: 432 }) // prettier-ignore
    for (const bad of [2, -1, 0.5]) {
      const r = screenResult(m, bad)
      expect(r.status).toBe('unavailable')
      if (r.status === 'unavailable') expect(r.reason).toMatch(/2 screens/)
    }
    expect(screenResult((inputs(vGrid(1), true, 1)), 0)).toMatchObject({ width: 512, height: 256, orientation: 'vertical' }) // prettier-ignore
  })
})

// ── Synthetic ROM reads ──────────────────────────────────────────────────────

/**
 * LoadLevel's boss-mode check shape (bank_05.asm:431-437), synthetic bytes:
 * three CMP #imm / BEQ, every branch landing at +15.
 */
const noL1Check = (m = [0x09, 0x0b, 0x10], disp = [0x08, 0x04, 0x00]) => [0xad, 0x25, 0x19, 0xc9, m[0]!, 0xf0, disp[0]!, 0xc9, m[1]!, 0xf0, disp[1]!, 0xc9, m[2]!, 0xf0, disp[2]!] // prettier-ignore

/** A fake SmwRom: one level's raw bytes, a synthetic VerticalTable, an empty ROM behind it. */
function fakeRom(levelMode: number): SmwRom {
  const buf = Buffer.alloc(0x40000, 0)
  buf[0x7fd5] = 0x20
  buf.set(noL1Check(), 0x1000)
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

  it('a palace routine that declines its tile refuses rather than drawing empty', () => {
    // Dispatch reaches the yellow routine, but its LDA.L opcode is gone.
    const rom = new RomFile('d.sfc', Buffer.alloc(0x80000, 0))
    rom.writeAt(ADDR_EXTENDED_DISPATCH + 5 * 3, [0x83, 0xb5, 0x0d])
    expect(switchBlockTile(rom, 0, 'yellow')).toEqual({ reason: expect.stringMatching(/not the stock one/) }) // prettier-ignore
  })

  it('a ROM that routes no object to a palace routine names why', () => {
    const t = switchBlockTile(new RomFile('e.sfc', Buffer.alloc(0x80000, 0)), 0, 'yellow')
    expect(t).toEqual({ reason: expect.stringMatching(/yellow/) })
  })
})

describe('readNoL1Modes (synthetic)', () => {
  const romWith = (...sites: number[][]) => {
    const buf = Buffer.alloc(0x40000, 0)
    buf[0x7fd5] = 0x20
    sites.forEach((b, i) => buf.set(b, 0x1000 + i * 0x100))
    return new RomFile('m.sfc', buf)
  }
  it('reads the modes from the CMP operands, not a constant', () => {
    expect(readNoL1Modes(romWith(noL1Check()))).toEqual({ modes: new Set([0x09, 0x0b, 0x10]) })
    expect(readNoL1Modes(romWith(noL1Check([0x0a, 0x0c, 0x11])))).toEqual({ modes: new Set([0x0a, 0x0c, 0x11]) }) // prettier-ignore
  })
  it.each([
    ['absent', romWith()],
    ['twice', romWith(noL1Check(), noL1Check())],
    ['branches to different places', romWith(noL1Check(undefined, [0x08, 0x05, 0x00]))],
  ])('refuses when the check is %s', (_, rom) => {
    expect(readNoL1Modes(rom)).toEqual({ reason: expect.stringMatching(/bank_05.asm:431-437/) })
  })
  it('a ROM whose check cannot be read refuses the map', () => {
    const rom = fakeRom(0)
    rom.rom.buffer.fill(0, 0x1000, 0x1010)
    expect(buildL1Inputs(rom, 0x105, UNCLEARED)).toEqual({ ok: false, reason: expect.stringMatching(/431-437/) }) // prettier-ignore
  })
})

describe('assembleL1Inputs (synthetic)', () => {
  // Every palette word distinct, so any swapped argument changes the CGRAM.
  const palRom = new RomFile('p.sfc', Buffer.alloc(0x40000, 0))
  for (let a = 0x00b0a0; a < 0x00b700; a += 2) palRom.writeAt(a, [(a * 37) & 0xff, ((a * 37) >> 8) & 0x7f]) // prettier-ignore
  const header = { ...parseLevelHeader([0, 0, 0, 0, 0]), levelLength: 2, bgPalette: 1, fgPalette: 2, spritePalette: 3, bgColor: 5 } // prettier-ignore
  const col1 = { bg: 0x1234, obj: 0x0421 }
  const backAreas: RgbaColor[] = Array.from({ length: 8 }, (_, i) => [i * 30, 7, 7, 255])
  const slot = (charBase: number) => ({ charBase, tiles: [0, 1, 2, 3].map(() => new Uint8Array(64).fill(1)) }) // prettier-ignore
  const anim = (charBase: number) => ({
    frameCount: 1,
    intervalMs: 100,
    frames: [[slot(charBase)]],
  })
  const readings = (over: Partial<L1Readings> = {}): L1Readings => ({
    header,
    isVertical: false,
    grid: hGrid(3), // wider than the header's 2 screens
    map16: { tiles: [], pipeVariants: [] },
    rawVram: {},
    stockAnim: { ok: true, data: anim(0x10) },
    unreached: null,
    exAnim: anim(0x20),
    custom: null,
    romPalettes: loadRomPalettes(palRom, 1),
    backAreas,
    col1,
    paletteAnim: { context: 'level', available: true, notes: [], targets: [{ cgramIdx: 0x21, colors: [0x03e0] }] } as unknown as PaletteAnimContext, // prettier-ignore
    ...over,
  })
  const pal = loadRomPalettes(palRom, 1)
  const withFrame0 = (c: RgbaColor[]) => c.map((v, i) => (i === 0x21 ? bgr555ToRgba(0x03e0) : v))

  it('builds CGRAM from BG, FG and sprite palettes in that order, with the read column 1', () => {
    const got = assembleL1Inputs(readings()).colors
    expect(got).toEqual(withFrame0(buildLevelCgram(pal, 1, 2, 3, col1).colors))
    expect(got).not.toEqual(withFrame0(buildLevelCgram(pal, 2, 1, 3, col1).colors))
    expect(got).not.toEqual(withFrame0(buildLevelCgram(pal, 1, 2, 3, STOCK_COL1).colors))
  })

  it('indexes the backdrop by the back-area color, or takes the override block', () => {
    expect(assembleL1Inputs(readings()).backArea).toEqual(backAreas[5])
    const custom = { backAreaColor: [9, 8, 7, 255] as RgbaColor, rows: [], colors: COLORS }
    const r = assembleL1Inputs(readings({ custom }))
    expect(r.backArea).toEqual([9, 8, 7, 255])
    expect(r.colors).toEqual(withFrame0(COLORS))
  })

  it('applies palette frame 0 only when the routine was read, noting it otherwise', () => {
    expect(assembleL1Inputs(readings()).colors[0x21]).toEqual(bgr555ToRgba(0x03e0))
    const blind = assembleL1Inputs(readings({ paletteAnim: { context: 'level', available: false, targets: [], notes: ['hooked'] } as unknown as PaletteAnimContext })) // prettier-ignore
    expect(blind.colors).toEqual(buildLevelCgram(pal, 1, 2, 3, col1).colors)
    expect(blind.animNote).toMatch(/hooked/)
  })

  it('merges ExAnimation into the stock frames, and carries a frames error into the note', () => {
    const r = assembleL1Inputs(readings())
    expect(r.anim!.frames[0]!.map(s => s.charBase)).toEqual([0x10, 0x20])
    const noStock = assembleL1Inputs(readings({ stockAnim: { ok: false, reason: 'GFX33 unreadable' }, exAnim: null })) // prettier-ignore
    expect(noStock.animNote).toMatch(/GFX33 unreadable/)
  })

  it('reads each hidden tile its switched-on art from its own chars', () => {
    const blank = () => new Uint8Array(64)
    const lit = () => new Uint8Array(64).fill(1)
    const switched = { charBase: 0x10, tiles: [0, 1, 2, 3].map(blank), alt: { switch: 'blue' as const, tiles: [0, 1, 2, 3].map(lit) } } // prettier-ignore
    // A P-switch coin's shape: drawn both ways, so it has an alternate but is not hidden.
    const two = () => new Uint8Array(64).fill(2)
    const coin = { charBase: 0x14, tiles: [0, 1, 2, 3].map(lit), alt: { switch: 'blue' as const, tiles: [0, 1, 2, 3].map(two) } } // prettier-ignore
    // Dense, as a Map16 table is: every id up to 6 defined.
    const tiles = Array.from({ length: 7 }, (_, id) => tile(id, [sub(0), sub(0), sub(0), sub(0)]))
    tiles[5] = tile(5, [sub(0x10), sub(0x11), sub(0x12), sub(0x13)])
    tiles[6] = tile(6, [sub(0x14), sub(0x15), sub(0x16), sub(0x17)])
    const r = assembleL1Inputs(
      readings({
        rawVram: { fg1: Array.from({ length: 0x20 }, blank) },
        stockAnim: {
          ok: true,
          data: { frameCount: 1, intervalMs: 100, frames: [[switched, coin]] },
        },
        exAnim: null,
        map16: { tiles, pipeVariants: [] },
      }),
    )
    // Tile 6 has a switch alternate too; both ways it is drawn, so neither state gets a 25% picture.
    expect([...r.switchArt.keys()].sort()).toEqual([5, 6])
    // Tile 5 is blank off; tile 6 is drawn both ways.
    expect(r.switchArt.get(5)!.off[3]).toBe(0)
    expect(r.switchArt.get(6)!.off[3]).toBe(255)
  })

  it('counts screens from the header, not the grid', () => {
    expect(assembleL1Inputs(readings()).screenCount).toBe(2)
  })
})

describe('palette animation frame 0 (synthetic)', () => {
  // Row 0 color 1 is animated; its frame 0 is pure green, not the stored color.
  const level = {
    context: 'level',
    available: true,
    notes: [],
    targets: [{ cgramIdx: 1, colors: [0x03e0, 0x001f] }],
  } as unknown as PaletteAnimContext

  it('a drawn pixel of an animated color shows frame 0, not the stored color', () => {
    const i = inputs(hGrid(1), false, 1)
    i.grid[0]![0] = 1 // tl is char 1, color index 1, palette row 0
    i.colors = applyPaletteFrame0(COLORS, level).colors
    const buf = drawL1Screen(i, 0)
    expect(px(buf, 256, 3, 3)).toEqual([...bgr555ToRgba(0x03e0)])
    expect(px(buf, 256, 11, 3)[0]).toBe(2) // an unanimated color is untouched
  })

  it('an unreadable routine keeps the stored colors and says so', () => {
    const r = applyPaletteFrame0(COLORS, { ...level, available: false, targets: [], notes: ['hooked'] }) // prettier-ignore
    expect(r.colors).toEqual(COLORS)
    expect(r.note).toMatch(/hooked/)
  })
})

describe('switch-block tiles from the ROM own dispatch (synthetic)', () => {
  /**
   * The four routines at their stock addresses, sharing their bodies as the
   * ROM does (bank_0D.asm:3736-3748, :4209-4232), with each palace's X and
   * each state's table distinct: tables hold 4 different low bytes per state.
   */
  function palaceRom(): RomFile {
    const rom = new RomFile('s.sfc', Buffer.alloc(0x80000, 0))
    const lda = (at: number, table: number) => rom.writeAt(at, [0xbf, table & 0xff, (table >> 8) & 0xff, table >> 16]) // prettier-ignore
    // Extended objects 5 (yellow) and 6 (green).
    rom.writeAt(ADDR_EXTENDED_DISPATCH + 5 * 3, [0x83, 0xb5, 0x0d])
    rom.writeAt(ADDR_EXTENDED_DISPATCH + 6 * 3, [0x8b, 0xb5, 0x0d])
    rom.writeAt(0x0db58c, [0x00]) // green: LDX #$00
    rom.writeAt(0x0db584, [0x01]) // yellow: LDX #$01
    lda(0x0db583 + 20, 0x0e8000) // uncleared table
    lda(0x0db583 + 30, 0x0e8010) // cleared table
    rom.writeAt(0x0e8000, [0x40, 0x41])
    rom.writeAt(0x0e8010, [0x50, 0x51])
    // Tileset 0's dispatcher at $0E9000; standard objects 7 (blue), 8 (red).
    rom.writeAt(ADDR_TILESET_DISPATCH, [0x00, 0x90, 0x0e])
    rom.writeAt(0x0e9000 + 10 + 6 * 3, [0x16, 0xb9, 0x0d])
    rom.writeAt(0x0e9000 + 10 + 7 * 3, [0x1e, 0xb9, 0x0d])
    rom.writeAt(0x0db917, [0x00]) // blue: LDX #$00
    rom.writeAt(0x0db91f, [0x01]) // red: LDX #$01
    lda(0x0db916 + 36, 0x0e8020)
    lda(0x0db916 + 50, 0x0e8030)
    rom.writeAt(0x0e8020, [0x60, 0x61])
    rom.writeAt(0x0e8030, [0x70, 0x71])
    return rom
  }

  it('finds the objects the tables route to each routine, by their own numbers', () => {
    const rom = palaceRom()
    expect(objectsDispatchedTo(rom, 0, handle_0DB583)).toEqual([{ type: 'extended', objectNumber: 5 }]) // prettier-ignore
    expect(objectsDispatchedTo(rom, 0, handle_0DB916)).toEqual([{ type: 'standard', objectNumber: 7 }]) // prettier-ignore
  })

  it('reads each palace its own tile, page 0 uncleared and page 1 cleared', () => {
    const rom = palaceRom()
    expect(PALACES.map(p => switchBlockTile(rom, 0, p))).toEqual([
      { uncleared: 0x041, cleared: 0x151 }, // yellow
      { uncleared: 0x040, cleared: 0x150 }, // green
      { uncleared: 0x061, cleared: 0x171 }, // red
      { uncleared: 0x060, cleared: 0x170 }, // blue
    ])
  })
})

describe('L1ModelCache (synthetic)', () => {
  it('keys on the bytes array, the map and the flags, and passes them to the builder', () => {
    const calls: [number, SwitchFlags][] = []
    const cache = new L1ModelCache((_rom, index, flags) => {
      calls.push([index, flags])
      return { ok: false, reason: 'stub' }
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

function distinctColors(buf: Uint8ClampedArray): number {
  const seen = new Set<number>()
  for (let i = 0; i < buf.length; i += 4) seen.add((buf[i]! << 16) | (buf[i + 1]! << 8) | buf[i + 2]!) // prettier-ignore
  return seen.size
}

const buildTiles16 = (t: number) => loadMap16WithPipeVariants(freshRomFile(), t).tiles
const freshRomFile = () => RomFile.load(romPath(VANILLA))

describe.skipIf(!romPresent)('map-screen (vanilla ROM)', () => {
  const bytes = romPresent ? new Uint8Array(fs.readFileSync(romPath(VANILLA))) : new Uint8Array()
  const rom = romPresent ? new SmwRom(RomFile.fromBytes(romPath(VANILLA), Buffer.from(bytes))) : null! // prettier-ignore
  const model = (index: number, flags: SwitchFlags = UNCLEARED): L1Inputs => {
    const r = buildL1Inputs(rom, index, flags)
    if (!r.ok) throw new Error(r.reason)
    return r.inputs
  }

  // A regression oracle independent of renderCell: SHA-256 of whole screens
  // drawn by the pre-#421-shared-renderer tile path at c6e39a15 (Tile.render
  // over BufferRenderTarget), hidden overlay off, switches off. Hashes only,
  // never ROM bytes.
  it.each([
    ['105', 0, '225f7f91b26303b921afe60c72cc1e33dc54603029503056f3e9c2441f586b7e'],
    ['105', 7, 'abd3c83754490966fd7c5de21138494a6b4b08167c0e1804a5b0da72f4392d89'],
    ['109', 0, '52ebd71afcfbc0847f9309d31d01eae3754432e766b4412307202c25a1609010'],
  ])('map $%s screen %i draws the same pixels as the old tile path', (slot, screen, sha) => {
    const m = model(parseInt(slot, 16))
    const buf = drawL1Screen({ ...m, switchArt: new Map() }, screen)
    expect(createHash('sha256').update(buf).digest('hex')).toBe(sha)
  })

  // $105 is horizontal, 20 screens: 7, 8 and 17 hold pipes, 17's not set 0.
  // $109 is vertical, 7 screens of 32 x 16 tiles.
  it.each([
    ['105', 0],
    ['105', 7],
    ['105', 8],
    ['105', 17],
    ['109', 0],
    ['109', 1],
  ])('map $%s screen %i: pipes draw their own set, and the screen is not blank', (slot, screen) => {
    // prettier-ignore
    const m = model(parseInt(slot, 16))
    const drawn = drawL1Screen(m, screen)
    expect(distinctColors(drawn)).toBeGreaterThan(4)
    const [w, h] = m.isVertical ? [32, 16] : [16, 27]
    const [x0, y0] = m.isVertical ? [0, screen * 16] : [screen * 16, 0]
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const pipe = m.grid[y0 + y]![x0 + x]! - PIPE_VARIANT_TILE_START
        if (pipe < 0 || pipe >= PIPE_VARIANT_TILE_COUNT) continue
        // The strip counter's own set for this cell's column (row, vertical).
        const set = pipeVariantIndex(m.isVertical ? y0 + y : x0 + x)
        const cell = renderCell(m.map16.pipeVariants[set]![pipe]!, m.vram, { colors: m.colors })
        for (let i = 0; i < 256; i++) {
          if (cell[i * 4 + 3] !== 255) continue
          const at = ((y * 16 + (i >> 4)) * w * 16 + x * 16 + (i & 15)) * 4
          expect([...drawn.subarray(at, at + 3)]).toEqual([...cell.subarray(i * 4, i * 4 + 3)])
        }
      }
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
    for (const i of palaceIconsOf(palaceArt(rom.rom))) {
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

  it('the Yoshi coin at column 17, rows 16-17 draws frame 0 of $64, not the stored color', () => {
    const m = model(0x105)
    expect([m.grid[16]![17], m.grid[17]![17]]).toEqual([0x02d, 0x02e])
    const target = detectPaletteAnimation(rom.rom).level.targets.find(t => t.cgramIdx === 0x64)!
    const frame0 = bgr555ToRgba(target.colors[0]!).join(',')
    const stored = levelColors(rom.rom, 0x105, parseLevelHeader(rom.getLevelRawData(0x105)!), { bg: 0, obj: 0 }) // prettier-ignore
    // Column 17 is screen 1, local column 1.
    const buf = drawL1Screen(m, 1)
    const cell = new Set<string>()
    for (let y = 256; y < 288; y++)
      for (let x = 16; x < 32; x++) cell.add(px(buf, 256, x, y).join(','))
    expect(cell.has(frame0)).toBe(true)
    expect(stored.colors[0x64]!.join(',')).not.toBe(frame0)
    expect(cell.has(stored.colors[0x64]!.join(','))).toBe(false)
  })

  it('a hidden $02A cell on $014 is its switched-on art in the screen door over the backdrop', () => {
    const m = model(0x014)
    expect(m.grid[13]![1]).toBe(0x02a) // screen 0, local column 1
    const alt = m.switchArt.get(0x02a)!.alts.find(x => x.kinds.join() === 'blue')!.rgba
    const own = renderCell(m.map16.tiles[0x02a]!, m.vram, { colors: m.colors })
    const buf = drawL1Screen(m, 0)
    let checked = 0
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const s = (y * 16 + x) * 4
        if (own[s + 3] !== 0 || alt[s + 3] === 0) continue
        const a = Math.round(255 * hiddenPixelStrength(x, y))
        const want = [0, 1, 2].map(c => Math.round((alt[s + c]! * a + m.backArea[c]! * (255 - a)) / 255)) // prettier-ignore
        expect(px(buf, 256, 16 + x, 13 * 16 + y).slice(0, 3)).toEqual(want)
        checked++
      }
    expect(checked).toBeGreaterThan(0)
  })

  it('palace icons are per ROM: the normal block on $014 too, never tileset 4 letters', () => {
    const art = palaceArt(rom.rom)
    const yellow = art.yellow
    if ('reason' in yellow) throw new Error(yellow.reason)
    const pal = { colors: buildLevelCgram(loadRomPalettes(rom.rom), 0, 0, 0, STOCK_COL1).colors }
    const drawnIn = (t: number) => renderCell(buildTiles16(t)[0x16b]!, loadVram(rom.rom, t), pal)
    // $105 is tileset 7; $014 is tileset 4, whose $16B is the palace's letters.
    expect(Buffer.from(yellow.cleared).equals(Buffer.from(drawnIn(7)))).toBe(true)
    expect(Buffer.from(yellow.cleared).equals(Buffer.from(drawnIn(4)))).toBe(false)
  })

  it('refuses a vanilla boss arena', () => {
    const r = mapScreen(new L1ModelCache(), bytes, romPath(VANILLA), 0x0d9, 0, UNCLEARED)
    expect(r).toMatchObject({ status: 'unavailable' })
  })
})
