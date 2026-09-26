/**
 * src/rom/render/TileResolver.ts: the core's single 8x8 pixel resolver,
 * moved from tools/scripts/capture_draw.ts (#421 step 2). These pin the
 * exact bit layout and plane arithmetic with hand-computed expected values,
 * so a planted defect - a flipped flip bit, a wrong color-row shift, or a
 * wrong plane order - turns a concrete assertion red rather than only a
 * pixel-diff against a capture (CI has no captures).
 */
import { describe, expect, it } from 'vitest'
import {
  bgr555,
  charPixel,
  composeTile,
  decodeWord,
  palette,
  resolveTilePixel,
  type CharSource,
} from '../../../src/rom/render/TileResolver'

describe('decodeWord', () => {
  it('reads char (bits 0-9), pal (10-12), prio (13), flipX (14), flipY (15)', () => {
    const word = 0x3ff | (5 << 10) | (1 << 13) | (1 << 14) | (0 << 15)
    expect(decodeWord(word)).toEqual({ char: 0x3ff, pal: 5, prio: 1, flipX: 1, flipY: 0 })
  })

  it('decodes an all-zero word to every field off', () => {
    expect(decodeWord(0)).toEqual({ char: 0, pal: 0, prio: 0, flipX: 0, flipY: 0 })
  })

  it('keeps each field independent: flipping one bit does not disturb its neighbors', () => {
    // A wrong shift/mask on any field would leak into an adjacent one here.
    expect(decodeWord(1 << 13)).toEqual({ char: 0, pal: 0, prio: 1, flipX: 0, flipY: 0 })
    expect(decodeWord(1 << 14)).toEqual({ char: 0, pal: 0, prio: 0, flipX: 1, flipY: 0 })
    expect(decodeWord(1 << 15)).toEqual({ char: 0, pal: 0, prio: 0, flipX: 0, flipY: 1 })
  })
})

describe('charPixel', () => {
  // A 4bpp char at baseWord 0, char 1 (byte offset 32): plane bytes hand-set
  // so pixel (x=0, y=0) is bit 7 of each plane byte, value 1+2+4+8=15; pixel
  // (x=7, y=0) is bit 0, value 0. Planes must be read low0/low1/high0/high1
  // in that order (a swapped plane order would give a different value).
  it('decodes a 4bpp pixel from all four bit planes in the documented order', () => {
    const vram = new Uint8Array(0x10000)
    const a = 32 // baseWord(0)*2 + ch(1)*bpp(4)*8
    vram[a] = 0x80 // low plane 0, bit 0 of the 2bpp pair
    vram[a + 1] = 0x80 // low plane 1, bit 1
    vram[a + 16] = 0x80 // high plane 0, bit 2
    vram[a + 17] = 0x80 // high plane 1, bit 3
    expect(charPixel(vram, 0, 4, 1, 0, 0)).toBe(15)
    expect(charPixel(vram, 0, 4, 1, 7, 0)).toBe(0)
  })

  it('stops at 2 planes for a 2bpp char, ignoring the high-plane bytes', () => {
    const vram = new Uint8Array(0x10000)
    const a = 16 // baseWord(0)*2 + ch(1)*bpp(2)*8
    vram[a] = 0x80
    vram[a + 1] = 0x80
    vram[a + 16] = 0x80 // would contribute bits 2/3 for 4bpp; must be ignored at bpp=2
    expect(charPixel(vram, 0, 2, 1, 0, 0)).toBe(3)
  })

  it('reads row y from byte offset y*2 within the char, honoring baseWord', () => {
    const vram = new Uint8Array(0x10000)
    const base = 100
    const a = (base * 2 + 3 * 4 * 8) & 0xffff
    vram[a + 5 * 2] = 0x01 // row 5, low plane 0, rightmost pixel (x=7 -> bit 0)
    expect(charPixel(vram, base, 4, 3, 7, 5)).toBe(1)
    expect(charPixel(vram, base, 4, 3, 6, 5)).toBe(0)
  })
})

