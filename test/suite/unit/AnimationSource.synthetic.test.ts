/**
 * Where the stock tile animation reads its GFX from, and whether the level
 * still runs it (#491). Every ROM here is built in the test from the 65816
 * encoding; the graphics are arithmetic.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { encode } from '../../../src/rom/LcLz2'
import { loromToOffset } from '../../../src/rom/addressing'
import {
  loadAnimationData,
  readAnimGfxSources,
  stockAnimatedChars,
  stockAnimationUnreached,
} from '../../../src/rom/AnimationLoader'
import { VRAM_SLOT_NAMES, type VramState } from '../../../src/rom/GfxLoader'
import { frameZeroChars } from '../../../theia/extension/src/node/map16-decode'

const ROM_SIZE = 0x30000
const off = (snes: number): number => loromToOffset(snes, ROM_SIZE)!

// Four 3bpp tiles whose bitplane 0 is solid, so every pixel decodes to `index`.
const tiles3bpp = (index: 1 | 2): Uint8Array =>
  Uint8Array.from({ length: 96 }, (_, k) => (k % 24 < 16 && k % 2 === index - 1 ? 0xff : 0))
// Four 4bpp tiles whose bitplane 2 (index 4) or 3 (index 8) is solid.
const tiles4bpp = (index: 4 | 8): Uint8Array =>
  Uint8Array.from({ length: 128 }, (_, k) => (k % 32 >= 16 && k % 2 === index >> 3 ? 0xff : 0))

// REP #$10 / LDY #lo,hi / STY $8A / LDA #bank / STA $8C (bank_00.asm:6250-6254)
// prettier-ignore
const head = (gfx33: number): number[] => [
  0xc2, 0x10, 0xa0, gfx33 & 0xff, (gfx33 >> 8) & 0xff, 0x84, 0x8a, 0xa9, gfx33 >> 16, 0x85, 0x8c,
]
// LDA #imm16 / STA $8A / SEP #$20 (bank_00.asm:6290-6292)
const tail = (gfx32: number): number[] => [0xa9, gfx32 & 0xff, gfx32 >> 8, 0x85, 0x8a, 0xe2, 0x20]
const GFX33_STREAM = encode(tiles3bpp(1))

interface RomOpts {
  routineAt?: number
  head?: number[]
  tail?: number[]
  bmi?: number[]
  jsr?: number[]
  jsl?: number[]
  gfx33At?: number
  gfx33Stream?: Uint8Array
  gfx32Stream?: Uint8Array
}

function animRom(o: RomOpts = {}): RomFile {
  const buf = Buffer.alloc(ROM_SIZE, 0)
  buf[0x7fd5] = 0x20
  const put = (snes: number, bytes: ArrayLike<number>): void => buf.set(bytes, off(snes))
  const routine = o.routineAt ?? 0x00b888
  const gfx33 = o.gfx33At ?? 0x01c000
  const stream = o.gfx33Stream ?? GFX33_STREAM
  put(0x009414, o.jsr ?? [0x20, routine & 0xff, (routine >> 8) & 0xff])
  put(routine, o.head ?? head(gfx33))
  put(routine + 0x44, o.bmi ?? [0x30, 0x09]) // CODE_00B8C4's exit to +$4F
  put(routine + 0x4f, o.tail ?? tail(0x9000))
  put(0x00a2a5, o.jsl ?? [0x22, 0x39, 0xbb, 0x05])
  // GFX32 where the stream ends, decoys where a start-bank or $8000 read would look.
  const endBank = (off(gfx33) + stream.length) >> 15
  put(((gfx33 >> 16) << 16) | 0x8000, encode(tiles4bpp(8)))
  put(((gfx33 >> 16) << 16) | 0x9000, encode(tiles4bpp(8)))
  put((endBank << 16) | 0x9000, o.gfx32Stream ?? encode(tiles4bpp(4)))
  put(gfx33, stream)
  // The unreferenced `dl` word points at different pixels, so reading it shows.
  put(0x00b882, [0x00, 0xa0, 0x01])
  put(0x01a000, encode(tiles3bpp(2)))
  put(0x05b93b, [0x00, 0x06, 0x00, 0x08]) // slot 0 -> $0600, slot 1 -> $0800 (berry split)
  put(0x05b93b + 18 * 2, [0x00, 0x0c]) // slot 18 -> $0C00
  for (let i = 0; i < 4; i++) put(0x05b999 + i * 2, [0x00, 0x7d]) // slot 0 from GFX33
  for (let i = 4; i < 8; i++) put(0x05b999 + i * 2, [0x00, 0x20]) // slot 1 from GFX32
  return new RomFile('anim.sfc', buf)
}

describe('readAnimGfxSources', () => {
  it('reads GFX33 from the LDY/LDA immediates and the GFX32 offset from LDA #imm', () => {
    expect(readAnimGfxSources(animRom())).toEqual({
      ok: true,
      gfx33: 0x01c000,
      gfx32Offset: 0x9000,
    })
  })

  it('folds the FastROM mirror bit out of the bank', () => {
    const r = readAnimGfxSources(animRom({ head: head(0x81c000) }))
    expect(r).toEqual({ ok: true, gfx33: 0x01c000, gfx32Offset: 0x9000 })
  })

  it('follows the JSR operand to a relocated routine', () => {
    const rom = animRom({ routineAt: 0x00c100 })
    rom.writeAt(0x00b888, new Array<number>(11).fill(0xea))
    expect(readAnimGfxSources(rom)).toEqual({ ok: true, gfx33: 0x01c000, gfx32Offset: 0x9000 })
  })

  it.each([
    ['the call site is not a JSR', { jsr: [0x22, 0x88, 0xb8] }, /\$009414/],
    [
      'GFX33 is not loaded by LDY/LDA #imm',
      { head: [0xc2, 0x10, 0xa2, ...head(0x01c000).slice(3)] },
      /GFX33/,
    ],
    ['GFX32 is not loaded by LDA #imm', { tail: [0xad, ...tail(0x9000).slice(1)] }, /GFX32/],
    ['the expansion loop does not exit to the GFX32 load', { bmi: [0x30, 0x08] }, /GFX32/],
  ])('refuses when %s', (_, opts, reason) => {
    const rom = animRom(opts as RomOpts)
    const r = readAnimGfxSources(rom)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(reason)
    expect(loadAnimationData(rom, 0)).toBeNull()
  })
})

describe('loadAnimationData sources', () => {
  const berry = (rom: RomFile): number[] =>
    Array.from(loadAnimationData(rom, 0)!.frames[0]!.find(s => s.charBase === 0x80)!.tiles[0]!)

  it('composites from the GFX33 the routine loads, not the dl word at $00B882', () => {
    const slot = loadAnimationData(animRom(), 0)!.frames[0]!.find(s => s.charBase === 0x60)!
    expect(Array.from(slot.tiles[0]!)).toEqual(new Array(64).fill(1))
  })

  it.each([
    ['within one bank', 0x01c000],
    ['across a bank boundary', 0x01fff0],
    ['with its terminator on the last byte of a bank', 0x020000 - GFX33_STREAM.length],
  ])('reads GFX32 from the bank a GFX33 stream %s ends in', (_, gfx33At) => {
    expect(berry(animRom({ gfx33At }))).toEqual(new Array(64).fill(4))
  })

  it('refuses a GFX33 stream with no terminator', () => {
    expect(loadAnimationData(animRom({ gfx33Stream: GFX33_STREAM.slice(0, -1) }), 0)).toBeNull()
  })
})

describe('stockAnimationUnreached', () => {
  it('is null while the level JSL reaches CODE_05BB39, mirror bit or not', () => {
    expect(stockAnimationUnreached(animRom())).toBeNull()
    expect(stockAnimationUnreached(animRom({ jsl: [0x22, 0x39, 0xbb, 0x85] }))).toBeNull()
  })

  it('names the target when the JSL goes elsewhere', () => {
    expect(stockAnimationUnreached(animRom({ jsl: [0x22, 0x77, 0xac, 0x13] }))).toEqual({
      target: 0x13ac77,
    })
  })

  it('refuses when $00A2A5 is no longer a JSL', () => {
    const r = stockAnimationUnreached(animRom({ jsl: [0xea, 0xea, 0xea, 0xea] }))
    expect(r && 'reason' in r && r.reason).toMatch(/\$00A2A5/)
  })
})

describe('stockAnimatedChars', () => {
  it('is every character the destination tables write, berry split and late slots included', () => {
    expect([...stockAnimatedChars(animRom())].sort((a, b) => a - b)).toEqual([
      0x60, 0x61, 0x62, 0x63, 0x80, 0x81, 0x90, 0x91, 0xc0, 0xc1, 0xc2, 0xc3,
    ])
  })
})

describe('frameZeroChars', () => {
  const rawVram = (): VramState =>
    Object.fromEntries(
      VRAM_SLOT_NAMES.map(s => [s, Array.from({ length: 128 }, () => new Uint8Array(64).fill(7))]),
    )
  const charAt = (vram: VramState, c: number): number[] =>
    Array.from([...vram.fg1!, ...vram.fg2!][c]!)

  it('composites frame 0 when the stock routine is reached', () => {
    const r = frameZeroChars(animRom(), 0, rawVram())!
    expect(r.note).toBeUndefined()
    expect(r.animData).toBeDefined()
    expect(charAt(r.vram, 0x60)).toEqual(new Array(64).fill(1))
  })

  it.each([
    [
      'the level JSL is redirected',
      { jsl: [0x22, 0x77, 0xac, 0x13] },
      /decides per level.*\$13AC77/,
    ],
    ['the GFX sources cannot be read', { jsr: [0xea, 0xea, 0xea] }, /\$009414/],
    [
      'the GFX33 stream fails to decompress',
      { gfx33Stream: GFX33_STREAM.slice(0, -1) }, // drops the $FF terminator
      /left blank.*did not terminate/i,
    ],
    [
      'the GFX32 stream fails to decompress',
      // An out-of-range back-reference fails within its own 5 bytes, unlike
      // a dropped terminator: `animRom` plants other streams later in this
      // read window (the $9000 decoy, the dl word's stream at $01A000), so
      // a truncation here would run past this write and find one of theirs.
      { gfx32Stream: Uint8Array.from([0x00, 0x11, 0x80, 0xff, 0xff]) },
      /left blank.*back-reference/i,
    ],
    [
      'GFX32 points outside the ROM',
      // $05:F000 is file offset $2F000; its read window runs past the ROM's end.
      { gfx33At: 0x05c000, tail: tail(0xf000) },
      /left blank.*GFX32 points outside the ROM/,
    ],
  ])('blanks the stock characters and carries a note when %s', (_, opts, note) => {
    const r = frameZeroChars(animRom(opts as RomOpts), 0, rawVram())!
    expect(r.animData).toBeUndefined()
    expect(r.note).toMatch(note)
    for (const c of [0x60, 0x63, 0x80, 0x91, 0xc3])
      expect(charAt(r.vram, c)).toEqual(new Array(64).fill(0))
    expect(charAt(r.vram, 0x64)).toEqual(new Array(64).fill(7))
  })
})
