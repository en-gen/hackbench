/**
 * MarioGraphics (#980): the 3bpp to 4bpp expansion of CODE_00B8AD and the slot a sprite's graphics routine
 * points Mario's tile DMA at. Synthetic bytes only, so CI needs no cart.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { decode4bpp } from '../../../src/rom/GraphicsDecoder'
import { dynamicChars, expandTo4bpp, MARIO_GFX_BASE } from '../../../src/rom/MarioGraphics'

const seq = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)

describe('expandTo4bpp', () => {
  // Two 3bpp tiles, bytes 1-24 and 25-48 (16 plane-0/1 bytes, then 8 plane-2 bytes); expanded in place,
  // ending at the last word of a 64-byte area that overlaps the source, as the cart does.
  const run = () => {
    const buf = new Uint8Array(0x60)
    buf.set(seq(1, 48))
    return { buf, why: expandTo4bpp(buf, 47, 0x5e) }
  }
  const tile = (n: number) => [...seq(n, 16), ...seq(n + 16, 8).flatMap(b => [b, 0])]

  it('puts each plane-2 byte in the low byte of its row word, with a zero plane 3', () => {
    const { buf, why } = run()
    expect(why).toBeNull()
    expect([...buf.subarray(0x20, 0x40)]).toEqual(tile(1))
    expect([...buf.subarray(0x40, 0x60)]).toEqual(tile(25))
  })

  it('refuses operands that put the expansion outside the buffer', () => {
    expect(expandTo4bpp(new Uint8Array(0x60), 47, 0x5f)).toMatch(/outside/)
    expect(expandTo4bpp(new Uint8Array(0x60), 0x60, 0x5e)).toMatch(/outside/)
  })
})

describe('dynamicChars', () => {
  // CODE_01E198: LDA #$01 / JSR / REP #$20 / LDA #$0008 / ASL x5 / CLC / ADC #base / STA slotA / CLC / ADC #step / STA slotB / SEP #$20 / RTS
  const routine = (base: number, step: number, slotA: number, slotB: number) => [
    0xa9, 0x01, 0x20, 0x00, 0x90, 0xc2, 0x20, 0xa9, 0x08, 0x00, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x18, 0x69,
    base & 0xff, base >> 8, 0x8d, slotA & 0xff, slotA >> 8, 0x18, 0x69, step & 0xff, step >> 8, 0x8d,
    slotB & 0xff, slotB >> 8, 0xe2, 0x20, 0x60,
  ] // prettier-ignore
  const romWith = (code: number[], copies = 1) => {
    const b = new Uint8Array(0x20000)
    for (let i = 0; i < copies; i++) b.set(code, 0x100 + i * 0x100)
    return RomFile.fromBytes('synthetic.sfc', b)
  }
  // Every byte of $7E:8600-$89FF is its own address's low byte plus 1, so a piece is recognisable by where it came from.
  const buffer = () => {
    const bytes = new Uint8Array(0xb000 - MARIO_GFX_BASE)
    for (let a = 0x8600; a < 0x8a00; a++) bytes[a - MARIO_GFX_BASE] = ((a >> 5) & 0xff) | 1
    return { ok: true as const, bytes }
  }
  const pixels = (a: number, i: number) => decode4bpp(buffer().bytes, a - MARIO_GFX_BASE + i * 32)

  it('lands slot 3 of both rows on chars 6, 7 and $16, $17, from the base and the base plus the step', () => {
    const d = dynamicChars(romWith(routine(0x8500, 0x200, 0x0d8b, 0x0d95)), 0x33, buffer())
    expect(d?.ok && [...d.chars.keys()].sort((a, b) => a - b)).toEqual([0x406, 0x407, 0x416, 0x417])
    if (!d?.ok) return
    expect(d.chars.get(0x406)).toEqual(pixels(0x8600, 0))
    expect(d.chars.get(0x407)).toEqual(pixels(0x8600, 1))
    expect(d.chars.get(0x416)).toEqual(pixels(0x8800, 0))
    expect(d.chars.get(0x417)).toEqual(pixels(0x8800, 1))
  })

  it('follows the slot the routine names, not slot 3', () => {
    const d = dynamicChars(romWith(routine(0x8500, 0x200, 0x0d89, 0x0d93)), 0x33, buffer())
    expect(d?.ok && [...d.chars.keys()].sort((a, b) => a - b)).toEqual([0x404, 0x405, 0x414, 0x415])
  })

  it('gives no chars to a sprite without an upload, and a reason when the routine is not the stock one', () => {
    expect(dynamicChars(romWith(routine(0x8500, 0x200, 0x0d8b, 0x0d95)), 0x10, buffer())).toBeNull()
    expect(dynamicChars(romWith([0xea, 0xea]), 0x33, buffer())).toMatchObject({ ok: false })
    expect(dynamicChars(romWith(routine(0x8500, 0x200, 0x0d8b, 0x0d95), 2), 0x33, buffer())).toMatchObject({ ok: false }) // prettier-ignore
  })

  it('refuses a slot outside the two rows and a source outside the buffer', () => {
    expect(dynamicChars(romWith(routine(0x8500, 0x200, 0x0e00, 0x0d95)), 0x33, buffer())).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) }) // prettier-ignore
    expect(dynamicChars(romWith(routine(0xf000, 0x200, 0x0d8b, 0x0d95)), 0x33, buffer())).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) }) // prettier-ignore
  })
})
