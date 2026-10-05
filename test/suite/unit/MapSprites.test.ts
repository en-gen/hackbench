/**
 * The map tab's sprite layer (#564): `drawSprites` places the table engine's
 * parts at the sprite's anchor and marks what the engine declines;
 * `compositeSpriteScreen` cuts the sprites per screen. Synthetic chars,
 * palette and engine results throughout, so CI needs no cart; the corpus
 * block at the end runs the real engine over a vanilla map.
 */
import { describe, it, expect } from 'vitest'
import type { EngineResult } from '../../../src/rom/model/sprites/generic/SpriteDrawEngine'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { drawSprites, mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { compositeSpriteScreen } from '../../../theia/extension/src/browser/map-view-model'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { COLORS, px } from '../support/mapInputs'

/** Char $400 is color 1 on its left half and color 2 on its right; char $401 is solid color 3. */
const SP1 = [0, 1].map(i => {
  const c = new Uint8Array(64)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) c[y * 8 + x] = i === 0 ? (x < 4 ? 1 : 2) : 3 // prettier-ignore
  return c
})
const MODEL = { vram: { sp1: SP1 }, colors: COLORS }
const spr = (index: number, x: number, y: number, spriteId = 0x10): LevelSprite =>
  ({ index, x, y, spriteId, screen: 0, extraBit: false, raw: [], streamOffset: 0 }) as LevelSprite
const part = (charNum: number, dx: number, dy: number, flipX = false) => ({ charNum, palette: 9, flipX, flipY: false, dx, dy }) // prettier-ignore
const ok = (...parts: ReturnType<typeof part>[]): EngineResult => ({ ok: true, parts, identity: { spriteId: 0x10, mainHandler: 0, initHandler: 0, status: 'vanilla' } }) // prettier-ignore
const decode = (d: MapSpriteDto) => new Uint8ClampedArray(Buffer.from(d.rgba, 'base64'))
const sized = (d: MapSpriteDto) => [d.box.x1 - d.box.x0, d.box.y1 - d.box.y0] as const

describe('drawSprites', () => {
  it('draws an engine miss as a 16x16 marker at the anchor, with the failure as its reason', () => {
    const miss = (id: number): EngineResult => ({ ok: false, failure: { kind: 'noDescriptor', spriteId: id } }) // prettier-ignore
    const [a, b] = drawSprites([spr(0, 3, 2, 0x1a), spr(1, 3, 2, 0x2b)], MODEL, s => miss(s.spriteId)) // prettier-ignore
    expect(a).toMatchObject({ status: 'placeholder', reason: 'noDescriptor', id: 0x1a, x: 48, y: 32 }) // prettier-ignore
    expect(a!.box).toEqual({ x0: 48, y0: 32, x1: 64, y1: 48 })
    const [pa, pb] = [decode(a!), decode(b!)]
    expect(pa.length).toBe(16 * 16 * 4)
    expect(pa.some((v, i) => i % 4 === 3 && v === 255)).toBe(true)
    // The hex digits differ, so the id is on the marker.
    expect(Buffer.from(pa).equals(Buffer.from(pb))).toBe(false)
  })

  it('places each part at anchor + dx/dy, negative and off the 16 px grid, never snapped', () => {
    const [s] = drawSprites([spr(0, 2, 2)], MODEL, () => ok(part(0x401, -3, 5), part(0x401, 13, -9))) // prettier-ignore
    expect(s).toMatchObject({ status: 'drawn', x: 32, y: 32 })
    expect(s!.box).toEqual({ x0: 29, y0: 23, x1: 53, y1: 45 })
    const bmp = decode(s!)
    const [w] = sized(s!)
    const solid = [9 * 16 + 3, 100, 200, 255]
    // Part 1 starts at (29, 37), part 2 at (45, 23); both solid color 3 of row 9.
    expect(px(bmp, w, 0, 14)).toEqual(solid)
    expect(px(bmp, w, 7, 21)).toEqual(solid)
    expect(px(bmp, w, 8, 14)[3]).toBe(0)
    expect(px(bmp, w, 16, 0)).toEqual(solid)
    expect(px(bmp, w, 23, 7)[3]).toBe(255)
    expect(px(bmp, w, 15, 0)[3]).toBe(0)
  })

  it('flips a part and leaves color index 0 clear', () => {
    const [s] = drawSprites([spr(0, 0, 0)], MODEL, () => ok(part(0x400, 0, 0, true)))
    const bmp = decode(s!)
    expect(px(bmp, 8, 0, 0)[0]).toBe(9 * 16 + 2)
    expect(px(bmp, 8, 7, 0)[0]).toBe(9 * 16 + 1)
  })

  it('marks a sprite whose chars are not in this level, rather than drawing garbage', () => {
    const [s] = drawSprites([spr(0, 0, 0)], MODEL, () => ok(part(0x401, 0, 0), part(0x5ff, 8, 0)))
    expect(s).toMatchObject({ status: 'placeholder', reason: 'charsNotLoaded' })
    expect(sized(s!)).toEqual([16, 16])
  })

  it('takes the anchor from the parsed tile position as is (the parser already swapped vertical X and Y)', () => {
    const [s] = drawSprites([spr(0, 20, 37)], MODEL, () => ok(part(0x401, 0, 0)))
    expect(s).toMatchObject({ x: 320, y: 592 })
  })
})

