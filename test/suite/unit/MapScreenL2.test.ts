/**
 * The map tab's L2 (background) and the layer order (#459, PR 2): the core's
 * `buildL2Inputs` (src/rom/model/L2Model.ts), the two-plane drawing in
 * theia/extension/src/node/map-screen.ts, and the build that adds both to L1's.
 * Synthetic cases run without a ROM; the corpus sweep at the end checks real slots.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { ADDR, SmwRom } from '../../../src/rom/SmwRom'
import * as Map16Real from '../../../src/rom/Map16'
import * as L2LoaderReal from '../../../src/rom/L2Loader'
import type * as Map16Mod from '../../../src/rom/Map16'
import type * as L2LoaderMod from '../../../src/rom/L2Loader'
import { SWITCH_FLAGS_UNCLEARED as UNCLEARED } from '../../../src/rom/ObjectExpander'
import type { Map16Tile } from '../../../src/rom/Map16'
import { buildL1Inputs, type L1Inputs } from '../../../src/rom/model/L1Model'
import { buildL2Inputs, type L2Inputs } from '../../../src/rom/model/L2Model'
import {
  buildMapInputs,
  drawL2Planes,
  L1ModelCache,
  mapScreen,
  readMapEntrances,
  screenResult,
  toolbarArtOf,
  type MapInputs,
} from '../../../theia/extension/src/node/map-screen'
import { MAP_PLANE_KEYS } from '../../../theia/extension/src/common/project-protocol'
import { palaceArt } from '../../../src/rom/SwitchArt'
import { renderMap16Tile } from '../../../src/rom/TileRenderer'
import { VANILLA, MAGIC, hasRom, romPath } from '../support/corpus'
import { plantUploaderTable, IMAGE_AT, NONE_AT, OBJ_A_AT } from '../support/l2UploaderRom'
import { bgModeRom } from '../support/bgModeRom'
import {
  plantOverworldTiles,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'
import { FG_GATE_MAPS } from '../../../tools/scripts/fgGateMaps'
import { SKIP_CHAIN_B_AT, writeStockSkipChain } from '../support/skipChain'
import { hGrid, inputs as baseInputs, px, sub, tile, vGrid } from '../support/mapInputs'

// Level mode 1: mode 0 is one the game loads no L2 objects in (#637), which the helper's zero header would hit.
const inputs: typeof baseInputs = (...a) => {
  const m = baseInputs(...a)
  return { ...m, header: { ...m.header, levelMode: 1 } }
}

vi.mock('../../../src/rom/Map16', async importOriginal => {
  const real = await importOriginal<typeof Map16Mod>()
  return { ...real, readL2Map16Table: vi.fn(real.readL2Map16Table), loadMap16Tiles: vi.fn(real.loadMap16Tiles) } // prettier-ignore
})
vi.mock('../../../src/rom/L2Loader', async importOriginal => {
  const real = await importOriginal<typeof L2LoaderMod>()
  return { ...real, loadL2Objects: vi.fn(real.loadL2Objects) }
})
afterEach(() => {
  vi.mocked(Map16Real.readL2Map16Table).mockReset()
  vi.mocked(Map16Real.loadMap16Tiles).mockReset()
  vi.mocked(L2LoaderReal.loadL2Objects).mockReset()
})

const prio = (char: number, palette = 0) => sub(char, palette, true)
const nullGrid = (rows: number, cols: number) => Array.from({ length: rows }, () => new Array<number | null>(cols).fill(null)) // prettier-ignore
const tiles2 = (...t: Map16Tile[]) => t.reduce<Map16Tile[]>((a, x) => ((a[x.id] = x), a), [])
const solid = tile(1, [sub(1), sub(1), sub(1), sub(1)])
const l2Of = (grid: (number | null)[][], tiles: Map16Tile[], dy = 0, kind: L2Inputs['kind'] = 'objects'): L2Inputs => ({ kind, grid, tiles, dy }) // prettier-ignore
const mapOf = (m: L1Inputs, l2?: MapInputs['l2'], orderNote?: string): MapInputs => ({ ...m, l2, orderNote }) // prettier-ignore
const opaque = (buf: Uint8ClampedArray | null, width: number, x: number, y: number) =>
  buf !== null && px(buf, width, x, y)[3] === 255
const decode = (b64: string | null) => (b64 === null ? null : new Uint8ClampedArray(Buffer.from(b64, 'base64'))) // prettier-ignore
const wireOf = (m: MapInputs, screen = 0, switches?: Parameters<typeof screenResult>[2]) => {
  const w = screenResult(m, screen, switches)
  if (w.status !== 'ok') throw new Error(w.status)
  return w
}

// ── Drawing ──────────────────────────────────────────────────────────────────

describe('L2 planes (synthetic)', () => {
  const l1 = inputs(hGrid(1), false, 1)

  it('a cell draws each quadrant in its own color, in the low plane when no priority bit is set', () => {
    const { l2Low, l2High } = drawL2Planes(l1, l2Of([[1]], tiles2(tile(1, [sub(1), sub(2), sub(3), sub(4)]))), 0) // prettier-ignore
    expect([px(l2Low!, 256, 3, 3)[0], px(l2Low!, 256, 11, 3)[0], px(l2Low!, 256, 3, 11)[0], px(l2Low!, 256, 11, 11)[0]]).toEqual([1, 2, 3, 4]) // prettier-ignore
    expect(l2High).toBeNull()
  })

  it('a priority subtile lands in l2High and leaves l2Low clear there', () => {
    const t = tile(1, [sub(1), prio(2), sub(3), sub(4)])
    const p = drawL2Planes(l1, l2Of([[1]], tiles2(t)), 0)
    expect([opaque(p.l2High, 256, 11, 3), opaque(p.l2Low, 256, 11, 3)]).toEqual([true, false])
    expect([opaque(p.l2Low, 256, 3, 3), opaque(p.l2High, 256, 3, 3)]).toEqual([true, false])
  })

  it('draws the cell column of the screen asked for, and nothing past the grid', () => {
    const grid = nullGrid(27, 32)
    grid[0]![16] = 1 // screen 1, column 0
    const l2 = l2Of(grid, tiles2(solid))
    const m = inputs(hGrid(3), false, 3)
    expect(opaque(drawL2Planes(m, l2, 1).l2Low, 256, 3, 3)).toBe(true)
    expect(drawL2Planes(m, l2, 0).l2Low).toBeNull()
    expect(drawL2Planes(m, l2, 2).l2Low).toBeNull() // beyond the grid's 2 screens: blank, no throw
  })

  it('applies Layer2YPos as a pixel shift: down, partly off the top, and off the screen', () => {
    const grid = nullGrid(27, 16)
    grid[0]![0] = 1
    const at = (dy: number) => drawL2Planes(l1, l2Of(grid, tiles2(solid), dy), 0).l2Low
    expect([opaque(at(5), 256, 3, 4), opaque(at(5), 256, 3, 5), opaque(at(5), 256, 3, 20), opaque(at(5), 256, 3, 21)]).toEqual([false, true, true, false]) // prettier-ignore
    expect([opaque(at(-8), 256, 3, 0), opaque(at(-8), 256, 3, 7), opaque(at(-8), 256, 3, 8)]).toEqual([true, true, false]) // prettier-ignore
    expect(at(27 * 16)).toBeNull() // below the 432 px screen, inside the 512 px plane
  })

  it('a shifted grid wraps in the 512 px BG2 plane instead of leaving an empty band', () => {
    const grid = nullGrid(27, 16)
    grid[0]![0] = 1
    // Row 0 shifted up 100 px lands at 412 of the 512 px plane: on screen at 412-427.
    const up = drawL2Planes(l1, l2Of(grid, tiles2(solid), -100), 0).l2Low
    expect([opaque(up, 256, 3, 411), opaque(up, 256, 3, 412), opaque(up, 256, 3, 427), opaque(up, 256, 3, 428)]).toEqual([false, true, true, false]) // prettier-ignore
    // Row 26 shifted down 192 px wraps past the plane's end to 96.
    const down = nullGrid(27, 16)
    down[26]![0] = 1
    const d = drawL2Planes(l1, l2Of(down, tiles2(solid), 192), 0).l2Low
    expect([opaque(d, 256, 3, 95), opaque(d, 256, 3, 96), opaque(d, 256, 3, 111), opaque(d, 256, 3, 112)]).toEqual([false, true, true, false]) // prettier-ignore
  })

  it('a vertical map slices the shifted grid per screen, so a cell straddling the seam draws on both', () => {
    const m = inputs(vGrid(2), true, 2)
    const grid = nullGrid(32, 32)
    grid[15]![0] = 1 // level rows 240-255, shifted by 8 to 248-263
    const l2 = l2Of(grid, tiles2(solid), 8)
    const top = drawL2Planes(m, l2, 0).l2Low
    const bottom = drawL2Planes(m, l2, 1).l2Low
    expect([opaque(top, 512, 3, 247), opaque(top, 512, 3, 248), opaque(top, 512, 3, 255)]).toEqual([false, true, true]) // prettier-ignore
    expect([opaque(bottom, 512, 3, 0), opaque(bottom, 512, 3, 7), opaque(bottom, 512, 3, 8)]).toEqual([true, true, false]) // prettier-ignore
  })

  it('a vertical object stream is streamed, so it is not wrapped', () => {
    const m = inputs(vGrid(3), true, 3)
    const grid = nullGrid(48, 32)
    grid[0]![0] = 1
    const l2 = l2Of(grid, tiles2(solid), -8) // would reappear at 504 if wrapped
    expect(opaque(drawL2Planes(m, l2, 0).l2Low, 512, 3, 0)).toBe(true)
    expect(drawL2Planes(m, l2, 1).l2Low).toBeNull()
  })

  it('a vertical image is one fixed 512 px plane, so it wraps on every screen however far it is shifted', () => {
    // CODE_058883's image modes are Return058C70 (bank_05.asm:1023-1055): BG2 is never streamed.
    const m = inputs(vGrid(5), true, 5)
    const grid = nullGrid(80, 32)
    for (const row of grid.slice(0, 32)) row[0] = 1 // one plane of rows, repeated down the map
    const l2 = l2Of(grid, tiles2(solid), 1344, 'image') // $109's shift: 1344 mod 512 = 320
    for (const screen of [0, 1, 2, 3, 4])
      expect(drawL2Planes(m, l2, screen).l2Low, `screen ${screen}`).not.toBeNull()
  })

  it('L2 is drawn with the chars the switches that are on swap in, as L1 is', () => {
    const m = inputs(hGrid(1), false, 1)
    m.map16.tiles[1] = tile(1, [sub(2), sub(2), sub(2), sub(2)]) // char 2: color 2, solid color 7 with blue on
    const l2 = l2Of(nullGrid(27, 16), m.map16.tiles)
    l2.grid[0]![0] = 1
    const color = (blue: boolean) => px(decode(wireOf(mapOf(m, { ok: true, l2 }), 0, { blue, silver: false, onOff: false }).planes.l2Low)!, 256, 3, 3)[0] // prettier-ignore
    expect([color(false), color(true)]).toEqual([2, 7])
  })
})

const routeNote = 'No route from the overworld reaches this map, so it opens at the start.' // prettier-ignore

describe('the wire carries four planes in the view stacking order (synthetic)', () => {
  /** What the view shows: each plane over the ones below it, a covering pixel replacing what is under it. */
  const stack = (
    planes: Record<string, string | null>,
    order: readonly string[],
    x: number,
    y: number,
  ) =>
    order.reduce<number[] | null>((shown, k) => {
      const p = decode(planes[k]!)
      return p && opaque(p, 256, x, y) ? px(p, 256, x, y) : shown
    }, null)

  it('each key holds its own layer and priority', () => {
    const m = inputs(hGrid(1), false, 1)
    // L1 at cell 0: tl low, tr high. L2 at cell 1: bl low, br high; palette 1 so it is told apart.
    m.map16.tiles[1] = tile(1, [sub(1), prio(2), sub(3), sub(4)])
    m.grid[0]![0] = 1
    m.map16.tiles[2] = tile(2, [sub(0), sub(0), sub(3, 1), prio(4, 1)])
    const l2 = l2Of(nullGrid(27, 16), m.map16.tiles)
    l2.grid[0]![1] = 2
    const wire = wireOf(mapOf(m, { ok: true, l2 }))
    expect(Object.keys(wire.planes)).toEqual([...MAP_PLANE_KEYS])
    expect(MAP_PLANE_KEYS).toEqual(['l2Low', 'l1Low', 'l2High', 'l1High', 'l3Low', 'l3High'])
    const p = Object.fromEntries(MAP_PLANE_KEYS.map(k => [k, decode(wire.planes[k])]))
    const spots = [
      [3, 3],
      [11, 3],
      [16 + 3, 11],
      [16 + 11, 11],
    ] as const // cell 0 tl, tr; cell 1 bl, br
    const hits = (k: (typeof MAP_PLANE_KEYS)[number]) => spots.map(([x, y]) => opaque(p[k]!, 256, x, y)) // prettier-ignore
    expect(hits('l1Low')).toEqual([true, false, false, false])
    expect(hits('l1High')).toEqual([false, true, false, false])
    expect(hits('l2Low')).toEqual([false, false, true, false])
    expect(hits('l2High')).toEqual([false, false, false, true])
    expect(px(p.l2Low!, 256, 16 + 3, 11)[0]).toBe(1 * 16 + 3) // palette row 1
  })

  it('stacked in MAP_PLANE_KEYS order, L2 priority covers L1 low and L1 priority covers L2 priority', () => {
    const m = inputs(hGrid(1), false, 1)
    // One pixel, three layers: L1 low (palette 0), L2 high (palette 1), L1 high (palette 2); all char 1.
    m.map16.tiles[1] = tile(1, [sub(1), sub(0), sub(0), sub(0)])
    m.map16.tiles[2] = tile(2, [prio(1, 1), sub(0), sub(0), sub(0)])
    m.map16.tiles[3] = tile(3, [prio(1, 2), sub(0), sub(0), sub(0)])
    m.grid[0]![0] = 1
    const l2 = l2Of(nullGrid(27, 16), m.map16.tiles)
    l2.grid[0]![0] = 2
    const colorOf = (mm: MapInputs, order: readonly string[]) => stack(wireOf(mm).planes, order, 3, 3)![0] // prettier-ignore
    const both = mapOf(m, { ok: true, l2 })
    expect(colorOf(both, MAP_PLANE_KEYS)).toBe(1 * 16 + 1) // L2 priority over L1 low
    m.grid[0]![0] = 3
    expect(colorOf(both, MAP_PLANE_KEYS)).toBe(2 * 16 + 1) // L1 priority over L2 priority
    // The check can go red: the order reversed shows the other layer.
    m.grid[0]![0] = 1
    expect(colorOf(both, [...MAP_PLANE_KEYS].reverse())).toBe(0 * 16 + 1)
  })

  it('an unreadable background has null planes and a note, while L1 still draws', () => {
    const m = inputs(hGrid(1), false, 1)
    m.grid[0]![0] = 1
    const wire = wireOf(mapOf(m, { ok: false, reason: 'the table is gone' }))
    expect([wire.planes.l2Low, wire.planes.l2High]).toEqual([null, null])
    expect(wire.planes.l1Low).toBeTruthy()
    expect(wire.layerNotes).toEqual(['The background is not drawn: the table is gone'])
  })

  it('an unverified order is a note on a map that still draws both layers', () => {
    const m = inputs(hGrid(1), false, 1)
    const l2 = l2Of(nullGrid(27, 16), tiles2(solid))
    l2.grid[0]![0] = 1
    const wire = wireOf(mapOf(m, { ok: true, l2 }, 'because'))
    expect(wire.planes.l2Low).toBeTruthy()
    expect(wire.layerNotes).toEqual(['Layer order unverified, drawn as BG mode 1: because'])
    expect(wireOf(mapOf(m, { ok: true, l2 })).layerNotes).toEqual([])
  })

  it("L2's dispatch note joins L1's in the map note, a line L1 already has is dropped, the rest say Layer 2 (#493)", () => {
    const m = { ...inputs(hGrid(1), false, 1), unverified: ['hooked $0DA415'] }
    const l2 = { ...l2Of(nullGrid(27, 16), tiles2(solid)), unverified: ['hooked $0DA415', 'hooked $0DA106'] } // prettier-ignore
    expect(wireOf(mapOf(m, { ok: true, l2 })).note).toBe('hooked $0DA415 Layer 2: hooked $0DA106')
    expect(wireOf(mapOf(m)).note).toBe('hooked $0DA415')
  })

  it('the map note reads L1, then L2, then the animation note (#493)', () => {
    const m = { ...inputs(hGrid(1), false, 1), unverified: ['one'], animNote: 'anim' }
    const l2 = { ...l2Of(nullGrid(27, 16), tiles2(solid)), unverified: ['two'] }
    expect(wireOf(mapOf(m, { ok: true, l2 })).note).toBe('one Layer 2: two anim')
  })

  it('L2 notes alone, only duplicates, two lines, and a refused L2 each read as the code does (#493)', () => {
    const base = inputs(hGrid(1), false, 1)
    const withL2 = (m: L1Inputs, notes: string[]) => mapOf(m, { ok: true, l2: { ...l2Of(nullGrid(27, 16), tiles2(solid)), unverified: notes } }) // prettier-ignore
    expect(wireOf(withL2(base, ['x'])).note).toBe('Layer 2: x')
    const dup = { ...base, unverified: ['a', 'b'] }
    expect(wireOf(withL2(dup, ['a', 'b'])).note).toBe('a b')
    expect(wireOf(withL2(base, ['x', 'y'])).note).toBe('Layer 2: x Layer 2: y')
    // A refused background carries no notes: only its layerNote speaks.
    expect(wireOf(mapOf(base, { ok: false, reason: 'gone' })).note).toBeUndefined()
  })

  it('an unverified background height is a details note on a map that still draws (#505)', () => {
    const m = inputs(hGrid(1), false, 1)
    const l2 = { ...l2Of(nullGrid(27, 16), tiles2(solid)), note: 'Background height unverified: x' }
    l2.grid[0]![0] = 1
    const wire = wireOf(mapOf(m, { ok: true, l2 }))
    expect(wire.planes.l2Low).toBeTruthy()
    expect(wire.layerNotes).toEqual(['Background height unverified: x'])
  })

  it('an unreached map and an unverified height are two layer notes, not one sentence (#945)', () => {
    const m = inputs(hGrid(1), false, 1)
    const l2 = { ...l2Of(nullGrid(27, 16), tiles2(solid)), note: 'Background height unverified: x' } // prettier-ignore
    const wire = wireOf({ ...mapOf(m, { ok: true, l2 }), routeNote })
    expect(wire.layerNotes).toEqual(['Background height unverified: x', routeNote])
  })

  it('the no-route note still shows when the background is refused (#945)', () => {
    const m = inputs(hGrid(1), false, 1)
    const wire = wireOf({ ...mapOf(m, { ok: false, reason: 'gone' }), routeNote })
    expect(wire.layerNotes).toEqual(['The background is not drawn: gone', routeNote])
  })
})

