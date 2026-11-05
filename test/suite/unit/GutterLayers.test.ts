/**
 * Layers 2 and 3 through the far-end gutter (#1197). Everything is synthetic: made-up tiles, grids and
 * streams, no ROM. Covers the core split of a stream past the last screen, `drawL2Beyond` and
 * `beyondResult` in the node backend, and the pure fade and coverage helpers the view paints with.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { SWITCH_FLAGS_UNCLEARED as UNCLEARED } from '../../../src/rom/ObjectExpander'
import { composeScreen } from '../../../src/rom/model/ColorMath'
import { RomFile } from '../../../src/rom/RomFile'
import type * as ExpanderMod from '../../../src/rom/ObjectExpander'
import { loadL2Objects, tilePresetGrid, L2_EMPTY_TILE } from '../../../src/rom/L2Loader'
import { MAX_BEYOND_SCREENS, farGutter } from '../../../src/rom/model/MapGutter'
import type { L2Inputs } from '../../../src/rom/model/L2Model'
import type { L3Inputs } from '../../../src/rom/L3Loader'
import {
  beyondResult,
  L1ModelCache,
  mapBeyond,
  drawL2Beyond,
  drawL2Planes,
  drawL3Planes,
  screenResult,
  type MapInputs,
} from '../../../theia/extension/src/node/map-screen'
import {
  beyondScreens,
  clearUncovered,
  composeGutter,
  fadeFarEnd,
  fadeMask,
  type GutterShot,
} from '../../../theia/extension/src/browser/off-map-extent'
import { COLORS, hGrid, inputs, px, sub, tile, vGrid } from '../support/mapInputs'

// A stand-in for the object handlers (which need real ROM tables): every object writes 4 tiles from its
// anchor, so a stream near the edge spills past it exactly as a real wide object would.
vi.mock('../../../src/rom/ObjectExpander', async importOriginal => {
  const real = await importOriginal<typeof ExpanderMod>()
  return {
    ...real,
    // Like writeTile: a row grows (padded with $25) to reach the column, so a plain call can come out longer than the map.
    expandObject: (grid: number[][], obj: { x: number; y: number }) => {
      const row = grid[obj.y]
      if (!row) return
      for (let i = 0; i < 4; i++) {
        while (row.length < obj.x + i) row.push(0x25)
        row[obj.x + i] = 0x40 + i
      }
    },
  }
})

const solid = tile(1, [sub(1), sub(1), sub(1), sub(1)])
const tiles = [undefined, solid, tile(2, [sub(5), sub(5), sub(5), sub(5)])] // tile 2 is blank until the blue switch is on
const alpha = (b: Uint8ClampedArray | null, w: number, x: number, y: number) => (b ? px(b, w, x, y)[3] : null) // prettier-ignore
const nullGrid = (rows: number, cols: number) => Array.from({ length: rows }, () => new Array<number | null>(cols).fill(null)) // prettier-ignore
const same = (a: Uint8ClampedArray | null, b: Uint8ClampedArray | null) => (a === null || b === null ? a === b : Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0) // prettier-ignore

/** A ROM holding an object stream at 0x078000 (5-byte header, then the objects as given). */
function rom(objects: number[][]): RomFile {
  const buf = Buffer.alloc(0x400000, 0)
  buf[0x7fd5] = 0x20
  const r = new RomFile('m.smc', buf)
  r.writeAt(0x078000, [0, 0, 0, 0, 0, ...objects.flat(), 0xff])
  return r
}

