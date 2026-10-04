/**
 * The map tab's L2 (background) and the layer order (#459, PR 2): the core's
 * `buildL2Inputs` (src/rom/model/L2Model.ts), the two plane drawing in
 * theia/extension/src/node/map-screen.ts, and the production wiring that adds
 * both to L1's build. Synthetic cases run without a ROM; the corpus sweep at
 * the end reports what the real slots hold.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import * as Map16Real from '../../../src/rom/Map16'
import * as L2LoaderReal from '../../../src/rom/L2Loader'
import type * as Map16Mod from '../../../src/rom/Map16'
import type * as L2LoaderMod from '../../../src/rom/L2Loader'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import { SWITCH_FLAGS_UNCLEARED as UNCLEARED } from '../../../src/rom/ObjectExpander'
import type { Map16Tile } from '../../../src/rom/Map16'
import type { VramState } from '../../../src/rom/GfxLoader'
import type { RgbaColor } from '../../../src/rom/GraphicsDecoder'
import { buildL1Inputs, type L1Inputs } from '../../../src/rom/model/L1Model'
import { buildL2Inputs, type L2Inputs } from '../../../src/rom/model/L2Model'
import {
  buildMapInputs,
  drawL2Planes,
  screenResult,
  toolbarArtOf,
  type MapInputs,
} from '../../../theia/extension/src/node/map-screen'
import { MAP_PLANE_KEYS } from '../../../theia/extension/src/common/project-protocol'
import { palaceArt } from '../../../src/rom/SwitchArt'
import { VANILLA, MAGIC, hasRom, romPath } from '../support/corpus'
import { bgModeRom } from '../support/bgModeRom'

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

// ── Synthetic inputs ─────────────────────────────────────────────────────────

const sub = (charNum: number, palette = 0, priority = false) => ({ charNum, palette, priority, flipX: false, flipY: false }) // prettier-ignore
const tile = (id: number, q: ReturnType<typeof sub>[]): Map16Tile => ({ id, tl: q[0]!, tr: q[1]!, bl: q[2]!, br: q[3]! }) // prettier-ignore
/** Chars 1-4 solid in color index 1-4; char 0 transparent. */
const VRAM: VramState = { fg1: [0, 1, 2, 3, 4].map(v => new Uint8Array(64).fill(v)) }
/** Color c of palette row r is [r * 16 + c, 100, 200]; index 0 is transparent. */
const COLORS: RgbaColor[] = Array.from({ length: 256 }, (_, i) => (i % 16 === 0 ? [0, 0, 0, 0] : [i, 100, 200, 255])) // prettier-ignore

const hGrid = (screens: number) => Array.from({ length: 27 }, () => new Array<number>(screens * 16).fill(0)) // prettier-ignore
const vGrid = (screens: number) => Array.from({ length: screens * 16 }, () => new Array<number>(32).fill(0)) // prettier-ignore
const nullGrid = (rows: number, cols: number) => Array.from({ length: rows }, () => new Array<number | null>(cols).fill(null)) // prettier-ignore

function l1Inputs(
  grid: number[][],
  isVertical: boolean,
  screenCount: number,
  tileset = 0,
): L1Inputs {
  const tiles: Map16Tile[] = []
  tiles[0] = tile(0, [sub(0), sub(0), sub(0), sub(0)])
  tiles[1] = tile(1, [sub(1), sub(2), sub(3), sub(4)])
  return {
    header: parseLevelHeader([0, 0, 0, 0, tileset]),
    isVertical,
    screenCount,
    grid,
    map16: { tiles, pipeVariants: [] },
    rawVram: VRAM,
    anim: null,
    vram: VRAM,
    colors: COLORS,
    backArea: [250, 9, 9, 255],
    unverified: [],
    switchArt: new Map(),
  }
}

const tiles2 = (...t: Map16Tile[]) => t.reduce<Map16Tile[]>((a, x) => ((a[x.id] = x), a), [])
const l2Of = (grid: (number | null)[][], tiles: Map16Tile[], dy = 0): L2Inputs => ({ kind: 'objects', grid, tiles, dy }) // prettier-ignore
const mapOf = (m: L1Inputs, l2?: MapInputs['l2'], orderNote?: string): MapInputs => ({ ...m, l2, orderNote }) // prettier-ignore