// ── The core's L2 reading ────────────────────────────────────────────────────

// Written out, not imported, so the test cannot agree with the source by construction.
const NO_L2_OBJECT_MODES = [0x00, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x10, 0x11, 0x1e]

describe('buildL2Inputs (synthetic ROM)', () => {
  const LEVEL = 5
  // Mode 1 is an object-stream mode and mode 0 an image mode in the planted stock dispatch (#506).
  const inp = (
    grid: number[][],
    vertical: boolean,
    screens: number,
    tileset = 0,
    mode = 1,
  ): L1Inputs => {
    const m = inputs(grid, vertical, screens, tileset)
    return { ...m, header: { ...m.header, levelMode: mode } }
  }
  // DATA_05D708 (L1 Y) index 1 = $20; DATA_05D70C (L2 Y) index 2 = $C0.
  const romWith = (writes: [number, number[]][] = []) => {
    const rom = new RomFile('l2.sfc', Buffer.alloc(0x80000, 0))
    // Modes $00/$0A upload the image (bank_05.asm:1104, 1114); the other eight skipped modes plant
    // an RTL and every remaining mode an object streamer.
    plantUploaderTable(rom, m =>
      m === 0 || m === 0x0a ? IMAGE_AT : NO_L2_OBJECT_MODES.includes(m) ? NONE_AT : OBJ_A_AT,
    )
    rom.writeAt(0x05d708, [0x00, 0x20, 0x40, 0x80])
    rom.writeAt(0x05d70c, [0x60, 0x90, 0xc0, 0x00])
    rom.writeAt(0x05f400 + LEVEL, [(1 << 2) | 2])
    rom.writeAt(0x05803b, [0xc9]) // stock CMP #$FF at the L2 preset check (bank_05.asm:33)
    writeStockSkipChain(rom)
    for (const [addr, bytes] of writes) rom.writeAt(addr, bytes)
    return rom
  }
  const ptr = (lo: number, hi: number, bank: number): [number, number[]] => [0x05e600 + LEVEL * 3, [lo, hi, bank]] // prettier-ignore
  const smw = (rom: RomFile, l2Vertical = false) =>
    ({ rom, getVerticalTable: () => ({ ok: true, table: new Array(32).fill(l2Vertical ? 3 : 0) }) }) as unknown as SmwRom // prettier-ignore
  const one = tile(7, [sub(1, 3), sub(1, 3), sub(1, 3), sub(1, 3)])
  const objects = (grid: number[][]) =>
    vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid, unverified: [] })
  const image = () => {
    vi.mocked(Map16Real.readL2Map16Table).mockReturnValue({ ok: true, value: [0] })
    vi.mocked(Map16Real.loadMap16Tiles).mockReturnValue(tiles2(one))
    return romWith([ptr(0x00, 0x80, 0xff), [0x0c8000, [0x84, 0x07, 0xff, 0xff]]]) // 5 x $07, then the $25 fill
  }
  const ok = (r: ReturnType<typeof buildL2Inputs>) => {
    if (!r.ok) throw new Error(r.reason)
    return r.l2
  }

  it('an image tiles across the map: 27 rows by 16 columns a screen, or 32 wide by 16 rows stacked', () => {
    const h = ok(buildL2Inputs(smw(image()), LEVEL, inp(hGrid(3), false, 3, 0, 0)))
    expect([h.kind, h.grid.length, h.grid[0]!.length]).toEqual(['image', 27, 48])
    expect([h.grid[0]![0], h.grid[0]![4], h.grid[0]![5], h.grid[0]![32]]).toEqual([7, 7, 0x25, 7]) // the 32-wide pattern repeats; $25 draws
    const v = ok(buildL2Inputs(smw(image()), LEVEL, inp(vGrid(2), true, 2, 0, 0)))
    expect([v.grid.length, v.grid[0]!.length]).toEqual([32, 32])
    // The BG plane is 32 rows and the pattern 27: rows 27-31 are empty, then it repeats.
    expect([v.grid[26]![0], v.grid[27]![0], v.grid[31]![0]]).toEqual([0x25, null, null])
  })

  it('a $FF preset pointer is an image in skipped modes too, on a stock site', () => {
    for (const mode of [0x00, 0x0a]) {
      const m = inputs(hGrid(1), false, 1)
      const r = buildL2Inputs(smw(image()), LEVEL, {
        ...m,
        header: { ...m.header, levelMode: mode },
      })
      expect(ok(r).kind, `mode ${mode}`).toBe('image')
    }
  })

  it('an image sits Layer1YPos - Layer2YPos down, like an object stream (bank_05.asm:7323-7328)', () => {
    expect(ok(buildL2Inputs(smw(image()), LEVEL, inp(hGrid(1), false, 1, 0, 0))).dy).toBe(
      0x20 - 0xc0,
    )
  })

  it('an image whose Map16 table cannot be read is refused with that reason, not drawn from vanilla', () => {
    const rom = romWith([ptr(0x00, 0x80, 0xff), [0x0c8000, [0x00, 0x07, 0xff, 0xff]]])
    // The zeroed ROM has no BG fill loop, so the core's own reader declines.
    expect(buildL2Inputs(smw(rom), LEVEL, inp(hGrid(1), false, 1, 0, 0))).toMatchObject({ ok: false, reason: expect.stringMatching(/Map16 table cannot be read/) }) // prettier-ignore
  })

  it('an object stream keeps its ids, empties $25, and sits Layer1YPos - Layer2YPos down', () => {
    objects([
      [0x25, 1],
      [1, 0x25],
    ])
    const m = inp(hGrid(1), false, 1)
    const l2 = ok(buildL2Inputs(smw(romWith([ptr(0x00, 0x90, 0x0c)])), LEVEL, m))
    expect(l2.grid).toEqual([
      [null, 1],
      [1, null],
    ])
    expect(l2.dy).toBe(0x20 - 0xc0)
    expect(l2.tiles[1]).toEqual(m.map16.tiles[1]) // L1's own table, not vanilla's
    expect(vi.mocked(L2LoaderReal.loadL2Objects).mock.calls[0]!.slice(2)).toEqual([1, 0, false])
  })

  it('an object build dispatch notes ride on the L2 inputs (#493)', () => {
    vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid: [[1]], unverified: ['hooked'] })
    const l2 = ok(buildL2Inputs(smw(romWith([ptr(0x00, 0x90, 0x0c)])), LEVEL, inputs(hGrid(1), false, 1))) // prettier-ignore
    expect(l2.unverified).toEqual(['hooked'])
  })

  it('the high bytes follow the ScreenMode at level entry (F600 bit 5), and L2 only when VertLayer2Setting is not 3', () => {
    objects([[1]])
    // F000 high nibble 0 -> DATA_05D710[0]; F600 & $1F = 3 is the high byte; bit 5 is Layer1Vert.
    const entry = (f600: number, d710: number) =>
      romWith([ptr(0x00, 0x90, 0x0c), [0x05f600 + LEVEL, [f600]], [0x05d710, [d710]], [0x05f000 + LEVEL, [0x00]]]) // prettier-ignore
    const dy = (f600: number, d710: number, vertical = true) =>
      ok(buildL2Inputs(smw(entry(f600, d710), vertical), LEVEL, inp(vertical ? vGrid(1) : hGrid(1), vertical, 1))).dy // prettier-ignore
    expect(dy(0x23, 3)).toBe(0x320 - 0xc0) // L1 gets the high byte, L2's stays 0
    expect(dy(0x23, 1)).toBe(0x320 - 0x3c0) // both have it
    expect(vi.mocked(L2LoaderReal.loadL2Objects).mock.calls[0]!.slice(2)).toEqual([1, 0, true])
    // The VerticalTable (the map's isVertical) is not what the entry code tests.
    expect(dy(0x03, 3)).toBe(0x20 - 0xc0) // F600 bit 5 clear: no high bytes, though the map is vertical
    expect(dy(0x23, 3, false)).toBe(0x320 - 0xc0)
    expect(dy(0x23, 1, false)).toBe(0x320 - 0x3c0) // L2's high byte follows F600 too
    expect(dy(0x03, 1)).toBe(0x20 - 0xc0) // and is absent when bit 5 is clear, gate or no gate
  })

  describe('the entrances that reach the map (#505)', () => {
    // The primary data: L1 $20, L2 $C0 (romWith's F400) and, vertical, high byte 3 (F600 $23).
    // Secondary entrance A: FA00 $20 -> L1 index 2 ($40), L2 index 0 ($60); FC00 $E5 -> high byte 5
    // (bits 7-5 are Mario's X index, bank_05.asm:7147-7153). B and C hold other values.
    const A = 0x1be
    const B = 0x0c4
    const C = 0x0c5
    const entry = (d710: number, f600 = 0x23) =>
      romWith([
        ptr(0x00, 0x90, 0x0c),
        [0x05f600 + LEVEL, [f600]],
        [0x05d710, [d710]],
        [0x05fa00 + A, [0x20]],
        [0x05fc00 + A, [0xe5]],
        [0x05fa00 + B, [0x60]], // L1 index 2, L2 index 1 ($90): a different height
        [0x05fc00 + B, [0x05]],
        [0x05fa00 + C, [0x20]], // A's values again
        [0x05fc00 + C, [0x05]],
      ])
    const via = (overworld: boolean, primary: boolean, ...secondary: number[]) => ({ overworld, primary, secondary, route: overworld || primary || !secondary.length ? null : Math.min(...secondary) }) // prettier-ignore
    /** These fixtures hold no level-load code; the gate itself is pinned below. */
    const stock = () => null
    const build = (rom: RomFile, entrances: ReturnType<typeof via>, vertical = true) => {
      objects([[1]])
      return ok(buildL2Inputs(smw(rom, vertical), LEVEL, inputs(vertical ? vGrid(1) : hGrid(1), vertical, 1), entrances, stock)) // prettier-ignore
    }

    // D51 B: the #637 object gate refuses first, so the entrances never change a refusal or add the
    // height note to it. Disagreeing entrances and a failing start gate both present throughout.
    it('the object gate refuses first with disagreeing entrances and a failed start gate, in every mode', () => {
      const disagree = via(true, false, A)
      const failed = () => 'the loader differs'
      const at = (rom: RomFile, mode: number) => {
        objects([[1]])
        const m = inputs(vGrid(1), true, 1)
        return buildL2Inputs(smw(rom, true), LEVEL, { ...m, header: { ...m.header, levelMode: mode } }, disagree, failed) // prettier-ignore
      }
      const stockRom = entry(3)
      const chainRom = entry(3)
      chainRom.writeAt(SKIP_CHAIN_B_AT + 5, [0xea, 0xea])
      for (let mode = 0; mode < 32; mode++) {
        const hex = mode.toString(16).toUpperCase().padStart(2, '0')
        const skipped = NO_L2_OBJECT_MODES.includes(mode)
        const plain = at(stockRom, mode)
        if (skipped)
          expect(plain, `mode ${mode}`).toEqual({ ok: false, reason: `The game loads no layer 2 objects in level mode $${hex}` }) // prettier-ignore
        else
          expect(plain.ok && plain.l2.note, `mode ${mode}`).toMatch(/^Background height unverified/)
        expect(at(chainRom, mode), `mode ${mode}`).toEqual({ ok: false, reason: `Layer 2 not drawn: the mode-skip chain of this ROM is not recognized (level mode $${hex})` }) // prettier-ignore
      }
    })

    it('a map reached only by a secondary entrance takes its low bytes from FA00 and its high byte from FC00', () => {
      expect(build(entry(1), via(false, false, A))).toMatchObject({ dy: 0x540 - 0x560, note: undefined }) // prettier-ignore
      expect(build(entry(3), via(false, false, A)).dy).toBe(0x540 - 0x60) // L2's high byte stays 0 at setting 3
      expect(build(entry(3, 0x03), via(false, false, A), false).dy).toBe(0x40 - 0x60) // not vertical: no high bytes
      // The primary data, by contrast, for a map entered from the overworld only.
      expect(build(entry(3), via(true, false)).dy).toBe(0x320 - 0xc0)
    })

    // #945: the Theia build asks for the map's entrances; a graph that never reached the map must
    // give the chooser an empty record (so it says "no route"), not undefined (primary, silent).
    it('the Theia build: a graph lacking the map draws the primary entrance and says no route was found', () => {
      objects([[1]])
      const m = inputs(vGrid(1), true, 1)
      const built = buildMapInputs(smw(entry(1), true), LEVEL, UNCLEARED, () => ({ ok: true, mode: 1 }), () => ({ ok: true, inputs: m }), () => new Map()) // prettier-ignore
      if (!built.ok) throw new Error('refused')
      expect(built.inputs.routeNote).toMatch(/no route/i)
      expect(built.inputs.l2).toMatchObject({ ok: true })
      expect(built.inputs.l2?.ok && (built.inputs.l2.l2.note ?? '')).not.toMatch(/no route/i)
    })

    it('entrances that agree draw without a note; ones that disagree draw the entrance chooseEntrance names and say the height is unverified', () => {
      expect(build(entry(1), via(false, false, A, C)).note).toBeUndefined()
      const split = build(entry(1), via(false, false, A, B))
      expect(split.dy).toBe(0x540 - 0x590) // B, the lowest id: the one the layer 3 camera reads too (#861)
      expect(split.note).toBe('Background height unverified: drawn as entered through secondary entrance $0C4; entered through secondary entrance $1BE it starts at a different height.') // prettier-ignore
      // A primary entrance is drawn ahead of any secondary one.
      expect(build(entry(1), via(false, true, A)).dy).toBe(0x320 - 0x3c0)
      expect(build(entry(1), via(false, true, A)).note).toMatch(/drawn as entered by a screen exit/)
    })

    it('the midway restart skips both high-byte writes (bank_05.asm:7362-7373), which only matters when L2 keeps its own', () => {
      // F400 bits 7-4 name the midway screen; the tape sets MidwayFlag only when they are nonzero.
      const withMidway = (d710: number) => {
        const rom = entry(d710)
        rom.writeAt(0x05f400 + LEVEL, [0x10 | (1 << 2) | 2])
        return rom
      }
      expect(build(withMidway(1), via(true, false)).note).toBeUndefined() // both high bytes 3 or both 0: same relation
      const midway = build(withMidway(3), via(true, false))
      expect(midway.dy).toBe(0x320 - 0xc0)
      expect(midway.note).toMatch(
        /drawn as entered from the overworld; entered from the midway point it starts/,
      )
      expect(build(entry(3), via(true, false)).note).toBeUndefined() // no midway screen: no restart there
    })

    it('every nonzero F400 midway nibble adds the midway path, $0 does not; the drawn dy is the flag-clear one (#927)', () => {
      const f400 = (v: number) => {
        const rom = entry(3)
        rom.writeAt(0x05f400 + LEVEL, [v])
        return rom
      }
      // Low bits 0b0110 pick L1/L2 rows the same way on every nibble, so only the nibble varies.
      for (let nibble = 0; nibble <= 0xf; nibble++) {
        const out = build(f400((nibble << 4) | 0x06), via(true, false))
        const hex = nibble.toString(16).toUpperCase()
        // Flag clear (overworld entry) keeps `_1 & $1F` = 3 in the L1 high byte (bank_05.asm:7377); the
        // flag-set restart jumps past it (:7373), so the note appears while the numeric dy stays the drawn path's.
        expect(out.dy, `nibble $${hex}`).toBe(0x320 - 0xc0)
        if (nibble === 0) expect(out.note, `nibble $${hex}`).toBeUndefined()
        else expect(out.note, `nibble $${hex}`).toMatch(/entered from the midway point/)
      }
      // Bit 4 alone is not the test: $26 has it clear yet still sets the flag (>> 4 is nonzero).
      expect(build(f400(0x26), via(true, false)).note).toMatch(/midway point/)
    })

    it('a screen-exit-only entry never adds a midway path: SublevelCount != 0 skips the midway test (bank_05.asm:7349-7350)', () => {
      const rom = entry(3)
      rom.writeAt(0x05f400 + LEVEL, [0x16])
      const out = build(rom, via(false, true))
      expect(out.note).toBeUndefined() // only the exit path exists
      expect(out.dy).toBe(0x320 - 0xc0) // the exit path's own height
    })

    // Through the node side's own reader: the exit graph's ids (the $1xx half included) reach a
    // background image's note. Also the image branch's note, beside the object branch's above.
    it('end to end: readMapEntrances feeds a background image its $1xx entrances', () => {
      const buf = Buffer.alloc(0x400000, 0)
      buf[0x7fd5] = 0x20 // the map mode byte
      const rom = new RomFile('e2e.sfc', buf)
      plantUploaderTable(rom, () => IMAGE_AT) // an image in every mode, so the #506 table agrees with the $FF pointer
      plantStockSubmapCode(rom)
      plantOverworldTiles(rom)
      const l1Ptr = (map: number, at: number) => rom.writeAt(ADDR.LEVEL_L1_PTR + map * 3, [at & 0xff, (at >> 8) & 0xff, at >> 16]) // prettier-ignore
      l1Ptr(0x105, 0x068000) // a submap root: its exits index the $1xx half
      rom.writeAt(0x068000, [0, 0, 0, 0, 0, 0x00, 0x02, 0x00, 0x10, 0x01, 0x02, 0x00, 0x11, 0xff])
      l1Ptr(0x177, 0x06b000) // clear of the planted uploader chain at $06A000
      rom.writeAt(0x06b000, [0, 0, 0, 0, 0, 0x42, 0xff])
      rom.writeAt(ADDR.SEC_EXIT_DEST + 0x110, [0x77, 0x77])
      rom.writeAt(0x05fa00 + 0x110, [0x20, 0x60]) // L2 index 0 ($60), then 1 ($90)
      rom.writeAt(0x05d708, [0x00, 0x20, 0x40, 0x80])
      rom.writeAt(0x05d70c, [0x60, 0x90, 0xc0, 0x00])
      rom.writeAt(0x05e600 + 0x177 * 3, [0x00, 0x80, 0xff])
      rom.writeAt(0x0c8000, [0x84, 0x07, 0xff, 0xff])
      vi.mocked(Map16Real.readL2Map16Table).mockReturnValue({ ok: true, value: [0] })
      vi.mocked(Map16Real.loadMap16Tiles).mockReturnValue(tiles2(one))
      const smw = new SmwRom(rom)
      const reached = readMapEntrances(smw, SYNTHETIC_FINGERPRINTS)?.get(0x177)
      expect(reached).toEqual({
        overworld: false,
        primary: false,
        secondary: [0x110, 0x111],
        route: 0x110,
      })
      const l2 = ok(buildL2Inputs(smw, 0x177, inputs(hGrid(1), false, 1), reached, stock))
      expect(l2).toMatchObject({ kind: 'image', dy: 0x40 - 0x60 })
      expect(l2.note).toBe('Background height unverified: drawn as entered through secondary entrance $110; entered through secondary entrance $111 it starts at a different height.') // prettier-ignore
      expect(l2.reasons).toEqual([l2.note!.replace('Background height unverified: ', '')]) // image path: the one dy note
      // A graph that throws leaves the map to the older reading instead of refusing it.
      vi.spyOn(smw, 'buildLevelExitGraph').mockImplementation(() => {
        throw new Error('boom')
      })
      expect(readMapEntrances(smw, SYNTHETIC_FINGERPRINTS)).toBeUndefined()
      // ...and then it reads the MAIN entrance (F400 here: both indexes 0), never entrance $110's row
      // ($40 - $60): the stock destination formula is not applied where the graph is unavailable.
      const noGraph = ok(buildL2Inputs(smw, 0x177, inputs(hGrid(1), false, 1), undefined, stock))
      expect(noGraph.dy).toBe(0x00 - 0x60)
    })

    it('a map nothing is known to reach keeps the primary reading, with no note', () => {
      expect(build(entry(3), via(false, false))).toMatchObject({
        dy: 0x320 - 0xc0,
        note: undefined,
      })
    })

    // CodeRabbit on #872: the position tables are only the game's while the code that reads them is.
    it('code that is not the stock level load keeps the drawing and says the height is unverified', () => {
      objects([[1]])
      const m = inputs(vGrid(1), true, 1)
      // The default gate reads the ROM: this fixture reaches the loader (the JSL the gate's first
      // check reads) but holds none of its position code.
      const rom = entry(3)
      rom.writeAt(0x0096f4, [0x22, 0x96, 0xd7, 0x05])
      const gated = ok(buildL2Inputs(smw(rom, true), LEVEL, m))
      expect(gated.dy).toBe(0x320 - 0xc0) // still the best reading
      expect(gated.note).toMatch(/^Background height unverified: \$05D7D4 \(the secondary-exit branch and its _E index, bank_05\.asm:7111-7119\) holds .* not the stock/) // prettier-ignore
      // A failed gate and disagreeing entrances: both reasons, one note.
      objects([[1]])
      const both = ok(buildL2Inputs(smw(entry(1), true), LEVEL, m, via(false, false, A, B), () => 'boom.')) // prettier-ignore
      expect(both.note).toBe('Background height unverified: boom. Drawn as entered through secondary entrance $0C4; entered through secondary entrance $1BE it starts at a different height.') // prettier-ignore
      expect(both.reasons).toEqual(['boom.', 'Drawn as entered through secondary entrance $0C4; entered through secondary entrance $1BE it starts at a different height.']) // prettier-ignore
      expect(both.note).toBe(`Background height unverified: ${both.reasons!.join(' ')}`)
    })
  })

  it('tileset 3 ORs palette bit 2 into every L2 object subtile, and no image tile', () => {
    objects([[1]])
    const objRom = romWith([ptr(0x00, 0x90, 0x0c)])
    const palettes = (rom: RomFile, tileset: number, id: number, mode = 1) => {
      const t = ok(buildL2Inputs(smw(rom), LEVEL, inp(hGrid(1), false, 1, tileset, mode))).tiles[
        id
      ]!
      return [t.tl, t.tr, t.bl, t.br].map(s => s.palette)
    }
    expect(palettes(objRom, 3, 1)).toEqual([4, 4, 4, 4])
    expect(palettes(objRom, 0, 1)).toEqual([0, 0, 0, 0])
    expect(palettes(image(), 3, 7, 0)).toEqual([3, 3, 3, 3]) // an image keeps its own, as the core's L2Preset does
  })

  it('an L2 whose orientation differs from L1 is refused with both named', () => {
    objects([[1]])
    const r = buildL2Inputs(smw(romWith([ptr(0x00, 0x90, 0x0c)]), true), LEVEL, inp(hGrid(1), false, 1)) // prettier-ignore
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/L2 is vertical but L1 is horizontal/) }) // prettier-ignore
  })

  // The game loads no L2 objects in ten modes (bank_05.asm:431-457, #637); sweep all 32.
  it('every level mode the game gives no L2 objects is refused before the stream is read, and only those', () => {
    const rom = romWith([ptr(0x00, 0x90, 0x0c)])
    for (let mode = 0; mode < 32; mode++) {
      objects([[1]])
      const m = inputs(hGrid(1), false, 1)
      const r = buildL2Inputs(smw(rom), LEVEL, { ...m, header: { ...m.header, levelMode: mode } })
      const read = vi.mocked(L2LoaderReal.loadL2Objects).mock.calls.length > 0
      if (NO_L2_OBJECT_MODES.includes(mode)) {
        expect(r, `mode ${mode}`).toMatchObject({ ok: false, reason: expect.stringMatching(/loads no layer 2 objects in level mode/) }) // prettier-ignore
        expect(read, `mode ${mode}`).toBe(false)
      } else {
        expect(r.ok, `mode ${mode}`).toBe(true)
      }
      vi.mocked(L2LoaderReal.loadL2Objects).mockReset()
    }
  })

  it('a hijacked L2 check site keeps the stream behaviour in all ten skipped modes', () => {
    for (const mode of NO_L2_OBJECT_MODES) {
      objects([[1]])
      const rom = romWith([ptr(0x00, 0x90, 0x0c), [0x05803b, [0x5c]]]) // JML, as Lunar Magic patches it
      const m = inputs(hGrid(1), false, 1)
      const r = buildL2Inputs(smw(rom), LEVEL, { ...m, header: { ...m.header, levelMode: mode } })
      expect(r.ok, `mode ${mode}`).toBe(true)
      expect(vi.mocked(L2LoaderReal.loadL2Objects).mock.calls.length, `mode ${mode}`).toBe(1)
      vi.mocked(L2LoaderReal.loadL2Objects).mockReset()
    }
  })

  it('a non-JML byte at the site is a hijack too', () => {
    for (const byte of [0x22, 0x00]) {
      objects([[1]])
      const rom = romWith([ptr(0x00, 0x90, 0x0c), [0x05803b, [byte]]])
      const m = inputs(hGrid(1), false, 1)
      const r = buildL2Inputs(smw(rom), LEVEL, { ...m, header: { ...m.header, levelMode: 0x0a } })
      expect(r.ok, `site ${byte}`).toBe(true)
    }
  })

  // A ROM that reroutes the skip branch but keeps CMP #$FF would otherwise read as "no objects", silently.
  it('a changed mode-skip chain with a stock CMP site is refused as unrecognized, in every mode', () => {
    for (const patch of [[0x0a], [0x1e]]) {
      const rom = romWith([ptr(0x00, 0x90, 0x0c)])
      rom.writeAt(SKIP_CHAIN_B_AT + 5 + 4 * (patch[0] === 0x0a ? 0 : 5), [0xea, 0xea]) // the compare is neutered, so the stream could run
      for (let mode = 0; mode < 32; mode++) {
        objects([[1]])
        const m = inputs(hGrid(1), false, 1)
        const r = buildL2Inputs(smw(rom), LEVEL, { ...m, header: { ...m.header, levelMode: mode } })
        expect(r, `mode ${mode}`).toMatchObject({ ok: false, reason: expect.stringMatching(/skip chain.*not recognized/) }) // prettier-ignore
        expect(vi.mocked(L2LoaderReal.loadL2Objects), `mode ${mode}`).not.toHaveBeenCalled()
        vi.mocked(L2LoaderReal.loadL2Objects).mockReset()
      }
    }
  })

  it('a stock ROM keeps the plain refusal, never the unrecognized one', () => {
    objects([[1]])
    const m = inputs(hGrid(1), false, 1)
    const r = buildL2Inputs(smw(romWith([ptr(0x00, 0x90, 0x0c)])), LEVEL, { ...m, header: { ...m.header, levelMode: 0x0a } }) // prettier-ignore
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/loads no layer 2 objects in level mode \$0A/) }) // prettier-ignore
  })

  it('a skipped mode with L1 vertical gives the mode as the reason, not an orientation mismatch', () => {
    objects([[1]])
    // Entry $01 everywhere: L1 vertical, L2 horizontal, as the vanilla table has for modes 3, $0A, $0D.
    const rom = { rom: romWith([ptr(0x00, 0x90, 0x0c)]), getVerticalTable: () => ({ ok: true, table: new Array(32).fill(1) }) } as unknown as SmwRom // prettier-ignore
    const at = (mode: number) => {
      const m = inputs(vGrid(1), true, 1)
      return buildL2Inputs(rom, LEVEL, { ...m, header: { ...m.header, levelMode: mode } })
    }
    expect(at(0x0a)).toMatchObject({ ok: false, reason: expect.stringMatching(/level mode \$0A/) })
    expect(at(0x0d)).toMatchObject({ ok: false, reason: expect.stringMatching(/level mode \$0D/) })
    // Mode 3 does load L2 objects, so its mismatch refusal stands.
    expect(at(0x03)).toMatchObject({ ok: false, reason: expect.stringMatching(/L2 is horizontal but L1 is vertical/) }) // prettier-ignore
  })

  it('an unreadable object stream and a throw are each refused, never a partial grid', () => {
    const rom = romWith([ptr(0x00, 0x90, 0x0c)])
    vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValueOnce(null)
    expect(buildL2Inputs(smw(rom), LEVEL, inp(hGrid(1), false, 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/object stream .* cannot be read/) }) // prettier-ignore
    vi.mocked(L2LoaderReal.loadL2Objects).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(buildL2Inputs(smw(rom), LEVEL, inp(hGrid(1), false, 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/boom/) }) // prettier-ignore
  })

  it('a pointer outside the ROM is refused', () => {
    const rom = new RomFile('tiny.sfc', Buffer.alloc(0x8000, 0))
    expect(buildL2Inputs(smw(rom), LEVEL, inp(hGrid(1), false, 1))).toMatchObject({ ok: false }) // prettier-ignore
  })
})

