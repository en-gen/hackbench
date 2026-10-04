/**
 * The area tabs (en-gen/hackbench#364 part B): the window mapping, per-area tileset and
 * palette, the hub-only canvas, and the explorer's area rows. Synthetic first, no ROM; the
 * vanilla windows are checked against an independent crop of a half-1 render.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { SmwRom } from '../../../src/rom/SmwRom'
import { bgr555ToRgba } from '../../../src/rom/GraphicsDecoder'
import { deriveOverworldAreas } from '../../../src/rom/OverworldAreas'
import { OW_WINDOW_H, OW_WINDOW_W, cropWindow, halfPixel } from '../../../src/rom/OverworldWindow'
import {
  compositeOverworld,
  OW_HALF_H,
  OW_HALF_W,
  type OwLayerPixels,
} from '../../../src/rom/render/OverworldComposite'
import {
  decodeOverworld,
  decodeOverworldArea,
  decodeOverworldAreas,
  drawOverworldArea,
} from '../../../theia/extension/src/node/overworld-decode'
import { overworldRows, opensArea } from '../../../theia/extension/src/browser/map-explorer-areas'
import { SYNTHETIC_FPS, le24, syntheticOverworldRom } from '../support/syntheticOverworld'
import { composeDto } from '../support/overworldView'
import { VANILLA, freshRom, hasRom } from '../support/corpus'
import * as pin from '../support/overworld-pin.cjs'

const EDGES = { cameraX: -17, cameraY: -40 }
const area = (n: number, cam = { cameraX: 0, cameraY: 0 }) => ({ area: n, ...cam })

const encoded = (x: number, y: number): number[] => [
  x & 255,
  (x >> 8) | ((y >> 8) << 1),
  y & 255,
  255,
]

/** A half-1 layer whose pixel (x, y) encodes itself; priority marks cells with an odd column. */
function coordinateLayer(): OwLayerPixels {
  const rgba = new Uint8ClampedArray(OW_HALF_W * OW_HALF_H * 4)
  const prio = new Uint8Array((OW_HALF_W >> 3) * (OW_HALF_H >> 3))
  for (let y = 0; y < OW_HALF_H; y++)
    for (let x = 0; x < OW_HALF_W; x++) rgba.set(encoded(x, y), (y * OW_HALF_W + x) * 4)
  for (let c = 0; c < prio.length; c++) prio[c] = (c % (OW_HALF_W >> 3)) & 1
  return { rgba, prio }
}
const at = (l: OwLayerPixels, x: number, y: number): number[] => [
  ...l.rgba.subarray((y * OW_WINDOW_W + x) * 4, (y * OW_WINDOW_W + x) * 4 + 4),
]

