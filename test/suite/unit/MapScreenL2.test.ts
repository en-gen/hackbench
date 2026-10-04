/**
 * The map tab's L2 (background) and the layer order (#459, PR 2): the core's
 * `buildL2Inputs` (src/rom/model/L2Model.ts), the two-plane drawing in
 * theia/extension/src/node/map-screen.ts, and the build that adds both to L1's.
 * Synthetic cases run without a ROM; the corpus sweep at the end checks real slots.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
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
  screenResult,
  toolbarArtOf,
  type MapInputs,
} from '../../../theia/extension/src/node/map-screen'
import { MAP_PLANE_KEYS } from '../../../theia/extension/src/common/project-protocol'
import { palaceArt } from '../../../src/rom/SwitchArt'
import { VANILLA, MAGIC, hasRom, romPath } from '../support/corpus'
import { bgModeRom } from '../support/bgModeRom'
import { hGrid, inputs, px, sub, tile, vGrid } from '../support/mapInputs'

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
const l2Of = (grid: (number | null)[][], tiles: Map16Tile[], dy = 0): L2Inputs => ({ kind: 'objects', grid, tiles, dy }) // prettier-ignore
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

  it('a vertical stack taller than the 32-row plane is not wrapped', () => {
    const m = inputs(vGrid(3), true, 3)
    const grid = nullGrid(48, 32)
    grid[0]![0] = 1
    const l2 = l2Of(grid, tiles2(solid), -8) // would reappear at 504 if wrapped
    expect(opaque(drawL2Planes(m, l2, 0).l2Low, 512, 3, 0)).toBe(true)
    expect(drawL2Planes(m, l2, 1).l2Low).toBeNull()
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
    expect(MAP_PLANE_KEYS).toEqual(['l2Low', 'l1Low', 'l2High', 'l1High'])
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
})

// ── The core's L2 reading ────────────────────────────────────────────────────

describe('buildL2Inputs (synthetic ROM)', () => {
  const LEVEL = 5
  // DATA_05D708 (L1 Y) index 1 = $20; DATA_05D70C (L2 Y) index 2 = $C0.
  const romWith = (writes: [number, number[]][] = []) => {
    const rom = new RomFile('l2.sfc', Buffer.alloc(0x80000, 0))
    rom.writeAt(0x05d708, [0x00, 0x20, 0x40, 0x80])
    rom.writeAt(0x05d70c, [0x60, 0x90, 0xc0, 0x00])
    rom.writeAt(0x05f400 + LEVEL, [(1 << 2) | 2])
    for (const [addr, bytes] of writes) rom.writeAt(addr, bytes)
    return rom
  }
  const ptr = (lo: number, hi: number, bank: number): [number, number[]] => [0x05e600 + LEVEL * 3, [lo, hi, bank]] // prettier-ignore
  const smw = (rom: RomFile, l2Vertical = false) =>
    ({ rom, getVerticalTable: () => ({ ok: true, table: new Array(32).fill(l2Vertical ? 3 : 0) }) }) as unknown as SmwRom // prettier-ignore
  const one = tile(7, [sub(1, 3), sub(1, 3), sub(1, 3), sub(1, 3)])
  const objects = (grid: number[][]) =>
    vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid })
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
    const h = ok(buildL2Inputs(smw(image()), LEVEL, inputs(hGrid(3), false, 3)))
    expect([h.kind, h.grid.length, h.grid[0]!.length]).toEqual(['image', 27, 48])
    expect([h.grid[0]![0], h.grid[0]![4], h.grid[0]![5], h.grid[0]![32]]).toEqual([7, 7, 0x25, 7]) // the 32-wide pattern repeats; $25 draws
    const v = ok(buildL2Inputs(smw(image()), LEVEL, inputs(vGrid(2), true, 2)))
    expect([v.grid.length, v.grid[0]!.length]).toEqual([32, 32])
    // The BG plane is 32 rows and the pattern 27: rows 27-31 are empty, then it repeats.
    expect([v.grid[26]![0], v.grid[27]![0], v.grid[31]![0]]).toEqual([0x25, null, null])
  })

  it('an image sits Layer1YPos - Layer2YPos down, like an object stream (bank_05.asm:7323-7328)', () => {
    expect(ok(buildL2Inputs(smw(image()), LEVEL, inputs(hGrid(1), false, 1))).dy).toBe(0x20 - 0xc0)
  })

  it('an image whose Map16 table cannot be read is refused with that reason, not drawn from vanilla', () => {
    const rom = romWith([ptr(0x00, 0x80, 0xff), [0x0c8000, [0x00, 0x07, 0xff, 0xff]]])
    // The zeroed ROM has no BG fill loop, so the core's own reader declines.
    expect(buildL2Inputs(smw(rom), LEVEL, inputs(hGrid(1), false, 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/Map16 table cannot be read/) }) // prettier-ignore
  })

  it('an object stream keeps its ids, empties $25, and sits Layer1YPos - Layer2YPos down', () => {
    objects([
      [0x25, 1],
      [1, 0x25],
    ])
    const m = inputs(hGrid(1), false, 1)
    const l2 = ok(buildL2Inputs(smw(romWith([ptr(0x00, 0x90, 0x0c)])), LEVEL, m))
    expect(l2.grid).toEqual([
      [null, 1],
      [1, null],
    ])
    expect(l2.dy).toBe(0x20 - 0xc0)
    expect(l2.tiles[1]).toEqual(m.map16.tiles[1]) // L1's own table, not vanilla's
    expect(vi.mocked(L2LoaderReal.loadL2Objects).mock.calls[0]!.slice(2)).toEqual([1, 0, false])
  })

  it('a vertical map reads its L2 as vertical, and its high byte only when VertLayer2Setting is not 3', () => {
    objects([[1]])
    // F000 high nibble 0 -> DATA_05D710[0] (3 on a stock ROM); F600 & $1F = 3 is the high byte.
    const vertical = (d710: number) =>
      romWith([ptr(0x00, 0x90, 0x0c), [0x05f600 + LEVEL, [0x03]], [0x05d710, [d710]], [0x05f000 + LEVEL, [0x00]]]) // prettier-ignore
    const read = (d710: number) => ok(buildL2Inputs(smw(vertical(d710), true), LEVEL, inputs(vGrid(1), true, 1))).dy // prettier-ignore
    expect(read(3)).toBe(0x320 - 0xc0) // L1 gets the high byte (it is vertical), L2's stays 0
    expect(read(1)).toBe(0x320 - 0x3c0) // both have it
    expect(vi.mocked(L2LoaderReal.loadL2Objects).mock.calls[0]!.slice(2)).toEqual([1, 0, true])
  })

  it('tileset 3 ORs palette bit 2 into every L2 object subtile, and no image tile', () => {
    objects([[1]])
    const objRom = romWith([ptr(0x00, 0x90, 0x0c)])
    const palettes = (rom: RomFile, tileset: number, id: number) => {
      const t = ok(buildL2Inputs(smw(rom), LEVEL, inputs(hGrid(1), false, 1, tileset))).tiles[id]!
      return [t.tl, t.tr, t.bl, t.br].map(s => s.palette)
    }
    expect(palettes(objRom, 3, 1)).toEqual([4, 4, 4, 4])
    expect(palettes(objRom, 0, 1)).toEqual([0, 0, 0, 0])
    expect(palettes(image(), 3, 7)).toEqual([3, 3, 3, 3]) // an image keeps its own, as the core's L2Preset does
  })

  it('an L2 whose orientation differs from L1 is refused with both named', () => {
    objects([[1]])
    const r = buildL2Inputs(smw(romWith([ptr(0x00, 0x90, 0x0c)]), true), LEVEL, inputs(hGrid(1), false, 1)) // prettier-ignore
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/L2 is vertical but L1 is horizontal/) }) // prettier-ignore
  })

  it('an unreadable object stream and a throw are each refused, never a partial grid', () => {
    const rom = romWith([ptr(0x00, 0x90, 0x0c)])
    vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValueOnce(null)
    expect(buildL2Inputs(smw(rom), LEVEL, inputs(hGrid(1), false, 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/object stream .* cannot be read/) }) // prettier-ignore
    vi.mocked(L2LoaderReal.loadL2Objects).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(buildL2Inputs(smw(rom), LEVEL, inputs(hGrid(1), false, 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/boom/) }) // prettier-ignore
  })

  it('a pointer outside the ROM is refused', () => {
    const rom = new RomFile('tiny.sfc', Buffer.alloc(0x8000, 0))
    expect(buildL2Inputs(smw(rom), LEVEL, inputs(hGrid(1), false, 1))).toMatchObject({ ok: false }) // prettier-ignore
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

  it('the cache reads the BG mode once per working-copy bytes, not once per map', () => {
    const seen: unknown[] = []
    const cache = new L1ModelCache((_rom, _index, _flags, bgMode) => {
      seen.push(bgMode!())
      return ok()
    })
    const bytes = bgModeRom().buffer
    mapScreen(cache, bytes, 'x.sfc', 5, 0, UNCLEARED)
    mapScreen(cache, bytes, 'x.sfc', 6, 0, UNCLEARED)
    mapScreen(cache, bgModeRom().buffer, 'x.sfc', 5, 0, UNCLEARED) // an edit: new bytes
    expect(seen[0]).toBe(seen[1])
    expect(seen[2]).not.toBe(seen[0])
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

  // Layer2YPos is DATA_05D70C[F400 & 3] whatever the L2 kind: $012 starts at L1 $00, L2 $C0.
  it.skipIf(!hasRom(name))('$012 is an image shifted up by its Layer2YPos', () => {
    const rom = new SmwRom(RomFile.load(romPath(name)))
    const built = buildL1Inputs(rom, 0x012, UNCLEARED)
    if (!built.ok) throw new Error(built.reason)
    expect(buildL2Inputs(rom, 0x012, built.inputs)).toMatchObject({ ok: true, l2: { kind: 'image', dy: -0xc0 } }) // prettier-ignore
  })
})