// ── The build ────────────────────────────────────────────────────────────────

describe('the map build adds the background and the layer order (synthetic)', () => {
  const ok = () => ({ ok: true as const, inputs: inputs(hGrid(1), false, 1) })

  it("L1's refusal is the map's, and a background or order failure never refuses the map", () => {
    const rom = new SmwRom(bgModeRom(2, [0x05e600 + 5 * 3, [0x00, 0x90, 0x0c]]))
    const bg = () => ({ ok: false as const, reason: 'mode 2' })
    expect(buildMapInputs(rom, 5, UNCLEARED, bg, () => ({ ok: false, reason: 'GFX unreadable' }))).toEqual({ ok: false, reason: 'GFX unreadable' }) // prettier-ignore
    const built = buildMapInputs(rom, 5, UNCLEARED, bg, ok)
    if (!built.ok) throw new Error('refused')
    expect(built.inputs.orderNote).toBe('mode 2')
    // An object stream needs the vertical table, which this ROM lacks: the L2 reading refuses, the map does not.
    expect(built.inputs.l2).toMatchObject({ ok: false })
  })

  it('the BG mode check does not touch the switch toolbar art', () => {
    const base = inputs(hGrid(1), false, 1)
    const rom = bgModeRom()
    const art = palaceArt(rom)
    const plain = toolbarArtOf(rom, { ok: true, inputs: base }, art)
    const noted = toolbarArtOf(rom, { ok: true, inputs: mapOf(base, { ok: false, reason: 'x' }, 'unverified') }, art) // prettier-ignore
    expect(noted).toEqual(plain)
  })

  it('the cache reads the BG mode and the entrances once per working-copy bytes, not once per map', () => {
    const seen: unknown[][] = []
    const cache = new L1ModelCache(
      (_rom, _index, _flags, bgMode, _l1, entrances) => {
        seen.push([bgMode!(), entrances!()])
        return ok()
      },
      () => new Map(),
    )
    const bytes = bgModeRom().buffer
    mapScreen(cache, bytes, 'x.sfc', 5, 0, UNCLEARED)
    mapScreen(cache, bytes, 'x.sfc', 6, 0, UNCLEARED)
    mapScreen(cache, bgModeRom().buffer, 'x.sfc', 5, 0, UNCLEARED) // an edit: new bytes
    for (const k of [0, 1]) {
      expect(seen[0]![k]).toBe(seen[1]![k])
      expect(seen[2]![k]).not.toBe(seen[0]![k])
    }
  })

  it("the build hands the background this map's entrances (#505)", () => {
    const rom = new SmwRom(bgModeRom(1))
    const asked: number[] = []
    const entrances = () => ({ get: (i: number) => (asked.push(i), undefined) }) as unknown as Map<number, never> // prettier-ignore
    buildMapInputs(rom, 5, UNCLEARED, undefined, ok, entrances)
    expect(asked).toEqual([5])
  })
})