describe('loadL2Objects past the last screen', () => {
  // b1 = y<<4 | x: x = 15 is the last column of a one-screen map.
  const edge = rom([[0x00, 0x0f, 0x00]])

  it('the map screens are the grid a plain call builds, whatever extra room is asked for', () => {
    const plain = loadL2Objects(edge, 0x078000, 1, 0, false)!
    const wide = loadL2Objects(edge, 0x078000, 1, 0, false, MAX_BEYOND_SCREENS)!
    // A plain call grows the rows the object spills along; the wide call keeps the map width and moves the spill to beyond.
    const row = plain.grid.findIndex(r => r[15] === 0x40)
    expect(plain.grid[row]!.length).toBe(19)
    expect(wide.grid[row]).toEqual(plain.grid[row]!.slice(0, 16))
    expect(wide.grid.every(r => r.length === 16)).toBe(true)
    expect(wide.grid.map((r, y) => r.every((v, x) => v === plain.grid[y]![x]))).not.toContain(false)
    expect(plain.beyond).toBeUndefined()
    expect(wide.unverified).toEqual(plain.unverified)
  })

  it('what the stream wrote past the edge is the beyond grid, column 0 being the first column past it', () => {
    const { grid, beyond } = loadL2Objects(edge, 0x078000, 1, 0, false, 2)!
    const row = grid.findIndex(r => r[15] === 0x40)
    expect(row).toBeGreaterThanOrEqual(0)
    expect(beyond![row]!.slice(0, 4)).toEqual([0x41, 0x42, 0x43, L2_EMPTY_TILE])
    // Everything else past the edge was never written and stays empty, not filled in.
    expect(beyond!.flat().filter(v => v !== L2_EMPTY_TILE)).toHaveLength(3)
  })

  it('a stream wholly inside the map writes nothing past the edge', () => {
    const { beyond } = loadL2Objects(rom([[0x00, 0x01, 0x00]]), 0x078000, 1, 0, false, 2)!
    expect(beyond!.flat().every(v => v === L2_EMPTY_TILE)).toBe(true)
  })

  it('a vertical stream splits by rows, with the width unchanged', () => {
    const { grid, beyond } = loadL2Objects(rom([]), 0x078000, 2, 0, true, 3)!
    expect([grid.length, grid[0]!.length, beyond!.length, beyond![0]!.length]).toEqual([32, 32, 48, 32]) // prettier-ignore
  })
})