const px = (buf: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(buf.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
const opaque = (buf: Uint8ClampedArray | null, width: number, x: number, y: number) =>
  buf !== null && px(buf, width, x, y)[3] === 255
const decode = (b64: string | null) => (b64 === null ? null : new Uint8ClampedArray(Buffer.from(b64, 'base64'))) // prettier-ignore

// ── Drawing ──────────────────────────────────────────────────────────────────

describe('L2 planes (synthetic)', () => {
  const l1 = l1Inputs(hGrid(1), false, 1)

  it('a cell draws each quadrant in its own color, in the low plane when no priority bit is set', () => {
    const p = drawL2Planes(l1, l2Of([[1]], tiles2(tile(1, [sub(1), sub(2), sub(3), sub(4)]))), 0)
    expect([px(p.l2Low!, 256, 3, 3)[0], px(p.l2Low!, 256, 11, 3)[0], px(p.l2Low!, 256, 3, 11)[0], px(p.l2Low!, 256, 11, 11)[0]]).toEqual([1, 2, 3, 4]) // prettier-ignore
    expect(p.l2High).toBeNull()
  })

  it('a priority subtile lands in l2High and leaves l2Low clear there', () => {
    const t = tile(1, [sub(1), sub(2, 0, true), sub(3), sub(4)])
    const p = drawL2Planes(l1, l2Of([[1]], tiles2(t)), 0)
    expect(opaque(p.l2High, 256, 11, 3)).toBe(true)
    expect(opaque(p.l2Low, 256, 11, 3)).toBe(false)
    expect(opaque(p.l2Low, 256, 3, 3)).toBe(true)
    expect(opaque(p.l2High, 256, 3, 3)).toBe(false)
  })

  it('draws the cell column of the screen asked for, and nothing past the grid', () => {
    const grid = nullGrid(27, 32)
    grid[0]![16] = 1 // screen 1, column 0
    const l2 = l2Of(grid, tiles2(tile(1, [sub(1), sub(1), sub(1), sub(1)])))
    const m = l1Inputs(hGrid(3), false, 3)
    expect(opaque(drawL2Planes(m, l2, 1).l2Low, 256, 3, 3)).toBe(true)
    expect(drawL2Planes(m, l2, 0).l2Low).toBeNull()
    expect(drawL2Planes(m, l2, 2).l2Low).toBeNull() // beyond the grid's 2 screens: blank, no throw
  })

  it('applies Layer2YPos as a pixel shift: down, partly off the top, and off the screen', () => {
    const t = tiles2(tile(1, [sub(1), sub(1), sub(1), sub(1)]))
    const grid = nullGrid(27, 16)
    grid[0]![0] = 1
    const at = (dy: number) => drawL2Planes(l1, l2Of(grid, t, dy), 0).l2Low
    expect([opaque(at(5), 256, 3, 4), opaque(at(5), 256, 3, 5), opaque(at(5), 256, 3, 20), opaque(at(5), 256, 3, 21)]).toEqual([false, true, true, false]) // prettier-ignore
    expect([opaque(at(-8), 256, 3, 0), opaque(at(-8), 256, 3, 7), opaque(at(-8), 256, 3, 8)]).toEqual([true, true, false]) // prettier-ignore
    expect(at(-16)).toBeNull() // wholly above the screen
    expect(at(27 * 16)).toBeNull() // wholly below it
  })

  it('a vertical map slices the shifted grid per screen, so a cell straddling the seam draws on both', () => {
    const m = l1Inputs(vGrid(2), true, 2)
    const grid = nullGrid(32, 32)
    grid[15]![0] = 1 // level rows 240-255, shifted by 8 to 248-263
    const l2 = l2Of(grid, tiles2(tile(1, [sub(1), sub(1), sub(1), sub(1)])), 8)
    const top = drawL2Planes(m, l2, 0).l2Low
    const bottom = drawL2Planes(m, l2, 1).l2Low
    expect([opaque(top, 512, 3, 247), opaque(top, 512, 3, 248), opaque(top, 512, 3, 255)]).toEqual([false, true, true]) // prettier-ignore
    expect([opaque(bottom, 512, 3, 0), opaque(bottom, 512, 3, 7), opaque(bottom, 512, 3, 8)]).toEqual([true, true, false]) // prettier-ignore
  })
})

describe('the wire carries four planes in the view stacking order (synthetic)', () => {
  it('each key holds its own layer and priority', () => {
    const m = l1Inputs(hGrid(1), false, 1)
    // L1 at cell 0: tl low, tr high. L2 at cell 1: bl low, br high; palette 1 so it is told apart.
    m.map16.tiles[1] = tile(1, [sub(1), sub(2, 0, true), sub(3), sub(4)])
    m.grid[0]![0] = 1
    m.map16.tiles[2] = tile(2, [sub(0), sub(0), sub(3, 1), sub(4, 1, true)])
    const l2 = l2Of(nullGrid(27, 16), m.map16.tiles)
    l2.grid[0]![1] = 2
    const wire = screenResult(mapOf(m, { ok: true, l2 }), 0)
    if (wire.status !== 'ok') throw new Error(wire.status)
    expect(Object.keys(wire.planes)).toEqual([...MAP_PLANE_KEYS])
    expect(MAP_PLANE_KEYS).toEqual(['l2Low', 'l1Low', 'l2High', 'l1High'])
    const p = Object.fromEntries(MAP_PLANE_KEYS.map(k => [k, decode(wire.planes[k])]))
    // [cell 0 tl, cell 0 tr, cell 1 bl, cell 1 br]
    const spots = [
      [3, 3],
      [11, 3],
      [16 + 3, 11],
      [16 + 11, 11],
    ] as const
    const hits = (k: (typeof MAP_PLANE_KEYS)[number]) =>
      spots.map(([x, y]) => opaque(p[k]!, 256, x, y))
    expect(hits('l1Low')).toEqual([true, false, false, false])
    expect(hits('l1High')).toEqual([false, true, false, false])
    expect(hits('l2Low')).toEqual([false, false, true, false])
    expect(hits('l2High')).toEqual([false, false, false, true])
    expect(px(p.l2Low!, 256, 16 + 3, 11)[0]).toBe(1 * 16 + 3) // palette row 1
  })

  it('an unreadable background has null planes and a note, while L1 still draws', () => {
    const m = l1Inputs(hGrid(1), false, 1)
    m.grid[0]![0] = 1
    const wire = screenResult(mapOf(m, { ok: false, reason: 'the table is gone' }), 0)
    if (wire.status !== 'ok') throw new Error(wire.status)
    expect([wire.planes.l2Low, wire.planes.l2High]).toEqual([null, null])
    expect(wire.planes.l1Low).toBeTruthy()
    expect(wire.l2Note).toBe('the table is gone')
  })

  it('a map with no background data has null planes and no note', () => {
    const m = l1Inputs(hGrid(1), false, 1)
    for (const l2 of [undefined, { ok: true as const, l2: null }]) {
      const wire = screenResult(mapOf(m, l2), 0)
      if (wire.status !== 'ok') throw new Error(wire.status)
      expect([wire.planes.l2Low, wire.planes.l2High, wire.l2Note]).toEqual([null, null, undefined])
    }
  })
})

// ── The core's L2 reading ────────────────────────────────────────────────────

describe('buildL2Inputs (synthetic ROM)', () => {
  const LEVEL = 5
  const romWith = (writes: [number, number[]][] = []) => {
    const rom = new RomFile('l2.sfc', Buffer.alloc(0x80000, 0))
    rom.writeAt(0x05d708, [0x00, 0x20, 0x40, 0x80]) // DATA_05D708: L1 initial Y
    rom.writeAt(0x05d70c, [0x60, 0x90, 0xc0, 0x00]) // DATA_05D70C: L2 initial Y
    rom.writeAt(0x05f400 + LEVEL, [(1 << 2) | 2]) // L1 index 1 ($20), L2 index 2 ($C0)
    for (const [addr, bytes] of writes) rom.writeAt(addr, bytes)
    return rom
  }
  const ptr = (lo: number, hi: number, bank: number): [number, number[]] => [0x05e600 + LEVEL * 3, [lo, hi, bank]] // prettier-ignore
  const smw = (rom: RomFile, l2Vertical = false) =>
    ({ rom, getVerticalTable: () => ({ ok: true, table: new Array(32).fill(l2Vertical ? 2 : 0) }) }) as unknown as SmwRom // prettier-ignore
  const one = tile(7, [sub(1), sub(1), sub(1), sub(1)])

  it('an L2 pointer of zero is no background, not a refusal', () => {
    expect(buildL2Inputs(smw(romWith()), LEVEL, l1Inputs(hGrid(1), false, 1))).toEqual({ ok: true, l2: null }) // prettier-ignore
  })

  it('an image tiles across the map: 27 rows by 16 columns a screen, or 32 wide by 16 rows stacked', () => {
    const rom = romWith([ptr(0x00, 0x80, 0xff), [0x0c8000, [0x84, 0x07, 0xff, 0xff]]]) // 5 x $07, then the $25 fill
    vi.mocked(Map16Real.readL2Map16Table).mockReturnValue({ ok: true, value: [0] })
    vi.mocked(Map16Real.loadMap16Tiles).mockReturnValue(tiles2(one))
    const h = buildL2Inputs(smw(rom), LEVEL, l1Inputs(hGrid(3), false, 3))
    if (!h.ok || !h.l2) throw new Error('no image')
    expect([h.l2.kind, h.l2.dy, h.l2.grid.length, h.l2.grid[0]!.length]).toEqual([
      'image',
      0,
      27,
      48,
    ])
    expect([h.l2.grid[0]![0], h.l2.grid[0]![4], h.l2.grid[0]![5], h.l2.grid[0]![32]]).toEqual([
      7, 7, 0x25, 7,
    ]) // the 32-wide pattern repeats; $25 draws
    const v = buildL2Inputs(smw(rom), LEVEL, l1Inputs(vGrid(2), true, 2))
    if (!v.ok || !v.l2) throw new Error('no image')
    expect([v.l2.grid.length, v.l2.grid[0]!.length]).toEqual([32, 32])
    // The BG plane is 32 rows and the pattern 27: rows 27-31 are empty, then it repeats.
    expect([v.l2.grid[26]![0], v.l2.grid[27]![0], v.l2.grid[31]![0]]).toEqual([0x25, null, null])
  })

  it('an address at or past $E8FE selects Map16 page 1', () => {
    const rom = romWith([ptr(0x00, 0xe9, 0xff), [0x0ce900, [0x00, 0x07, 0xff, 0xff]]])
    vi.mocked(Map16Real.readL2Map16Table).mockReturnValue({ ok: true, value: [0] })
    vi.mocked(Map16Real.loadMap16Tiles).mockReturnValue([])
    const r = buildL2Inputs(smw(rom), LEVEL, l1Inputs(hGrid(1), false, 1))
    expect(r.ok && r.l2?.grid[0]![0]).toBe(0x107)
  })

  it('an image whose Map16 table cannot be read is refused with that reason, not drawn from vanilla', () => {
    const rom = romWith([ptr(0x00, 0x80, 0xff), [0x0c8000, [0x00, 0x07, 0xff, 0xff]]])
    // The zeroed ROM has no BG fill loop, so the core's own reader declines.
    const r = buildL2Inputs(smw(rom), LEVEL, l1Inputs(hGrid(1), false, 1))
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Map16 table cannot be read/) }) // prettier-ignore
  })

  it('an object stream keeps its ids, empties $25, and sits Layer1YPos - Layer2YPos down', () => {
    vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({
      grid: [
        [0x25, 1],
        [1, 0x25],
      ],
    })
    const rom = romWith([ptr(0x00, 0x90, 0x0c)])
    const m = l1Inputs(hGrid(1), false, 1)
    const r = buildL2Inputs(smw(rom), LEVEL, m)
    if (!r.ok || !r.l2) throw new Error('no objects')
    expect(r.l2.grid).toEqual([
      [null, 1],
      [1, null],
    ])
    expect(r.l2.dy).toBe(0x20 - 0xc0)
    expect(r.l2.tiles[1]).toEqual(m.map16.tiles[1]) // L1's own table, not vanilla's
    expect(vi.mocked(L2LoaderReal.loadL2Objects).mock.calls[0]!.slice(2)).toEqual([1, 0, false])
  })

  it('tileset 3 ORs palette bit 2 into every L2 subtile, and no other tileset does', () => {
    vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid: [[1]] })
    const rom = romWith([ptr(0x00, 0x90, 0x0c)])
    const palettes = (tileset: number) => {
      const r = buildL2Inputs(smw(rom), LEVEL, l1Inputs(hGrid(1), false, 1, tileset))
      const t = r.ok ? r.l2!.tiles[1]! : null
      return t && [t.tl, t.tr, t.bl, t.br].map(s => s.palette)
    }
    expect(palettes(3)).toEqual([4, 4, 4, 4])
    expect(palettes(0)).toEqual([0, 0, 0, 0])
  })

  it('an L2 whose orientation differs from L1 is refused with both named', () => {
    vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid: [[1]] })
    const rom = romWith([ptr(0x00, 0x90, 0x0c)])
    const r = buildL2Inputs(smw(rom, true), LEVEL, l1Inputs(hGrid(1), false, 1))
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/L2 is vertical but L1 is horizontal/) }) // prettier-ignore
  })

  it('an unreadable object stream and a throw are each refused, never a partial grid', () => {
    const rom = romWith([ptr(0x00, 0x90, 0x0c)])
    vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValueOnce(null)
    expect(buildL2Inputs(smw(rom), LEVEL, l1Inputs(hGrid(1), false, 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/object stream .* cannot be read/) }) // prettier-ignore
    vi.mocked(L2LoaderReal.loadL2Objects).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(buildL2Inputs(smw(rom), LEVEL, l1Inputs(hGrid(1), false, 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/boom/) }) // prettier-ignore
  })

  it('a pointer outside the ROM is refused', () => {
    const rom = new RomFile('tiny.sfc', Buffer.alloc(0x8000, 0))
    expect(buildL2Inputs(smw(rom), LEVEL, l1Inputs(hGrid(1), false, 1))).toMatchObject({ ok: false }) // prettier-ignore
  })
})

