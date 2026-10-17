/**
 * MarioGraphics (#980): the boot build of the player buffer, the 3bpp to 4bpp expansion of CODE_00B8AD, and the
 * slots a sprite's run pointed Mario's tile DMA at. Synthetic bytes only, so CI needs no cart: the boot routine
 * under test is a made-up one with the stock operand layout (`BootRoutine` is injectable), never the cart's code.
 */
import { describe, it, expect } from 'vitest'
import {
  base,
  boot,
  cart,
  GATE,
  routine,
  seq,
  type Cart,
  type Operands,
} from '../support/marioGraphicsFixture'
import { RomFile } from '../../../src/rom/RomFile'
import { decode4bpp } from '../../../src/rom/GraphicsDecoder'
import { encode } from '../../../src/rom/LcLz2'
import {
  bootFingerprint,
  buildMarioGraphics,
  charsFromUploads,
  DYN_GFX_TILE_PTR,
  expandTo4bpp,
  MARIO_GFX_BASE,
  uploadProbe,
} from '../../../src/rom/MarioGraphics'

const tile = (n: number) => [...seq(n, 16), ...seq(n + 16, 8).flatMap(b => [b, 0])]

describe('expandTo4bpp', () => {
  // Two 3bpp tiles, bytes 1-24 and 25-48 (16 plane-0/1 bytes, then 8 plane-2 bytes); expanded in place,
  // ending at the last word of a 64-byte area that overlaps the source, as the cart does.
  const run = () => {
    const buf = new Uint8Array(0x60)
    buf.set(seq(1, 48))
    return { buf, why: expandTo4bpp(buf, 47, 0x5e) }
  }

  it('puts each plane-2 byte in the low byte of its row word, with a zero plane 3', () => {
    const { buf, why } = run()
    expect(why).toBeNull()
    expect([...buf.subarray(0x20, 0x40)]).toEqual(tile(1))
    expect([...buf.subarray(0x40, 0x60)]).toEqual(tile(25))
  })

  it('stops after the first tile of the file, leaving the bytes between source and destination alone', () => {
    // Source apart from the destination, a sentinel around both: a loop that ends one tile early or late
    // misses a tile or writes 32 bytes below the destination.
    const [n, src, end] = [3, 0, 0x3fe]
    const buf = new Uint8Array(0x400).fill(0xab)
    const bytes = seq(1, 24 * n)
    buf.set(bytes, src)
    expect(expandTo4bpp(buf, src + 24 * n - 1, end)).toBeNull()
    const dest = end + 2 - 32 * n
    expect([...buf.subarray(dest)]).toEqual([0, 1, 2].flatMap(i => tile(1 + 24 * i)))
    expect([...buf.subarray(src, src + 24 * n)]).toEqual(bytes)
    expect(buf.subarray(src + 24 * n, dest).every(v => v === 0xab)).toBe(true)
  })

  it('refuses operands that put the expansion outside the buffer', () => {
    expect(expandTo4bpp(new Uint8Array(0x60), 47, 0x5f)).toMatch(/outside/)
    expect(expandTo4bpp(new Uint8Array(0x60), 0x60, 0x5e)).toMatch(/outside/)
    expect(expandTo4bpp(new Uint8Array(0x60), 47, 0)).toMatch(/outside/)
  })

  it('refuses a destination that runs out of buffer before the source does', () => {
    const buf = new Uint8Array(0x60)
    buf.set(seq(1, 48))
    expect(expandTo4bpp(buf, 47, 0x1e)).toMatch(/below/)
  })
})