// ── The corpus ───────────────────────────────────────────────────────────────

describe.each([VANILLA, MAGIC])('every slot of %s', name => {
  it.skipIf(!hasRom(name))(
    'reads or refuses its background with a reason, and draws every screen',
    () => {
      const rom = new SmwRom(RomFile.load(romPath(name)))
      const kinds = { image: 0, objects: 0 }
      let maps = 0
      for (let index = 0; index < 0x200; index++) {
        const built = buildL1Inputs(rom, index, UNCLEARED)
        if (!built.ok) continue
        maps++
        const l2 = buildL2Inputs(rom, index, built.inputs)
        if (!l2.ok) {
          expect(l2.reason.length, `slot ${index}`).toBeGreaterThan(0)
          continue
        }
        kinds[l2.l2.kind]++
        for (let s = 0; s < built.inputs.screenCount; s++) drawL2Planes(built.inputs, l2.l2, s)
      }
      expect(maps).toBeGreaterThan(100)
      expect(kinds.image).toBeGreaterThan(0)
      expect(kinds.objects).toBeGreaterThan(0)
    },
    600_000,
  )

  const load = (index: number) => {
    const rom = new SmwRom(RomFile.load(romPath(name)))
    const built = buildL1Inputs(rom, index, UNCLEARED)
    if (!built.ok) throw new Error(built.reason)
    return { rom, inputs: built.inputs, l2: buildL2Inputs(rom, index, built.inputs) }
  }

  // The level-start relation (not a screen capture): $012's F600 is $64, so the entry code takes the
  // vertical branch (bank_05.asm:7292-7299, 7379-7381): Layer1YPos $0400, Layer2YPos $00C0.
  it.skipIf(!hasRom(name))('$012 starts with Layer1YPos $0400 and Layer2YPos $00C0', () => {
    expect(load(0x012).l2).toMatchObject({ ok: true, l2: { kind: 'image', dy: 0x400 - 0xc0 } })
  })

  // F600 and the VerticalTable disagree on $108; its high byte is 0, so the position is the low bytes.
  it.skipIf(!hasRom(name))('$108 disagrees between F600 and the VerticalTable, harmlessly', () => {
    const { rom, inputs: m, l2 } = load(0x108)
    const f600 = rom.rom.readByte(0x05f600 + 0x108)!
    expect(((f600 & 0x20) !== 0) !== m.isVertical).toBe(true)
    expect(f600 & 0x1f).toBe(0)
    expect(l2.ok && Math.abs(l2.l2.dy)).toBeLessThan(0x100)
  })

  // An image is one fixed plane that wraps: no screen of an image map is empty unless the image is.
  it.skipIf(!hasRom(name))(
    'every screen of every image map has L2 pixels, unless the image is blank',
    () => {
      const rom = new SmwRom(RomFile.load(romPath(name)))
      let checked = 0
      let blank = 0
      for (let index = 0; index < 0x200; index++) {
        const built = buildL1Inputs(rom, index, UNCLEARED)
        if (!built.ok) continue
        const r = buildL2Inputs(rom, index, built.inputs)
        if (!r.ok || r.l2.kind !== 'image') continue
        const m = built.inputs
        const drawn = Array.from({ length: m.screenCount }, (_, s) => {
          const p = drawL2Planes(m, r.l2, s)
          return p.l2Low !== null || p.l2High !== null
        })
        const imageHasInk = [...new Set(r.l2.grid.flat())].some(id => {
          const t = id === null ? undefined : r.l2.tiles[id]
          return !!t && renderMap16Tile(t, m.vram, { colors: m.colors }).some((v, i) => i % 4 === 3 && v !== 0) // prettier-ignore
        })
        if (!imageHasInk) {
          blank++
          expect(drawn.some(Boolean), `slot ${index} blank image`).toBe(false)
          continue
        }
        checked++
        expect(drawn.indexOf(false), `slot ${index} has an empty screen`).toBe(-1)
      }
      expect(checked).toBeGreaterThan(100)
      console.info(`blank image maps in ${name}: ${blank}`)
    },
    600_000,
  )
})