// ── The production wiring ────────────────────────────────────────────────────

describe('the map build adds the background and the layer order (synthetic)', () => {
  const ok = () => ({ ok: true as const, inputs: l1Inputs(hGrid(1), false, 1) })

  it("L1's refusal is the map's, and a background or order failure never refuses the map", () => {
    const rom = new SmwRom(bgModeRom(2, [0x05e600 + 5 * 3, [0x00, 0x90, 0x0c]]))
    expect(buildMapInputs(rom, 5, UNCLEARED, () => ({ ok: false, reason: 'GFX unreadable' }))).toEqual({ ok: false, reason: 'GFX unreadable' }) // prettier-ignore
    const built = buildMapInputs(rom, 5, UNCLEARED, ok)
    if (!built.ok) throw new Error('refused')
    expect(built.inputs.orderNote).toMatch(/BG mode 2/)
    // An object stream needs the vertical table, which this ROM lacks: the L2 reading refuses, the map does not.
    expect(built.inputs.l2).toMatchObject({ ok: false })
  })

  it('the BG mode check does not touch the switch toolbar art', () => {
    const base = l1Inputs(hGrid(1), false, 1)
    const rom = bgModeRom()
    const art = palaceArt(rom)
    const plain = toolbarArtOf(rom, { ok: true, inputs: base }, art)
    const noted = toolbarArtOf(rom, { ok: true, inputs: mapOf(base, { ok: false, reason: 'x' }, 'unverified') }, art) // prettier-ignore
    expect(noted).toEqual(plain)
  })
})