describe('buildMarioGraphics', () => {
  const build = (o: Cart) => buildMarioGraphics(cart(o), GATE, boot())
  const bytesOf = (r: ReturnType<typeof buildMarioGraphics>) => (r.ok ? r.bytes : expect.fail(r.reason)) // prettier-ignore
  const at = (b: Uint8Array, a: number, n: number) => [...b.subarray(a - MARIO_GFX_BASE, a - MARIO_GFX_BASE + n)] // prettier-ignore
  const refused = (r: ReturnType<typeof buildMarioGraphics>, why: RegExp) => expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(why) }) // prettier-ignore

  it('expands GFX33 to the operand top, then writes GFX32 over the start of the buffer', () => {
    const b = bytesOf(build({}))
    expect(at(b, 0x2000, 16)).toEqual(Array(16).fill(0xee)) // GFX32, written last
    expect(at(b, 0x2010, 16)).toEqual(seq(17, 16)) // the 3bpp source, which GFX32 does not cover
    expect(at(b, 0x2020, 64)).toEqual([...tile(1), ...tile(25)])
    expect(at(b, 0x2060, 4)).toEqual([0, 0, 0, 0])
  })

  it('reads the file address, the expansion top and the source top from the routine, not from constants', () => {
    // GFX33 in another bank at another offset, 3 tiles, expanded higher up.
    const b = bytesOf(build({ d33: seq(1, 72), bank: 9, low: 0x9000, top: 0x207e, srcTop: 71 }))
    expect(at(b, 0x2000, 16)).toEqual(Array(16).fill(0xee))
    expect(at(b, 0x2080 - 96, 96)).toEqual([0, 1, 2].flatMap(i => tile(1 + 24 * i)))
    expect(at(b, 0x2080, 4)).toEqual([0, 0, 0, 0])
  })

  it('carries GFX32 into the next bank when GFX33 ends at the top of its own', () => {
    const c33 = encode(Uint8Array.from(seq(1, 48)))
    const low = 0x10000 - c33.length
    const bytes = new Uint8Array(0x80000)
    bytes.set(c33, base(8) + low - 0x8000)
    bytes.set(encode(Uint8Array.from(Array(16).fill(0xee))), base(9))
    bytes.set(routine({ at33: low, bank: 8, top: 0x205e, srcTop: 47, at32: 0x8000 }), 0x100)
    const b = bytesOf(buildMarioGraphics(RomFile.fromBytes('s.sfc', bytes), GATE, boot()))
    expect(at(b, 0x2000, 16)).toEqual(Array(16).fill(0xee))
  })

  it('refuses a boot routine found twice, absent, or changed in a byte the operands do not cover', () => {
    refused(build({ copies: 2 }), /not the stock one/)
    refused(build({ copies: 0 }), /not the stock one/)
    refused(build({ edit: c => { c[40] = 0x60 } }), /not the stock one/) // prettier-ignore
  })

  it('masks both bytes of every operand word, and only the operand bytes', () => {
    const fp = (o: Operands) => bootFingerprint(Uint8Array.from(routine(o)))
    // Every word has a nonzero high byte, so a mask that stops at the low byte of any of them changes the hash.
    expect(fp({ at33: 0xa123, bank: 0x4a, top: 0xab5e, srcTop: 0x5c3f, at32: 0xc9d7 })).toBe(
      boot().sha256,
    )
    // The bytes just outside each operand slot are part of the routine (opcodes), so they must change the hash.
    for (const i of [2, 5, 7, 9, 29, 32, 34, 37, 79, 82]) {
      const b = routine({ at33: 0, bank: 0, top: 0, srcTop: 0, at32: 0 })
      b[i] ^= 0x01
      expect(bootFingerprint(Uint8Array.from(b)), `byte ${i}`).not.toBe(boot().sha256)
    }
  })

  it("passes the decompressor gate's refusal on, after the routine matched", () => {
    expect(buildMarioGraphics(cart({}), { ok: false, reason: 'decompressor replaced' }, boot())).toEqual({ ok: false, reason: 'decompressor replaced' }) // prettier-ignore
  })

  it('refuses a GFX33 pointer that is not into the ROM half of its bank, though readAt can map it', () => {
    // $48:0000 reads file offset $48 * $8000 (LoROM mirrors the low half of a high bank), so the stream below is
    // readable there; only the `lo < $8000` guard refuses it. Deleting that guard makes this ok.
    const [c33, c32] = [
      encode(Uint8Array.from(seq(1, 48))),
      encode(Uint8Array.from(Array(16).fill(0xee))),
    ]
    const at = 0x48 * 0x8000
    const bytes = new Uint8Array(0x400000)
    bytes.set(c33, at)
    bytes.set(c32, at + c33.length)
    bytes.set(routine({ at33: 0, bank: 0x48, top: 0x205e, srcTop: 47, at32: c33.length }), 0x100)
    refused(buildMarioGraphics(RomFile.fromBytes('s.sfc', bytes), GATE, boot()), /GFX33/)
  })

  it('refuses a file that decompresses past the buffer, and an expansion that does not fit it', () => {
    const big = Array(0x9100).fill(7)
    refused(build({ d33: big }), /overruns/)
    refused(build({ d32: big }), /overruns/)
    refused(build({ top: 0xb000 }), /outside/)
  })
})