// The roster effect (#505), vanilla, as measured when the entrances landed: no background moves,
// and $118 alone is noted, for its secondary entrance $1C3.
describe.skipIf(!hasRom(VANILLA))('the entrances over the 143-map roster', () => {
  it('move no background and note $118 only, naming entrance $1C3', () => {
    const rom = new SmwRom(RomFile.load(romPath(VANILLA)))
    const entrances = readMapEntrances(rom)!
    const moved: number[] = []
    const noted = new Map<number, string>()
    let compared = 0
    for (const index of FG_GATE_MAPS) {
      const built = buildL1Inputs(rom, index, UNCLEARED)
      if (!built.ok) continue
      const before = buildL2Inputs(rom, index, built.inputs)
      const after = buildL2Inputs(rom, index, built.inputs, entrances.get(index))
      if (!before.ok || !after.ok) continue
      compared++
      if (before.l2.dy !== after.l2.dy) moved.push(index)
      if (after.l2.note) noted.set(index, after.l2.note)
    }
    // Every roster map builds both layers on vanilla (measured 2026-10-10): none is skipped.
    expect(compared).toBe(FG_GATE_MAPS.length)
    expect(FG_GATE_MAPS.length).toBe(143)
    expect(moved).toEqual([])
    expect([...noted.keys()]).toEqual([0x118])
    expect(noted.get(0x118)).toBe('Background height unverified: drawn as entered from the overworld; entered through secondary entrance $1C3 it starts at a different height.') // prettier-ignore
  }, 600_000)
})

// #927 AC3: the midway restart skips the Layer 1 Y high byte (bank_05.asm:7362-7373), so it can only
// differ from the normal entry on a vertical map (F600 bit 5, :7292-7299) that also has a midway
// nibble (F400 >> 4). Measured on vanilla: 38 midway maps, 0 vertical, so the two entry branches
// give the same Layer 1 Y everywhere.
describe.skipIf(!hasRom(VANILLA))('midway entry versus vertical maps (vanilla, #927)', () => {
  it('no map is both vertical (F600 & $20) and has a nonzero F400 midway nibble', () => {
    const rom = RomFile.load(romPath(VANILLA))
    const byte = (a: number) => rom.readByte(a) ?? 0
    const midway: number[] = []
    const both: number[] = []
    for (let i = 0; i < 0x200; i++) {
      const hasMidway = byte(0x05f400 + i) >> 4 !== 0
      if (hasMidway) midway.push(i)
      if (hasMidway && (byte(0x05f600 + i) & 0x20) !== 0) both.push(i)
    }
    expect(midway.length).toBeGreaterThan(30) // the sweep sees real midway maps (38 over all 512 slots)
    expect(both).toEqual([])
  })
})