describe('drawL2Beyond', () => {
  // The 32 x 32 plane an image wraps in: tile 1 in columns 0 and 16 of row 0, rows 27+ empty.
  const plane = nullGrid(32, 32)
  plane[0]![0] = 1
  plane[0]![16] = 1
  const image = (): L2Inputs => ({ kind: 'image', grid: tilePresetGrid({ grid: plane as number[][] }, 64, 27), plane, tiles, dy: 0 }) // prettier-ignore

  it('an image continues as the game lays it out: every screen past the end equals the plane wrapped', () => {
    const wide = inputs(hGrid(4), false, 4)
    const two = inputs(hGrid(2), false, 2)
    for (const k of [0, 1, 2, 3]) {
      // The 4-screen grid is the plane tiled to 64 columns; screen k of it is what screen k shows past a 2-screen map.
      const inside = drawL2Planes(wide, image(), k)
      const beyond = drawL2Beyond(two, image(), k)
      expect(same(beyond.l2Low, inside.l2Low), `screen ${k}`).toBe(true)
    }
    expect(alpha(drawL2Beyond(two, image(), 2).l2Low, 256, 3, 3)).toBe(255) // column 32 is plane column 0
    expect(alpha(drawL2Beyond(two, image(), 2).l2Low, 256, 3 * 16 + 3, 3)).toBe(0)
  })

  it('a vertical image wraps in rows the same way', () => {
    const vPlane = nullGrid(32, 32)
    vPlane[2]![5] = 1
    const l2: L2Inputs = { kind: 'image', grid: tilePresetGrid({ grid: vPlane as number[][] }, 32, 64), plane: vPlane, tiles, dy: 0 } // prettier-ignore
    const m = inputs(vGrid(2), true, 2)
    // Screen 2 starts at row 32, which is plane row 0: plane row 2 is two rows down.
    expect(alpha(drawL2Beyond(m, l2, 2).l2Low, 512, 5 * 16 + 3, 2 * 16 + 3)).toBe(255)
    expect(same(drawL2Beyond(m, l2, 2).l2Low, drawL2Planes(m, l2, 2).l2Low)).toBe(true)
  })

  it('an object stream shows only what it wrote past the edge, and nothing past that', () => {
    const m = inputs(hGrid(2), false, 2)
    const beyond = nullGrid(27, 16)
    beyond[0]![3] = 1 // column 35
    const l2: L2Inputs = { kind: 'objects', grid: nullGrid(27, 32), beyond, tiles, dy: 0 }
    expect(alpha(drawL2Beyond(m, l2, 2).l2Low, 256, 3 * 16 + 3, 3)).toBe(255)
    expect(drawL2Beyond(m, l2, 3).l2Low).toBeNull() // the stream wrote nothing there
  })

  it('an object stream that wrote nothing past the edge draws nothing, even with a full last screen', () => {
    const m = inputs(hGrid(2), false, 2)
    const full = Array.from({ length: 27 }, () => new Array<number | null>(32).fill(1))
    for (const beyond of [undefined, nullGrid(27, 16)]) {
      const l2: L2Inputs = { kind: 'objects', grid: full, beyond, tiles, dy: 0 }
      for (const k of [2, 3, 4]) {
        const p = drawL2Beyond(m, l2, k)
        expect([p.l2Low, p.l2High], `screen ${k}`).toEqual([null, null])
      }
    }
  })

  it('a vertical object stream is read by rows past the last screen', () => {
    const m = inputs(vGrid(2), true, 2)
    const beyond = nullGrid(16, 32)
    beyond[2]![5] = 1
    const l2: L2Inputs = { kind: 'objects', grid: nullGrid(32, 32), beyond, tiles, dy: 0 }
    expect(alpha(drawL2Beyond(m, l2, 2).l2Low, 512, 5 * 16 + 3, 2 * 16 + 3)).toBe(255)
  })

  it('a vertical object stream shifted by Layer2YPos draws the rows it pushes across the edge, for several shifts', () => {
    const m = inputs(vGrid(2), true, 2)
    const drawnRows = (l2: L2Inputs) => {
      const p = drawL2Beyond(m, l2, 2).l2Low
      return Array.from({ length: 256 }, (_, y) => alpha(p, 512, 5 * 16 + 3, y)).filter(a => a === 255).length // prettier-ignore
    }
    const first = (l2: L2Inputs) => {
      const p = drawL2Beyond(m, l2, 2).l2Low
      return Array.from({ length: 256 }, (_, y) => alpha(p, 512, 5 * 16 + 3, y)).indexOf(255)
    }
    // Down: grid row 31 (y 496..511) moves to 496+dy; its last dy rows are on screen 2, from its row 0.
    for (const dy of [1, 8, 16]) {
      const grid = nullGrid(32, 32)
      grid[31]![5] = 1
      const l2: L2Inputs = { kind: 'objects', grid, beyond: nullGrid(16, 32), tiles, dy }
      expect([dy, drawnRows(l2), first(l2)], `dy ${dy}`).toEqual([dy, dy, 0])
    }
    // Up: beyond row 0 (y 512..527) moves to 512+dy; its first 16+dy rows stay on screen 2, the rest is on screen 1.
    for (const dy of [-1, -8, -15]) {
      const beyond = nullGrid(16, 32)
      beyond[0]![5] = 1
      const l2: L2Inputs = { kind: 'objects', grid: nullGrid(32, 32), beyond, tiles, dy }
      expect([dy, drawnRows(l2), first(l2)], `dy ${dy}`).toEqual([dy, 16 + dy, 0])
    }
  })

  it('the map own screens are drawn exactly as before', () => {
    const grid = nullGrid(27, 32)
    grid[0]![16] = 1
    const l2: L2Inputs = { kind: 'objects', grid, beyond: nullGrid(27, 16), tiles, dy: 0 }
    const m = inputs(hGrid(2), false, 2)
    expect(alpha(drawL2Planes(m, l2, 1).l2Low, 256, 3, 3)).toBe(255)
    expect(drawL2Planes(m, l2, 0).l2Low).toBeNull()
  })
})