describe('uploadProbe', () => {
  const wram = (ptrs: Record<number, number>) => {
    const w = new Uint8Array(0x2000)
    for (const [slot, p] of Object.entries(ptrs)) {
      w[DYN_GFX_TILE_PTR + 2 * Number(slot)] = p & 0xff
      w[DYN_GFX_TILE_PTR + 2 * Number(slot) + 1] = p >> 8
    }
    return w
  }

  it('reports the slots a pass changed, with the pointer it left there, and no slot it left alone', () => {
    const { probe, byPass } = uploadProbe()
    probe(-1, wram({ 0: 0x2000, 3: 0x9999 }))
    probe(0, wram({ 0: 0x2000, 3: 0x8600, 8: 0x8800 }))
    probe(1, wram({ 0: 0x2000, 3: 0x8600, 8: 0x8a00, 9: 0x1234 }))
    expect(byPass[0]).toEqual([{ slot: 3, ptr: 0x8600 }, { slot: 8, ptr: 0x8800 }]) // prettier-ignore
    expect(byPass[1]).toEqual([{ slot: 3, ptr: 0x8600 }, { slot: 8, ptr: 0x8a00 }, { slot: 9, ptr: 0x1234 }]) // prettier-ignore
  })

  it('reports nothing for a sprite whose run never wrote the pointers', () => {
    const { probe, byPass } = uploadProbe()
    probe(-1, wram({ 2: 0x3000 }))
    probe(0, wram({ 2: 0x3000 }))
    expect(byPass[0]).toEqual([])
  })
})

describe('charsFromUploads', () => {
  // Every 32-byte tile is filled with its own index, so each char is recognisable and no two are alike.
  const buffer = () => {
    const bytes = new Uint8Array(0xb000 - MARIO_GFX_BASE)
    for (let t = 0; t < bytes.length / 32; t++) bytes.fill((t % 255) + 1, t * 32, t * 32 + 32)
    return { ok: true as const, bytes }
  }
  const pixels = (a: number, i: number) => decode4bpp(buffer().bytes, a - MARIO_GFX_BASE + i * 32)
  const keys = (d: ReturnType<typeof charsFromUploads>) => (d.ok ? [...d.chars.keys()].sort((a, b) => a - b) : d) // prettier-ignore

  it('lands slot 3 of both rows on chars 6, 7 and $16, $17, each from its own pointer, in order', () => {
    const d = charsFromUploads(buffer(), [{ slot: 3, ptr: 0x8600 }, { slot: 8, ptr: 0x8800 }]) // prettier-ignore
    expect(keys(d)).toEqual([0x406, 0x407, 0x416, 0x417])
    if (!d.ok) return
    expect(d.chars.get(0x406)).toEqual(pixels(0x8600, 0))
    expect(d.chars.get(0x407)).toEqual(pixels(0x8600, 1))
    expect(d.chars.get(0x416)).toEqual(pixels(0x8800, 0))
    expect(d.chars.get(0x417)).toEqual(pixels(0x8800, 1))
    // The fill is the tile index, so swapping two chars or two pointers is a different picture.
    expect(d.chars.get(0x406)).not.toEqual(d.chars.get(0x407))
    expect(d.chars.get(0x406)).not.toEqual(d.chars.get(0x416))
  })

  it('follows the slot the run wrote, not slot 3', () => {
    expect(keys(charsFromUploads(buffer(), [{ slot: 1, ptr: 0x8600 }, { slot: 6, ptr: 0x8800 }]))).toEqual([0x402, 0x403, 0x412, 0x413]) // prettier-ignore
  })

  it('refuses a slot outside the two rows and a pointer outside the buffer', () => {
    for (const bad of [{ slot: 10, ptr: 0x8600 }, { slot: -1, ptr: 0x8600 }, { slot: 3, ptr: 0x1000 }, { slot: 3, ptr: 0xafe0 }]) // prettier-ignore
      expect(charsFromUploads(buffer(), [bad])).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) }) // prettier-ignore
  })

  it('passes an unreadable buffer on as the reason', () => {
    expect(charsFromUploads({ ok: false, reason: 'not stock' }, [{ slot: 3, ptr: 0x8600 }])).toEqual({ ok: false, reason: 'not stock' }) // prettier-ignore
  })
})