describe('the area window mapping', () => {
  it('halfPixel wraps at 512 on both axes, for negative and large cameras', () => {
    expect(halfPixel(-17, -40, 0, 0)).toEqual([495, 472])
    expect(halfPixel(-17, -40, 17, 40)).toEqual([0, 0])
    expect(halfPixel(240, 296, 255, 223)).toEqual([495, 7])
    expect(halfPixel(-17, -40, 16, 39)).toEqual([511, 511])
  })

  it('a window crossing both edges reads X 495-511 and Y 472-511 at the wrapped positions', () => {
    const win = cropWindow(coordinateLayer(), EDGES.cameraX, EDGES.cameraY)
    expect(win.prioCell).toBe(1)
    for (let y = 0; y < OW_WINDOW_H; y++) {
      for (let x = 0; x < OW_WINDOW_W; x++) {
        const sx = (((x - 17) % 512) + 512) % 512
        const sy = (((y - 40) % 512) + 512) % 512
        expect(at(win, x, y), `view ${x},${y}`).toEqual(encoded(sx, sy))
        expect(win.prio[y * OW_WINDOW_W + x]).toBe((sx >> 3) & 1)
      }
    }
    expect(at(win, 0, 0)).toEqual(encoded(495, 472))
    expect(at(win, 16, 39)).toEqual(encoded(511, 511))
    expect(at(win, 17, 40)).toEqual(encoded(0, 0))
  })

  it('an area view paints the half-1 pixels at the wrapped coordinates (synthetic ROM)', () => {
    const rom = syntheticOverworldRom([0x12, 0x13])
    const half = drawOverworldArea(new SmwRom(rom), 1, 1, SYNTHETIC_FPS)
    if ('reason' in half) throw new Error(half.reason)
    const full = Buffer.from(
      compositeOverworld(OW_HALF_W, OW_HALF_H, half.backdrop, half.layers.l2, half.layers.l1)
        .buffer,
    )
    const dto = decodeOverworldArea(new SmwRom(rom), area(1, EDGES), SYNTHETIC_FPS)
    if (dto.status !== 'ok') throw new Error(dto.reason)
    expect([dto.width, dto.height]).toEqual([256, 224])
    const win = composeDto(dto)
    const band = new Set<string>()
    for (let y = 0; y < OW_WINDOW_H; y++) {
      for (let x = 0; x < OW_WINDOW_W; x++) {
        const [sx, sy] = halfPixel(EDGES.cameraX, EDGES.cameraY, x, y)
        const want = full.subarray((sy * OW_HALF_W + sx) * 4, (sy * OW_HALF_W + sx) * 4 + 4)
        const got = win.subarray((y * OW_WINDOW_W + x) * 4, (y * OW_WINDOW_W + x) * 4 + 4)
        expect(Buffer.compare(got, want), `view ${x},${y}`).toBe(0)
        if (x < 17 || y < 40) band.add(Buffer.from(got).toString('hex'))
      }
    }
    // The wrapped band holds several colors, so a clamped or unwrapped read could not match it.
    expect(band.size).toBeGreaterThan(2)
  })
})

describe('each area draws with its own tileset and palette', () => {
  /** The synthetic ROM paints tileset t as file t: solid color (t % 7) + 1, palette block (t & 15) - 1. */
  const solid = (t: number, row: number): number[] => {
    const k = (row - 4) * 7 + (t % 7)
    return [...bgr555ToRgba((t & 0x0f) | ((k + 1) << 5))]
  }

  it('two areas with different DATA_04DC02 bytes render the same half-1 tile differently', () => {
    const rom = syntheticOverworldRom([0x12, 0x13, 0x15])
    const pixel = (n: number): number[] => {
      const dto = decodeOverworldArea(new SmwRom(rom), area(n), SYNTHETIC_FPS)
      const out = composeDto(dto, { l1: true, l2: false })
      return [...out.subarray((2 * OW_WINDOW_W + 2) * 4, (2 * OW_WINDOW_W + 2) * 4 + 4)]
    }
    expect(pixel(1)).not.toEqual(pixel(2))
    // Half 1 cell (0, 0) is tile 1 (tileAt offsets half 1 by one): palette row 4 + 1.
    expect(pixel(1)).toEqual(solid(0x13, 5))
    expect(pixel(2)).toEqual(solid(0x15, 5))
  })

  it('a tileset read the ROM does not hold refuses that area, with no fallback tileset', () => {
    const rom = syntheticOverworldRom([0x12, 0x13])
    // Entry i is at base + i: base $04FFFF keeps area 0 in the bank and puts area 1 at $050000.
    rom.writeAt(0x04dc16, le24(0x04ffff))
    rom.writeAt(0x04ffff, [0x12])
    expect(decodeOverworldArea(new SmwRom(rom), area(0), SYNTHETIC_FPS).status).toBe('ok')
    const refused = decodeOverworldArea(new SmwRom(rom), area(1), SYNTHETIC_FPS)
    expect(refused).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(/Area 1's object tileset at \$050000 is not in the ROM/),
    })
  })

  it('a tileset with no palette slot refuses that area only', () => {
    const rom = syntheticOverworldRom([0x12, 0x10])
    expect(decodeOverworldArea(new SmwRom(rom), area(0), SYNTHETIC_FPS).status).toBe('ok')
    expect(decodeOverworldArea(new SmwRom(rom), area(1), SYNTHETIC_FPS)).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(/names no overworld palette/),
    })
  })
})