describe('Layer 3 past the last screen', () => {
  const L3_WORD = (1 << 10) | 2
  const chars = [0, 1, 2, 3].map(() => Array.from({ length: 128 }, (_, i) => new Uint8Array(64).fill(i % 4))) // prettier-ignore
  const l3 = (col: number, o: Partial<L3Inputs> = {}): L3Inputs => {
    const tilemap = new Uint16Array(64 * 64)
    tilemap[8 * 64 + col] = L3_WORD
    return { tilemap, chars, colors: COLORS, yPx: 0x40, camYPx: 0, tide: false, ...o }
  }

  it('repeats every 512 px by x, past the end as on a screen', () => {
    // A 2-screen map: screens 2, 4 and 6 carry the repeat of screen 0; 3 and 5 of screen 1.
    expect([2, 3, 4, 5, 6].map(s => drawL3Planes(l3(0), s).l3Low !== null)).toEqual([true, false, true, false, true]) // prettier-ignore
    expect([2, 3, 4].map(s => drawL3Planes(l3(32), s).l3Low !== null)).toEqual([false, true, false])
  })

  it('a layer that follows the camera is one copy, so nothing repeats past the end', () => {
    // Layer3XPos -128: column 0 is at world 128, the copy ends at world 639; screens 3 and up are clear.
    const follow = (col: number) => l3(col, { followsCamera: true, xPx: -128 })
    expect([3, 4, 5].map(s => drawL3Planes(follow(0), s).l3Low)).toEqual([null, null, null])
    expect(drawL3Planes(follow(63), 2).l3Low).not.toBeNull() // world 632, the last column of the copy
    expect(drawL3Planes(follow(63), 4).l3Low).toBeNull() // not the 512 px repeat
  })
})

