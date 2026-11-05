/**
 * Layers 2 and 3 through the far-end gutter (#1197). Everything is synthetic: made-up tiles, grids and
 * streams, no ROM. Covers the core split of a stream past the last screen, `drawL2Beyond` and
 * `beyondResult` in the node backend, and the pure fade and coverage helpers the view paints with.
 */
import { describe, it, expect, vi } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import type * as ExpanderMod from '../../../src/rom/ObjectExpander'
import { loadL2Objects, tilePresetGrid, L2_EMPTY_TILE } from '../../../src/rom/L2Loader'
import { MAX_BEYOND_SCREENS, farGutter } from '../../../src/rom/model/MapGutter'
import type { L2Inputs } from '../../../src/rom/model/L2Model'
import type { L3Inputs } from '../../../src/rom/L3Loader'
import {
  beyondResult,
  drawL2Beyond,
  drawL2Planes,
  drawL3Planes,
  screenResult,
  type MapInputs,
} from '../../../theia/extension/src/node/map-screen'
import {
  beyondScreens,
  clearUncovered,
  fadeFarEnd,
  fadeMask,
} from '../../../theia/extension/src/browser/off-map-extent'
import { COLORS, hGrid, inputs, px, sub, tile, vGrid } from '../support/mapInputs'

// A stand-in for the object handlers (which need real ROM tables): every object writes 4 tiles from its
// anchor, so a stream near the edge spills past it exactly as a real wide object would.
vi.mock('../../../src/rom/ObjectExpander', async importOriginal => {
  const real = await importOriginal<typeof ExpanderMod>()
  return {
    ...real,
    expandObject: (grid: number[][], obj: { x: number; y: number }) => {
      for (let i = 0; i < 4; i++) if (grid[obj.y]?.[obj.x + i] !== undefined) grid[obj.y]![obj.x + i] = 0x40 + i // prettier-ignore
    },
  }
})

const solid = tile(1, [sub(1), sub(1), sub(1), sub(1)])
const tiles = [undefined, solid]
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
    expect(wide.grid).toEqual(plain.grid)
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
  const map = (screens: number, vertical = false): MapInputs => ({
    ...inputs(vertical ? vGrid(screens) : hGrid(screens), vertical, screens),
    l2: { ok: true, l2 },
  })

  it('answers the screens past the last, L2 only, with no map notes and no Layer 1', () => {
    const r = beyondResult(map(2), 2)
    if (r.status !== 'ok') throw new Error(r.status)
    expect(r.screen).toBe(2)
    expect([r.planes.l1Low, r.planes.l1High, r.planes.l3Low]).toEqual([null, null, null])
    expect(r.planes.l2Low).not.toBeNull()
    expect([r.note, r.refusedCells, r.layerNotes]).toEqual([undefined, undefined, []])
  })

  it('refuses a screen inside the map, a non-integer, and one beyond the bound', () => {
    for (const s of [0, 1, 1.5, -1, 2 + MAX_BEYOND_SCREENS]) {
      expect(beyondResult(map(2), s).status, `screen ${s}`).toBe('unavailable')
    }
    expect(beyondResult(map(2), 2 + MAX_BEYOND_SCREENS - 1).status).toBe('ok')
  })

  it('mapScreen keeps its own range check: the first screen past the end is still refused', () => {
    expect(screenResult(map(2), 2).status).toBe('unavailable')
    expect(screenResult(map(2), 1).status).toBe('ok')
  })

  it('a vertical map answers with L2 and no Layer 3', () => {
    const r = beyondResult(map(2, true), 2)
    if (r.status !== 'ok') throw new Error(r.status)
    expect([r.planes.l3Low, r.planes.l3High]).toEqual([null, null])
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

describe('clearUncovered and beyondScreens', () => {
  it('clears alpha where no source covers, keeps it where one does', () => {
    const out = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255])
    const src = new Uint8ClampedArray([0, 0, 0, 0, 9, 9, 9, 255])
    clearUncovered(out, [src, null, undefined])
    expect([out[3], out[7]]).toEqual([0, 255])
  })

  it('with no shown source everything is clear', () => {
    const out = new Uint8ClampedArray([1, 2, 3, 255])
    clearUncovered(out, [])
    expect(out[3]).toBe(0)
  })

  it('asks for as many screens as fill the far pad, never more than the bound', () => {
    expect([beyondScreens(0, 256), beyondScreens(256, 256), beyondScreens(257, 256), beyondScreens(288, 256)]).toEqual([0, 1, 2, 2]) // prettier-ignore
    expect(beyondScreens(256 * 100, 256)).toBe(MAX_BEYOND_SCREENS)
  })
})