describe('compositeSpriteScreen', () => {
  const solid = (x0: number, y0: number, w: number, h: number, color: number): MapSpriteDto =>
    ({ index: 0, id: 1, x: x0, y: y0, box: { x0, y0, x1: x0 + w, y1: y0 + h }, status: 'drawn', rgba: Buffer.from(new Uint8ClampedArray(w * h * 4).fill(color)).toString('base64') }) as MapSpriteDto // prettier-ignore
  const H = { orientation: 'horizontal' as const, width: 256, height: 432 }
  const V = { orientation: 'vertical' as const, width: 512, height: 256 }

  it('draws a sprite that straddles a screen edge into both screens, cut at the edge', () => {
    const s = solid(250, 10, 12, 4, 200)
    const left = compositeSpriteScreen([s], 0, H)!
    const right = compositeSpriteScreen([s], 1, H)!
    expect(px(left, 256, 249, 10)[3]).toBe(0)
    expect(px(left, 256, 250, 10)).toEqual([200, 200, 200, 200])
    expect(px(left, 256, 255, 13)[3]).toBe(200)
    expect(px(right, 256, 0, 10)[3]).toBe(200)
    expect(px(right, 256, 5, 13)[3]).toBe(200)
    expect(px(right, 256, 6, 10)[3]).toBe(0)
    expect(compositeSpriteScreen([s], 2, H)).toBeNull()
  })

  it('cuts a vertical map by rows, and clips what spills above the map', () => {
    const s = solid(100, 250, 8, 12, 90)
    expect(px(compositeSpriteScreen([s], 0, V)!, 512, 100, 255)[3]).toBe(90)
    expect(px(compositeSpriteScreen([s], 1, V)!, 512, 100, 5)[3]).toBe(90)
    expect(px(compositeSpriteScreen([s], 1, V)!, 512, 100, 6)[3]).toBe(0)
    const above = compositeSpriteScreen([solid(0, -4, 8, 8, 1)], 0, V)!
    expect(px(above, 512, 0, 3)[3]).toBe(1)
    expect(px(above, 512, 0, 4)[3]).toBe(0)
  })

  it('draws later columns over earlier ones on a horizontal map, later rows on a vertical one', () => {
    const [a, b] = [solid(10, 10, 8, 8, 10), solid(14, 10, 8, 8, 20)]
    expect(px(compositeSpriteScreen([b, a], 0, H)!, 256, 15, 12)[0]).toBe(20)
    const [c, d] = [solid(10, 10, 8, 8, 10), solid(10, 14, 8, 8, 20)]
    expect(px(compositeSpriteScreen([d, c], 0, V)!, 512, 12, 15)[0]).toBe(20)
  })

  it('returns null when nothing lands in the screen', () => {
    expect(compositeSpriteScreen([], 0, H)).toBeNull()
  })
})

describe.skipIf(!hasRom(VANILLA))('mapSprites on the vanilla ROM', () => {
  const none = { yellow: false, green: false, red: false, blue: false }
  const run = (index: number) => {
    const bytes = new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)
    const r = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), index, none)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    return r
  }

  it('draws the traced sprites of $106 and marks the rest, every one with a matching bitmap', () => {
    const r = run(0x106)
    expect(r.sprites).toHaveLength(25)
    const drawn = r.sprites.filter(s => s.status === 'drawn')
    expect(drawn.length).toBeGreaterThan(0)
    // Sprite $05 stands at tile row 20: its parts begin above the anchor, a 16 x 32 body.
    const koopa = drawn.find(s => s.id === 0x05)!
    expect(sized(koopa)).toEqual([16, 32])
    expect(koopa.box.y0).toBeLessThan(koopa.y)
    for (const s of r.sprites) {
      const [w, h] = sized(s)
      expect(decode(s).length).toBe(w * h * 4)
      if (s.status === 'placeholder') expect(s.reason).toBeTruthy()
    }
  })

  it('marks every sprite of $105: none of its ids has a descriptor', () => {
    const r = run(0x105)
    expect(r.sprites.length).toBeGreaterThan(0)
    expect(r.sprites.every(s => s.status === 'placeholder' && s.reason === 'noDescriptor')).toBe(true) // prettier-ignore
  })
})