describe('beyondResult', () => {
  const plane = nullGrid(32, 32)
  plane[0]![0] = 1
  const l2: L2Inputs = { kind: 'image', grid: nullGrid(27, 32), plane, tiles, dy: 0 }
  const L3_WORD = (1 << 10) | 2
  const l3Verdict = (): MapInputs['l3'] => {
    const tilemap = new Uint16Array(64 * 64)
    tilemap[8 * 64] = L3_WORD
    const chars = [0, 1, 2, 3].map(() => Array.from({ length: 128 }, (_, i) => new Uint8Array(64).fill(i % 4))) // prettier-ignore
    return { screens: { main: ['l2Low', 'l3Low'], sub: [] }, cgadsub: null, layer2Interactive: false, priority: false, reason: null, l3: { tilemap, chars, colors: COLORS, yPx: 0x40, camYPx: 0, tide: false } } // prettier-ignore
  }
  const map = (screens: number, vertical = false, extra: Partial<MapInputs> = {}): MapInputs => ({
    ...inputs(vertical ? vGrid(screens) : hGrid(screens), vertical, screens),
    l2: { ok: true, l2 },
    ...extra,
  })
  const ok = (r: ReturnType<typeof beyondResult>) => {
    if (r.status !== 'ok') throw new Error(r.status)
    return r
  }

  it('answers the screens past the last, L2 only, with no map notes and no Layer 1', () => {
    const r = ok(beyondResult(map(2), 2))
    expect(r.screen).toBe(2)
    expect([r.planes.l1Low, r.planes.l1High, r.planes.l3Low]).toEqual([null, null, null])
    expect(r.planes.l2Low).not.toBeNull()
  })

  it('carries the map notes and refused cells on its own screens only, not on a gutter screen', () => {
    const noisy = map(2, false, {
      unverified: ['dispatch note'],
      orderNote: 'mode 2',
      routeNote: 'no route',
      refusedCells: [{ x: 1, y: 1, objectIndex: 0, objectType: 'x', handler: 1, reasons: ['r'] }],
    })
    const own = ok(screenResult(noisy, 1))
    expect([own.note, own.refusedCells, own.layerNotes.length > 0]).toEqual([expect.any(String), expect.any(Array), true]) // prettier-ignore
    const r = ok(beyondResult(noisy, 2))
    expect([r.note, r.refusedCells, r.layerNotes]).toEqual([undefined, undefined, []])
  })

  it('draws Layer 3 past the end when the map has one, and keeps the map stacking', () => {
    const r = ok(beyondResult(map(2, false, { l3: l3Verdict() }), 2))
    expect(r.planes.l3Low).not.toBeNull() // column 0 repeats every 512 px: screen 2 shows it
    expect(ok(beyondResult(map(2, false, { l3: l3Verdict() }), 3)).planes.l3Low).toBeNull()
    expect(r.screens).toEqual({ main: ['l2Low', 'l3Low'], sub: [] })
  })

  it('draws with the switches that are on: a tile hidden until the blue switch is on', () => {
    const hidden = nullGrid(32, 32)
    hidden[0]![0] = 2 // tile 2 is blank until blue is on
    const m: MapInputs = { ...map(2), l2: { ok: true, l2: { ...l2, plane: hidden } } }
    const off = { blue: false, silver: false, onOff: false }
    expect(ok(beyondResult(m, 2, off)).planes.l2Low).toBeNull()
    expect(ok(beyondResult(m, 2, { ...off, blue: true })).planes.l2Low).not.toBeNull()
  })

  it('refuses every screen but the 33 past the last, for 1, 2 and 31 screens, and any non-integer', () => {
    for (const n of [1, 2, 31]) {
      for (let s = -3; s < n + MAX_BEYOND_SCREENS + 3; s++) {
        const inRange = s >= n && s < n + MAX_BEYOND_SCREENS
        expect(beyondResult(map(n), s).status, `${n} screens, screen ${s}`).toBe(inRange ? 'ok' : 'unavailable') // prettier-ignore
      }
      for (const s of [n + 0.5, n + 2.5, NaN, Infinity]) {
        expect(beyondResult(map(n), s).status, `${n} screens, screen ${s}`).toBe('unavailable')
      }
    }
  })

  it('the map own range check is unchanged: the first screen past the end is still refused', () => {
    expect(screenResult(map(2), 2).status).toBe('unavailable')
    expect(screenResult(map(2), 1).status).toBe('ok')
  })

  it('a vertical map answers with L2 and no Layer 3', () => {
    const r = ok(beyondResult(map(2, true), 2))
    expect([r.planes.l3Low, r.planes.l3High]).toEqual([null, null])
  })

  it('mapBeyond reads the cached model and passes the switches: not mapScreen, which refuses a screen past the end', () => {
    const cache = { get: () => ({ ok: true as const, inputs: map(2) }) } as unknown as L1ModelCache
    const hidden = nullGrid(32, 32)
    hidden[0]![0] = 2
    const m = { ...map(2), l2: { ok: true as const, l2: { ...l2, plane: hidden } } }
    const swCache = { get: () => ({ ok: true as const, inputs: m }) } as unknown as L1ModelCache
    const on = { blue: true, silver: false, onOff: false }
    expect(ok(mapBeyond(cache, new Uint8Array(), 'x.sfc', 5, 2, UNCLEARED)).screen).toBe(2)
    expect(mapBeyond(cache, new Uint8Array(), 'x.sfc', 5, 1, UNCLEARED).status).toBe('unavailable')
    expect(ok(mapBeyond(swCache, new Uint8Array(), 'x.sfc', 5, 2, UNCLEARED, on)).planes.l2Low).not.toBeNull() // prettier-ignore
    const refused = {
      get: () => ({ ok: false as const, reason: 'cannot read.' }),
    } as unknown as L1ModelCache
    expect(mapBeyond(refused, new Uint8Array(), 'x.sfc', 5, 2, UNCLEARED)).toMatchObject({ status: 'unavailable', reason: 'Cannot read.' }) // prettier-ignore
  })

  it('the server answers mapBeyond from mapBeyond, not mapScreen (project-server.ts cannot load in CI, so its text is checked)', () => {
    const src = readFileSync(resolve(__dirname, '../../../theia/extension/src/node/project-server.ts'), 'utf8') // prettier-ignore
    const body = /async mapBeyond\([\s\S]*?\r?\n {2}}\r?\n/.exec(src)?.[0] ?? ''
    expect(body).toMatch(/return mapBeyond\(this\.screens, r\.working\.bytes\(\)/)
    expect(body).not.toMatch(/mapScreen\(/)
    expect(body).toMatch(/switches\)/)
  })
})

describe('fadeFarEnd', () => {
  const rgba = (w: number, h: number) => new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : 7)) // prettier-ignore
  const row = (b: Uint8ClampedArray, w: number, y = 0) => Array.from({ length: w }, (_, x) => b[(y * w + x) * 4 + 3]!) // prettier-ignore

  it('is opaque across a content band, then falls linearly to clear over the last gutter px', () => {
    const [band, g] = [32, farGutter(5)]
    const w = band + g
    const b = rgba(w, 2)
    fadeFarEnd(b, w, 2, false, g)
    const a = row(b, w)
    expect(a.slice(0, band).every(v => v === 255)).toBe(true) // the band is solid
    expect(a[band]).toBe(255) // the first faded pixel is half a pixel in: still rounds to opaque
    expect(a[band + 1]).toBe(254) // one pixel in, a hair clear
    expect(a[band + g / 2]).toBe(127) // halfway
    expect(a[w - 1]).toBeLessThanOrEqual(1) // the center of the last pixel is half a pixel from clear
    for (let x = band + 1; x < w; x++) expect(a[x]).toBeLessThanOrEqual(a[x - 1]!)
    expect(b[0]).toBe(7) // color untouched, alpha only
  })

  it('a vertical map fades down the rows, the same on every column', () => {
    const [w, h, g] = [3, 256 + 16, 256]
    const b = rgba(w, h)
    fadeFarEnd(b, w, h, true, g)
    const col = (x: number) => Array.from({ length: h }, (_, y) => b[(y * w + x) * 4 + 3]!)
    expect(col(0)).toEqual(col(2))
    expect(
      col(0)
        .slice(0, 16)
        .every(v => v === 255),
    ).toBe(true)
    expect(col(0)[h - 1]).toBeLessThan(2)
  })

  it('scales alpha it finds, so a half-clear pixel stays proportionally clear', () => {
    const b = rgba(256, 1).map((v, i) => (i % 4 === 3 ? 100 : v))
    fadeFarEnd(b, 256, 1, false, 256)
    expect(row(b, 256)[128]).toBe(50)
  })

  it('does nothing with no gutter (a 32-screen map)', () => {
    const b = rgba(8, 1)
    fadeFarEnd(b, 8, 1, false, farGutter(32))
    expect(row(b, 8).every(v => v === 255)).toBe(true)
  })

  it('starts the fade where the back area mask does, so the two cannot drift', () => {
    for (const g of [256, 128]) {
      const start = Number(/calc\(100% - (\d+)px\)/.exec(fadeMask(false, g))![1])
      expect(start).toBe(g)
      const w = 40 + g
      const b = rgba(w, 1)
      fadeFarEnd(b, w, 1, false, g)
      const a = row(b, w)
      expect(a[w - g - 1]).toBe(255)
      expect(a[w - g + 2]).toBeLessThan(255)
    }
  })
})