describe('the hub view', () => {
  it('is one 512x512 canvas: half 0 only, no half 1', () => {
    const dto = decodeOverworld(new SmwRom(syntheticOverworldRom()), SYNTHETIC_FPS)
    if (dto.status !== 'ok') throw new Error(dto.reason)
    expect([dto.width, dto.height, dto.prioCell]).toEqual([512, 512, 8])
    expect(Buffer.from(dto.l1.rgbaBase64, 'base64').length).toBe(512 * 512 * 4)
    expect(dto).not.toHaveProperty('halves')
  })
})

describe('the explorer rows', () => {
  it('an invalid area keeps its row, carries its reason and opens nothing', () => {
    const { areas, note } = overworldRows({
      status: 'ok',
      areas: [{ area: 1 }, { area: 9, invalid: 'warp record 4 leads to area 9, past the table' }],
    })
    expect(note).toBeUndefined()
    expect(areas.map(a => a.name)).toEqual(['Area 1', 'Area 9'])
    expect(areas.map(opensArea)).toEqual([true, false])
    expect(areas[1]!.invalid).toMatch(/warp record 4/)
  })

  it('a refused derivation gives no children and a reason on the Overworld row', () => {
    const r = overworldRows({ status: 'unavailable', reason: 'the camera read is not stock' })
    expect(r.areas).toEqual([])
    expect(r.note).toBe('Areas unavailable: the camera read is not stock')
    expect(overworldRows(undefined, 'rpc down').note).toMatch(/rpc down/)
  })

  it('the backend refuses with a reason on a ROM without the area routines', () => {
    const dto = decodeOverworldAreas(new SmwRom(syntheticOverworldRom()))
    expect(dto).toEqual({ status: 'unavailable', reason: expect.stringMatching(/not stock/) })
  })
})

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe.skipIf(!hasRom(VANILLA))('vanilla area windows', () => {
  const cameras = (): { area: number; cameraX: number; cameraY: number }[] => {
    const s = deriveOverworldAreas(freshRom())
    if ('unavailable' in s) throw new Error(s.unavailable)
    return s.areas.filter(a => a.area > 0) as never
  }

  it('lists areas 1-6 with the camera positions the tables hold', () => {
    expect(cameras().map(a => [a.area, a.cameraX, a.cameraY])).toEqual([
      [1, -17, -40],
      [2, -17, 128],
      [3, -17, 296],
      [4, 240, -40],
      [5, 240, 128],
      [6, 240, 296],
    ])
  })

  it.each([1, 2, 3, 4, 5, 6])('area %i equals the crop of a half-1 render in its tileset', n => {
    const a = cameras().find(x => x.area === n)!
    const half = drawOverworldArea(new SmwRom(freshRom()), n, 1, {})
    if ('reason' in half) throw new Error(half.reason)
    const full = compositeOverworld(
      OW_HALF_W,
      OW_HALF_H,
      half.backdrop,
      half.layers.l2,
      half.layers.l1,
    )
    const dto = decodeOverworldArea(new SmwRom(freshRom()), a)
    const fullBuf = Buffer.from(full.buffer)
    const want = Buffer.alloc(OW_WINDOW_W * OW_WINDOW_H * 4)
    for (let y = 0; y < OW_WINDOW_H; y++)
      for (let x = 0; x < OW_WINDOW_W; x++) {
        const [sx, sy] = halfPixel(a.cameraX, a.cameraY, x, y)
        fullBuf.copy(want, (y * OW_WINDOW_W + x) * 4, (sy * 512 + sx) * 4, (sy * 512 + sx) * 4 + 4)
      }
    expect(Buffer.compare(composeDto(dto), want)).toBe(0)
    const keys = ['BOTH', 'L1', 'L2'] as const
    const got = keys.map(k => sha(composeDto(dto, { l1: k !== 'L2', l2: k !== 'L1' })))
    expect(got).toEqual(keys.map(k => pin.VANILLA_OVERWORLD_AREA_SHA256[n]?.[k] ?? 'unpinned'))
  })
})