// ── The corpus ───────────────────────────────────────────────────────────────

describe.each([VANILLA, MAGIC])('every slot of %s', name => {
  it.skipIf(!hasRom(name))(
    'reads or refuses its background with a reason, and counts l2High',
    () => {
      const rom = new SmwRom(RomFile.load(romPath(name)))
      const tally = {
        l1: 0,
        none: 0,
        image: 0,
        objects: 0,
        refused: 0,
        high: 0,
        highSlots: [] as number[],
      }
      const reasons = new Map<string, number>()
      for (let index = 0; index < 0x200; index++) {
        const built = buildL1Inputs(rom, index, UNCLEARED)
        if (!built.ok) continue
        tally.l1++
        const l2 = buildL2Inputs(rom, index, built.inputs)
        if (!l2.ok) {
          expect(l2.reason.length).toBeGreaterThan(0)
          tally.refused++
          reasons.set(l2.reason, (reasons.get(l2.reason) ?? 0) + 1)
          continue
        }
        if (!l2.l2) {
          tally.none++
          continue
        }
        tally[l2.l2.kind]++
        let high = false
        for (let s = 0; s < built.inputs.screenCount && !high; s++)
          high = drawL2Planes(built.inputs, l2.l2, s).l2High !== null
        if (high) {
          tally.high++
          tally.highSlots.push(index)
        }
      }
      console.info(`L2 ${name}: ${JSON.stringify({ ...tally, highSlots: tally.highSlots.slice(0, 40) })} refusals ${JSON.stringify([...reasons])}`) // prettier-ignore
      expect(tally.l1).toBeGreaterThan(100)
      expect(tally.image + tally.objects).toBeGreaterThan(0)
    },
    600_000,
  )
})