describe('composeGutter and clearUncovered', () => {
  const opaque = (n: number, rgb: [number, number, number]) => {
    const b = new Uint8ClampedArray(n * 4)
    for (let i = 0; i < n; i++) b.set([...rgb, 255], i * 4)
    return b
  }
  const shot = (planes: GutterShot['planes'], o: Partial<GutterShot> = {}): GutterShot => ({
    width: 4, height: 2, planes, lists: { main: ['l2Low', 'l3Low'], sub: [] }, math: null, ...o,
  }) // prettier-ignore
  const all = () => true
  const A = (b: Uint8ClampedArray) => Array.from({ length: b.length / 4 }, (_, i) => b[i * 4 + 3]!)

  it('composes the shown planes in the map stacking: Layer 3 over Layer 2', () => {
    const l3 = new Uint8ClampedArray(32)
    l3.set(opaque(2, [0, 0, 255]), 0) // the first two pixels
    const out = composeGutter(
      [shot({ l2Low: opaque(8, [0, 255, 0]), l3Low: l3 })],
      all,
      false,
      4,
      2,
      0,
    )
    expect([out.slice(0, 3), out.slice(8, 11)].map(a => Array.from(a))).toEqual([[0, 0, 255], [0, 255, 0]]) // prettier-ignore
  })

  it('a plane the toggles hide is left out: Layer 2 hidden shows Layer 3 alone, both hidden shows nothing', () => {
    const planes = { l2Low: opaque(8, [0, 255, 0]), l3Low: opaque(8, [0, 0, 255]) }
    const only = (k: string) => k === 'l3Low'
    expect(Array.from(composeGutter([shot(planes)], only, false, 4, 2, 0).slice(0, 3))).toEqual([0, 0, 255]) // prettier-ignore
    expect(A(composeGutter([shot(planes)], () => false, false, 4, 2, 0)).every(v => v === 0)).toBe(
      true,
    )
  })

  it('fades the far end of what it composed', () => {
    const out = composeGutter(
      [shot({ l2Low: opaque(8, [0, 255, 0]) }, { width: 4, height: 2 })],
      all,
      false,
      4,
      2,
      4,
    )
    const a = A(out).slice(0, 4)
    expect(a[0]).toBeGreaterThan(a[1]!)
    expect(a[3]).toBeLessThan(a[0]!)
    expect(a[3]).toBeLessThan(40)
  })

  it('clears a pixel only a plane outside both lists covers, instead of leaving opaque backdrop (planted: cgadsub 0, fixed 40)', () => {
    const planes = { l3Low: opaque(8, [9, 9, 9]) }
    const s = shot(planes, {
      lists: { main: ['l2Low'], sub: [] },
      math: { cgadsub: 0, fixed: [40, 40, 40] },
    })
    // composeScreen alone fills the black backdrop here (it is not the fixed color), so the clear is what keeps it transparent.
    expect(A(composeScreen({ width: 4, height: 2, planes: s.planes, lists: s.lists, math: s.math })).every(v => v === 255)).toBe(true) // prettier-ignore
    expect(A(composeGutter([s], all, false, 4, 2, 0)).every(v => v === 0)).toBe(true)
  })

  it('applies the map color math to the gutter layers, not a flat stack', () => {
    const planes = { l2Low: opaque(8, [0, 100, 0]) }
    const lists = { main: ['l2Low'] as const, sub: [] }
    const plain = composeGutter([shot(planes, { lists })], all, false, 4, 2, 0)
    const math = composeGutter([shot(planes, { lists, math: { cgadsub: 0x02, fixed: [80, 0, 0] } })], all, false, 4, 2, 0) // prettier-ignore
    expect(plain[0]).toBe(0)
    expect(math[0]).toBeGreaterThan(40) // the fixed color was added to Layer 2
    expect(math[3]).toBe(255)
  })

  it('lays the screens end to end: horizontal by columns, vertical by rows, a missing one clear', () => {
    const a = shot({ l2Low: opaque(8, [1, 2, 3]) })
    const b = shot({ l2Low: opaque(8, [4, 5, 6]) })
    const h = composeGutter([a, undefined, b], all, false, 12, 2, 0)
    expect([h[0], h[16], h[32]]).toEqual([1, 0, 4])
    const v = composeGutter([a, b], all, true, 4, 4, 0)
    expect([v[0], v[8 * 4]]).toEqual([1, 4])
  })

  it('clearUncovered looks only at the planes the lists name', () => {
    const out = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255])
    const named = new Uint8ClampedArray([0, 0, 0, 0, 9, 9, 9, 255])
    const stray = opaque(2, [7, 7, 7])
    clearUncovered(out, { l2Low: named, l3Low: stray }, { main: ['l2Low'], sub: [] })
    expect([out[3], out[7]]).toEqual([0, 255])
    clearUncovered(out, {}, { main: ['l2Low'], sub: [] })
    expect(out[7]).toBe(0)
  })
})

describe('beyondScreens', () => {
  it('asks for as many screens as fill the far pad, 33 at the most (a one-screen map, a sprite ending at x = 8208)', () => {
    expect([beyondScreens(0, 256), beyondScreens(256, 256), beyondScreens(257, 256), beyondScreens(288, 256)]).toEqual([0, 1, 2, 2]) // prettier-ignore
    expect(beyondScreens(8208 - 256 + 256, 256)).toBe(33)
    expect(beyondScreens(256 * 100, 256)).toBe(MAX_BEYOND_SCREENS)
    expect(MAX_BEYOND_SCREENS).toBe(33)
  })
})