describe('resolveTilePixel / composeTile', () => {
  // A char source where (ch, x, y) -> x*10 + y, so an X/Y swap or a wrong
  // flip axis reads a different, distinguishable value at the same (x, y).
  const source: CharSource = (_ch, x, y) => x * 10 + y

  // (3, 2): unflipped reads char-space (3, 2) = 32; flipX mirrors x only,
  // reading (4, 2) = 42; flipY mirrors y only, reading (3, 5) = 35. A
  // swapped flip axis would land on the other one's answer.
  it.each([
    ['unflipped', 0, 0, 32],
    ['flipX only', 1, 0, 42],
    ['flipY only', 0, 1, 35],
  ] as const)('%s: (3, 2) reads %j', (_name, flipX, flipY, expected) => {
    expect(resolveTilePixel({ char: 7, flipX, flipY }, source, 3, 2)).toBe(expected)
  })

  it('composeTile calls put(x, y, v) for every non-zero pixel, skipping v === 0', () => {
    // Char source is 0 only at (0, 0); every other of the 64 cells is non-zero.
    const zeroAtOrigin: CharSource = (_ch, x, y) => (x === 0 && y === 0 ? 0 : x * 10 + y + 1)
    const seen: Array<[number, number, number]> = []
    composeTile({ char: 0, flipX: 0, flipY: 0 }, zeroAtOrigin, (x, y, v) => seen.push([x, y, v]))
    expect(seen.length).toBe(63)
    expect(seen.find(([x, y]) => x === 0 && y === 0)).toBeUndefined()
    expect(seen.find(([x, y]) => x === 3 && y === 2)).toEqual([3, 2, 33])
  })

  it('draws every index 1-15 at least once and never draws index 0', () => {
    // The RAMP shape used elsewhere (index = (y*8+x)%16): every value 0-15
    // appears at least once in one 8x8 tile, 0 exactly at (0, 0) and (8, 0)
    // [out of range] - i.e. (0, 0) only, within bounds.
    const ramp: CharSource = (_ch, x, y) => (y * 8 + x) % 16
    const drawn = new Set<number>()
    composeTile({ char: 0, flipX: 0, flipY: 0 }, ramp, (_x, _y, v) => drawn.add(v))
    for (let v = 1; v <= 15; v++) expect(drawn.has(v), `index ${v} drawn`).toBe(true)
    expect(drawn.has(0)).toBe(false)
  })

  it('composeTile honors flips the same way resolveTilePixel does, tile-wide', () => {
    const seen = new Map<string, number>()
    composeTile({ char: 0, flipX: 1, flipY: 1 }, source, (x, y, v) => seen.set(`${x},${y}`, v))
    // (3, 2) flipped both ways reads char-space (4, 5): 4*10+5 = 45.
    expect(seen.get('3,2')).toBe(45)
  })
})

describe('bgr555 / palette', () => {
  it('widens each 5-bit BGR channel to 8 bits (val<<3 | val>>2)', () => {
    // R=31 G=0 B=0 -> word bit0-4 set
    const cgram = new Uint8Array(4)
    cgram[0] = 0x1f
    cgram[1] = 0x00
    expect(bgr555(cgram, 0)).toEqual([255, 0, 0])
    // R=0 G=31 B=0
    cgram[0] = 0xe0
    cgram[1] = 0x03
    expect(bgr555(cgram, 0)).toEqual([0, 255, 0])
    // R=0 G=0 B=31
    cgram[0] = 0x00
    cgram[1] = 0x7c
    expect(bgr555(cgram, 0)).toEqual([0, 0, 255])
  })

  it('builds all 256 colors at 3 bytes each, in index order', () => {
    const cgram = new Uint8Array(512)
    cgram[2] = 0x1f // color 1, pure red
    const p = palette(cgram)
    expect(p.length).toBe(768)
    expect([p[0], p[1], p[2]]).toEqual([0, 0, 0]) // color 0, all-zero word
    expect([p[3], p[4], p[5]]).toEqual([255, 0, 0]) // color 1
  })
})
