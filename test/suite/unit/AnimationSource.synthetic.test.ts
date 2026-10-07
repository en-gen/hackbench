/**
 * Where the stock tile animation reads its GFX from, and whether the level
 * still runs it. Every ROM here is built in the test from the 65816
 * encoding; the graphics are arithmetic.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { encode } from '../../../src/rom/LcLz2'
import { loromToOffset } from '../../../src/rom/addressing'
import {
  loadAnimationData,
  loadAnimationDataOrReason,
  readAnimGfxSources,
  readAnimRoutine,
  slotTiles,
  stockAnimationUnreached,
  switchesForChars,
  type AnimationData,
} from '../../../src/rom/AnimationLoader'
import { VRAM_SLOT_NAMES, type VramState } from '../../../src/rom/GfxLoader'
import { decodeMap16Sheet } from '../../../theia/extension/src/node/map16-decode'
import { frameZeroChars, playableAnimation, type FrameZeroChars } from '../../../src/rom/FrameZero'
import { map16DecodeStub } from '../support/syntheticMap16'
import { flip } from '../support/syntheticRom'
import {
  BACKREF_AT,
  BACKREF_DISPATCH,
  backRefBytes,
  DISPATCH_AT,
  gfxStreams,
  plantFast,
  plantPrelude,
  TABLE_BANK,
  TABLE_HI,
  TABLE_LO,
} from '../support/syntheticGfxCart'
import { STOCK_LCLZ2_ENTRY, type FastRoutine } from '../../../src/rom/GfxDecompressor'

const ROM_SIZE = 0x30000

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

const w = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff]

interface RoutineOpts {
  c?: number
  b?: number
  a?: number
  beh?: number
  sel?: number
  timer?: number
  shift?: number
  ts?: number
  atd?: number
}
// CODE_05BB39 through its AnimatedTileData read (bank_05.asm:4384-4436), operands as parameters.
// prettier-ignore
const stockRoutine = (o: RoutineOpts = {}): number[] => [
  0x8b, 0x4b, 0xab, 0xa5, 0x14, 0x29, 0x07, 0x85, 0x00, 0x0a, 0x65, 0x00, 0xa8,
  0x0a, 0xaa, 0xc2, 0x20, 0xa5, 0x14, 0x29, 0x18, 0x00, 0x4a, 0x4a, 0x85, 0x00,
  0xbd, ...w(o.c ?? 0xb93b), 0x8d, 0x80, 0x0d, 0xbd, ...w(o.b ?? 0xb93d), 0x8d, 0x7e, 0x0d,
  0xbd, ...w(o.a ?? 0xb93f), 0x8d, 0x7c, 0x0d, 0xa2, 0x04,
  0x5a, 0xda, 0xe2, 0x20, 0x98,
  0xbe, ...w(o.beh ?? 0xb96b), 0xf0, 0x17, 0xca, 0xd0, 0x0d,
  0xbe, ...w(o.sel ?? 0xb97d), 0xbc, ...w(o.timer ?? 0x14ad), 0xf0, 0x0c, 0x18, 0x69, o.shift ?? 0x26, 0x80, 0x07,
  0xac, ...w(0x1931), 0x18, 0x79, ...w(o.ts ?? 0xb98b),
  0xc2, 0x30, 0x29, 0xff, 0x00, 0x0a, 0x0a, 0x0a, 0x05, 0x00, 0xa8, 0xb9, ...w(o.atd ?? 0xb999),
  0xe2, 0x10, 0xfa, 0x9d, 0x76, 0x0d, 0x7a, 0xc8, 0xca, 0xca, 0x10, 0xc5, 0xe2, 0x20, 0xab, 0x6b,
]
// Offsets of the operands the loader reads; every other byte of the routine is gated.
// prettier-ignore
const READ_OPERANDS = new Set([
  0x1b, 0x1c, 0x21, 0x22, 0x27, 0x28, 0x34, 0x35, 0x3c, 0x3d, 0x3f, 0x40, 0x45, 0x4d, 0x4e, 0x5b, 0x5c,
])

interface RomOpts {
  routineAt?: number
  head?: number[]
  tail?: number[]
  bmi?: number[]
  jsr?: number[]
  jsl?: number[]
  /** GFX33's JSR to the decompressor, and the decompressor entry GFX32 falls into. */
  gfx33Call?: number[]
  entry?: readonly number[]
  gfx33At?: number
  gfx33Stream?: Uint8Array
  gfx32Stream?: Uint8Array
  anim?: number[]
  /** ROM size in bytes; smaller than default lets a later table land off the end. */
  size?: number
  /** Skip the VRAM destination table, so no character animates at all. */
  emptyDestTable?: boolean
}

/**
 * Plants the JSR/JSL, GFX33/GFX32 and destination-table bytes onto `rom`,
 * skipping any write that would land off the end of it - so a small `rom`
 * leaves its later tables genuinely unreadable rather than corrupting
 * whatever sits at file offset 0. Shared with the `decodeMap16Sheet` stub
 * below, so a Map16-capable ROM carries real animation data too.
 */
function plantAnim(rom: RomFile, o: RomOpts = {}): void {
  const size = rom.romSize
  const put = (snes: number, bytes: ArrayLike<number>): void => {
    const at = loromToOffset(snes, size)
    if (at !== null && at + bytes.length <= rom.buffer.length) rom.buffer.set(bytes, at)
  }
  const routine = o.routineAt ?? 0x00b888
  const gfx33 = o.gfx33At ?? 0x01c000
  const stream = o.gfx33Stream ?? GFX33_STREAM
  put(0x009414, o.jsr ?? [0x20, routine & 0xff, (routine >> 8) & 0xff])
  put(routine, o.head ?? head(gfx33))
  put(routine + 0x44, o.bmi ?? [0x30, 0x09]) // CODE_00B8C4's exit to +$4F
  put(routine + 0x14, o.gfx33Call ?? [0x20, (routine + 0x56) & 0xff, (routine + 0x56) >> 8])
  put(routine + 0x4f, o.tail ?? tail(0x9000))
  put(routine + 0x56, o.entry ?? STOCK_LCLZ2_ENTRY)
  put(routine + 0x56 + DISPATCH_AT, BACKREF_DISPATCH)
  put(routine + 0x56 + BACKREF_AT, backRefBytes('be'))
  put(0x00a2a5, o.jsl ?? [0x22, 0x39, 0xbb, 0x05])
  put(0x05bb39, o.anim ?? stockRoutine())
  // GFX32 where the stream ends, decoys where a start-bank or $8000 read would look.
  const endBank = (loromToOffset(gfx33, size)! + stream.length) >> 15
  put(((gfx33 >> 16) << 16) | 0x8000, encode(tiles4bpp(8)))
  put(((gfx33 >> 16) << 16) | 0x9000, encode(tiles4bpp(8)))
  put((endBank << 16) | 0x9000, o.gfx32Stream ?? encode(tiles4bpp(4)))
  put(gfx33, stream)
  // The unreferenced `dl` word points at different pixels, so reading it shows.
  put(0x00b882, [0x00, 0xa0, 0x01])
  put(0x01a000, encode(tiles3bpp(2)))
  if (o.emptyDestTable) return
  put(0x05b93b, [0x00, 0x06, 0x00, 0x08]) // slot 0 -> $0600, slot 1 -> $0800 (berry split)
  put(0x05b93b + 18 * 2, [0x00, 0x0c]) // slot 18 -> $0C00
  for (let i = 0; i < 4; i++) put(0x05b999 + i * 2, [0x00, 0x7d]) // slot 0 from GFX33
  for (let i = 4; i < 8; i++) put(0x05b999 + i * 2, [0x00, 0x20]) // slot 1 from GFX32
}

function animRom(o: RomOpts = {}): RomFile {
  const buf = Buffer.alloc(o.size ?? ROM_SIZE, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('anim.sfc', buf)
  plantAnim(rom, o)
  return rom
}

describe('readAnimGfxSources', () => {
  it('reads GFX33 from the LDY/LDA immediates and the GFX32 offset from LDA #imm', () => {
    expect(readAnimGfxSources(animRom())).toEqual({
      ok: true,
      gfx33: 0x01c000,
      gfx32Offset: 0x9000,
      kind: 'stock',
      order: 'be',
    })
  })

  it('carries the back-reference order of the decompressor to the animation reads', () => {
    const rom = animRom()
    rom.writeAt(0x00b8de + BACKREF_AT, backRefBytes('le'))
    const r = readAnimGfxSources(rom)
    expect(r.ok && r.order).toBe('le')
  })

  it('folds the FastROM mirror bit out of the bank', () => {
    const r = readAnimGfxSources(animRom({ head: head(0x81c000) }))
    expect(r).toEqual({
      ok: true,
      gfx33: 0x01c000,
      gfx32Offset: 0x9000,
      kind: 'stock',
      order: 'be',
    })
  })

  it('follows the JSR operand to a relocated routine', () => {
    const rom = animRom({ routineAt: 0x00c100 })
    rom.writeAt(0x00b888, new Array<number>(11).fill(0xea))
    expect(readAnimGfxSources(rom)).toEqual({
      ok: true,
      gfx33: 0x01c000,
      gfx32Offset: 0x9000,
      kind: 'stock',
      order: 'be',
    })
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

// The decompressor both loads reach (#603, #655): keyed, fast, or unrecognized.
describe('animation GFX through the decompressor', () => {
  const ENTRY = 0x00b8de
  const PRELUDE_AT = 0x02f000
  const FAST_AT = 0x03f000
  const keyedRom = (key: number): RomFile => {
    const rom = animRom({ head: head(0x010000 | (0xc000 ^ key)), tail: tail(0x9000 ^ key) })
    plantPrelude(rom, PRELUDE_AT, key, ENTRY)
    return rom
  }
  const fastRom = (o: RomOpts = {}): { rom: RomFile; fast: FastRoutine[] } => {
    const rom = animRom(o)
    return { rom, fast: [plantFast(rom, FAST_AT, 0x40, ENTRY)] }
  }

  it('applies the prelude key to both immediates, for two keys', () => {
    const stock = loadAnimationData(animRom(), 0)
    for (const key of [0x0300, 0x5aa5]) {
      expect(readAnimGfxSources(keyedRom(key))).toMatchObject({
        gfx33: 0x01c000,
        gfx32Offset: 0x9000,
      })
      expect(loadAnimationData(keyedRom(key), 0), `key ${key}`).toEqual(stock)
    }
  })

  it('decodes through the fast routine, and refuses a command it reads differently', () => {
    const ok = fastRom()
    expect(loadAnimationDataOrReason(ok.rom, 0, ok.fast).ok).toBe(true)
    expect(loadAnimationDataOrReason(ok.rom, 0).ok).toBe(false) // not a shipped routine
    const bad = fastRom({ gfx33Stream: Uint8Array.from([0x00, 0x11, 0xc0, 0x00, 0x00, 0xff]) })
    const r = loadAnimationDataOrReason(bad.rom, 0, bad.fast)
    expect(!r.ok && r.reason).toMatch(/GFX33: .*reads differently/)
    const bad32 = fastRom({ gfx32Stream: Uint8Array.from([0x00, 0x11, 0xc0, 0x00, 0x00, 0xff]) })
    const r32 = loadAnimationDataOrReason(bad32.rom, 0, bad32.fast)
    expect(!r32.ok && r32.reason).toMatch(/GFX32: .*reads differently/)
  })

  it('refuses an unrecognized decompressor, naming it', () => {
    const r = loadAnimationDataOrReason(animRom({ entry: [0x22, 0x00, 0x80, 0x04, 0x60] }), 0)
    expect(!r.ok && r.reason).toMatch(/replaced the LC_LZ2 decompressor at \$00B8DE/)
  })

  it('refuses when GFX33 is not decompressed by the entry GFX32 falls into', () => {
    const r = readAnimGfxSources(animRom({ gfx33Call: [0x20, (ENTRY + 1) & 0xff, ENTRY >> 8] }))
    expect(!r.ok && r.reason).toMatch(/GFX33 is not decompressed/)
  })

  it('refuses when any byte of the GFX33 call is flipped', () => {
    const survived = [0, 1, 2].filter(i => {
      const rom = animRom()
      flip(rom, 0x00b888 + 0x14 + i)
      return readAnimGfxSources(rom).ok
    })
    expect(survived).toEqual([])
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

const rawVram = (): VramState =>
  Object.fromEntries(
    VRAM_SLOT_NAMES.map(s => [s, Array.from({ length: 128 }, () => new Uint8Array(64).fill(7))]),
  )

describe('frameZeroChars', () => {
  const charAt = (vram: VramState, c: number): number[] =>
    Array.from([...vram.fg1!, ...vram.fg2!][c]!)

  it('composites frame 0 when the stock routine is reached', () => {
    const r = frameZeroChars(animRom(), 0, rawVram())!
    expect(r.error).toBeUndefined()
    expect(r.animData).toBeDefined()
    expect(charAt(r.vram, 0x60)).toEqual(new Array(64).fill(1))
  })

  it('shows stock frames still, with the reason, when the reached routine cannot be read', () => {
    const anim = stockRoutine()
    anim.splice(0, 4, 0x5c, 0x00, 0x80, 0x02) // JML over CODE_05BB39's entry
    const r = frameZeroChars(animRom({ anim }), 0, rawVram())!
    expect(r.animData?.unverified).toMatch(/set-up .* is replaced/)
    expect(r.error).toMatch(/couldn't be loaded: CODE_05BB39's set-up .*Showing stock frames/)
    expect(charAt(r.vram, 0x60)).toEqual(new Array(64).fill(1))
    expect(playableAnimation(r)).toBeUndefined()
  })

  it('reports nothing for a tileset with no stock data to animate when the routine is reached', () => {
    expect(frameZeroChars(animRom({ emptyDestTable: true }), 0, rawVram())).toBeUndefined()
  })

  it('still reports when the routine is unreached, even with nothing to animate', () => {
    const r = frameZeroChars(
      animRom({ jsl: [0x22, 0x77, 0xac, 0x13], emptyDestTable: true }),
      0,
      rawVram(),
    )!
    expect(r.animData).toBeDefined()
    expect(r.error).toMatch(/couldn't be loaded/)
  })

  it.each([
    [
      'the level JSL is redirected',
      { jsl: [0x22, 0x77, 0xac, 0x13] },
      /decides per level.*\$13AC77/,
    ],
    [
      'the level animation call is no longer a JSL',
      { jsl: [0xea, 0xea, 0xea, 0xea] },
      /\$00A2A5 is no longer a JSL/,
    ],
  ])('composites frame 0 from the stock data, unverified, when %s', (_, opts, reason) => {
    const r = frameZeroChars(animRom(opts as RomOpts), 0, rawVram())!
    expect(r.animData).toBeDefined()
    expect(r.error).toMatch(/couldn't be loaded/)
    expect(r.error).toMatch(reason)
    expect(charAt(r.vram, 0x60)).toEqual(new Array(64).fill(1))
  })

  it.each([
    ['the GFX sources cannot be read', { jsr: [0xea, 0xea, 0xea] }, /\$009414/],
    [
      'the GFX33 stream fails to decompress',
      { gfx33Stream: GFX33_STREAM.slice(0, -1) }, // drops the $FF terminator
      /did not terminate/i,
    ],
    [
      'the GFX32 stream fails to decompress',
      // An out-of-range back-reference fails within its own 5 bytes, unlike
      // a dropped terminator: `animRom` plants other streams later in this
      // read window (the $9000 decoy, the dl word's stream at $01A000), so
      // a truncation here would run past this write and find one of theirs.
      { gfx32Stream: Uint8Array.from([0x00, 0x11, 0x80, 0xff, 0xff]) },
      /back-reference/i,
    ],
    [
      'GFX32 points outside the ROM',
      // $05:F000 is file offset $2F000; its read window runs past the ROM's end.
      { gfx33At: 0x05c000, tail: tail(0xf000) },
      /GFX32 points outside the ROM/,
    ],
    [
      "the animation behavior tables can't be read",
      { size: 0x20000 }, // GFX33/GFX32 fit; $05B96B and later do not
      /\$05B96B/,
    ],
  ])('leaves characters as loaded and reports why when %s', (_, opts, reason) => {
    const r = frameZeroChars(animRom(opts as RomOpts), 0, rawVram())!
    expect(r.animData).toBeUndefined()
    expect(r.error).toMatch(/couldn't be loaded/)
    expect(r.error).toMatch(reason)
    for (const c of [0x60, 0x63, 0x80, 0x91, 0xc3])
      expect(charAt(r.vram, c)).toEqual(new Array(64).fill(7))
  })
})

describe('playableAnimation', () => {
  const animData = { frameCount: 4, frames: [], intervalMs: 133 } as unknown as AnimationData
  const asFrameZero = (v: object | undefined): FrameZeroChars => v as unknown as FrameZeroChars

  it('returns the data when the source is verified', () => {
    const frameZero = asFrameZero({ animData, chars: new Map(), vram: {} })
    expect(playableAnimation(frameZero)).toBe(animData)
  })

  it.each([
    ['composited but unverified', { animData, chars: new Map(), vram: {}, error: 'x' }],
    ['no stock data to composite at all', { vram: {}, error: 'x' }],
    ['frameZeroChars found nothing to report', undefined],
  ])('returns undefined when %s', (_, frameZero) => {
    expect(playableAnimation(asFrameZero(frameZero))).toBeUndefined()
  })
})

describe('decodeMap16Sheet', () => {
  function stubAnimRom(o: RomOpts = {}): SmwRom {
    const rom = map16DecodeStub()
    plantAnim(rom, o)
    // A real (if arbitrary) GFX0 stream, so the sheet actually decodes
    // instead of reporting every character sheet unavailable.
    const [stream] = gfxStreams()
    const streamAt = 0x02c000
    rom.writeAt(streamAt, Array.from(stream!))
    rom.writeAt(TABLE_LO, [streamAt & 0xff])
    rom.writeAt(TABLE_HI, [(streamAt >> 8) & 0xff])
    rom.writeAt(TABLE_BANK, [(streamAt >> 16) & 0xff])
    return new SmwRom(rom)
  }

  it('carries the error when the level JSL is redirected', () => {
    const result = decodeMap16Sheet(stubAnimRom({ jsl: [0x22, 0x77, 0xac, 0x13] }), 0, 'fg', {
      bg: 0,
      fg: 0,
    })
    if (result.status !== 'ok') throw new Error(result.reason)
    expect(result.sheet.animationNote).toMatch(/couldn't be loaded.*\$13AC77/)
  })
})

// The #573 research table: slot -> [char base, selector, switch].
const SWITCH_SLOTS: [number, number, number, string][] = [
  [6, 0x50, 0, 'blue'],
  [7, 0x54, 0, 'blue'],
  [8, 0x58, 0, 'blue'],
  [9, 0x5c, 1, 'silver'],
  [10, 0x78, 0, 'blue'],
  [11, 0x7c, 2, 'onOff'],
  [12, 0xda, 2, 'onOff'],
  [13, 0x6c, 0, 'blue'],
]
// Four 3bpp tiles solid in color c: bitplanes 0/1 interleaved, then bitplane 2.
const solid3bpp = (c: number): number[] =>
  Array.from({ length: 96 }, (_, k) => ((c >> (k % 24 < 16 ? k % 2 : 2)) & 1 ? 0xff : 0))
// GFX33 groups at $7D00 + $80n in colors 1, 2, 3, 5, 6; GFX32 at $2000 is color 4.
const SWITCH_GFX33 = encode(Uint8Array.from([1, 2, 3, 5, 6].flatMap(solid3bpp)))
const ALT_COLORS = [2, 3, 5, 6]
const bank5 = (a: number): number => 0x050000 | a
const entry = (rom: RomFile, atd: number, slot: number, f: number, ram: number): void =>
  rom.writeAt(bank5(atd) + slot * 8 + f * 2, w(ram))

// Switch slots per the table, a behavior-2 slot 3 at $048, and every slot below 14 given a
// distinct switched frame, so a slot tagged by mistake would carry pixels too.
function switchRom(o: RoutineOpts = {}, extra: RomOpts = {}): RomFile {
  const rom = animRom({ gfx33Stream: SWITCH_GFX33, anim: stockRoutine(o), ...extra })
  const atd = o.atd ?? 0xb999
  rom.writeAt(0x05b93b + 3 * 2, w(0x0480))
  rom.writeAt(bank5(o.beh ?? 0xb96b) + 3, [2])
  for (let f = 0; f < 4; f++) {
    entry(rom, atd, 3, f, 0x7d00)
    for (let slot = 0; slot < 14; slot++) entry(rom, atd, slot + 0x26, f, 0x7d80 + f * 0x80)
  }
  for (const [slot, char, sel] of SWITCH_SLOTS) {
    rom.writeAt(0x05b93b + slot * 2, w(char * 16))
    rom.writeAt(bank5(o.beh ?? 0xb96b) + slot, [1])
    if ((o.sel ?? 0xb97d) >= 0x8000) rom.writeAt(bank5(o.sel ?? 0xb97d) + slot, [sel])
    for (let f = 0; f < 4; f++) entry(rom, atd, slot, f, 0x7d00)
  }
  return rom
}
const frame0 = (rom: RomFile) => loadAnimationData(rom, 0)!.frames[0]!
const at = (rom: RomFile, char: number) => frame0(rom).find(s => s.charBase === char)!

describe('readAnimRoutine', () => {
  it('reads every table, the timer base and the shift from the routine operands', () => {
    expect(readAnimRoutine(switchRom())).toEqual({
      ok: true,
      vramDest: [0x05b93b, 0x05b93d, 0x05b93f],
      behaviorTable: 0x05b96b,
      selectorTable: 0x05b97d,
      timerBase: 0x14ad,
      shift: 0x26,
      tilesetOffsetTable: 0x05b98b,
      animatedTileData: 0x05b999,
    })
  })

  it('reads a mutated ADC operand as the shift', () => {
    const r = readAnimRoutine(switchRom({ shift: 0x27 }))
    expect(r.ok && r.shift).toBe(0x27)
  })

  it.each([...stockRoutine().keys()].filter(i => !READ_OPERANDS.has(i)))(
    'refuses when gated byte +$%s is changed',
    i => {
      const rom = switchRom()
      rom.writeAt(0x05bb39 + i, [stockRoutine()[i]! ^ 0xff])
      const r = readAnimRoutine(rom)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/CODE_05BB39's .* is replaced/)
      const data = loadAnimationData(rom, 0)!
      expect(data.frames.flat().some(s => s.alt)).toBe(false)
      expect(data.switchUnavailable).toMatch(/is replaced/)
    },
  )

  it('refuses a JSL over the upload, which reads the table but never uses it', () => {
    const rom = switchRom()
    rom.writeAt(0x05bb39 + 0x5d, [0x22, 0x00, 0x80, 0x02])
    const r = readAnimRoutine(rom)
    expect(!r.ok && r.reason).toMatch(/upload and loop close/)
  })

  it.each(['c', 'b', 'a', 'beh', 'ts', 'atd'] as const)(
    'refuses the %s table in WRAM or across its bank end',
    key => {
      for (const addr of [0x1000, 0xffff]) {
        const r = readAnimRoutine(animRom({ anim: stockRoutine({ [key]: addr }) }))
        expect(!r.ok && r.reason).toMatch(addr < 0x8000 ? /is in WRAM/ : /crosses its bank end/)
      }
    },
  )

  it.each(['c', 'b', 'a', 'beh', 'ts', 'atd'] as const)(
    'accepts the %s table at $8000 and refuses it a byte below',
    key => {
      const read = (addr: number) =>
        readAnimRoutine(animRom({ anim: stockRoutine({ [key]: addr }) }))
      expect([read(0x8000).ok, read(0x7fff).ok]).toEqual([true, false])
    },
  )

  it.each([
    ['c', 0xffd4],
    ['beh', 0xffe8],
    ['ts', 0xfff0],
    ['atd', 0xf800],
  ] as const)('accepts the %s table ending on its bank end, not a byte past', (key, last) => {
    const read = (addr: number) => readAnimRoutine(animRom({ anim: stockRoutine({ [key]: addr }) }))
    expect([read(last).ok, read(last + 1).ok]).toEqual([true, false])
  })

  it('refuses a JML over the entry even with the rest intact', () => {
    const rom = switchRom()
    rom.writeAt(0x05bb39, [0x5c, 0x00, 0x80, 0x02])
    expect(readAnimRoutine(rom).ok).toBe(false)
  })

  it('still marks the behavior-1 slots switched when the routine is unreadable', () => {
    const rom = switchRom()
    rom.writeAt(0x05bb39, [0x5c, 0x00, 0x80, 0x02])
    const slots = loadAnimationData(rom, 0)!.frames[0]!
    expect(slots.filter(s => s.switched).map(s => s.charBase)).toEqual(
      SWITCH_SLOTS.map(([, c]) => c),
    )
    expect(slots.find(s => s.charBase === 0x48)!.switched).toBeUndefined()
  })

  it('ignores a dead copy elsewhere, which never runs', () => {
    const rom = switchRom()
    rom.writeAt(0x02c000, stockRoutine({ shift: 0x30 }))
    const r = readAnimRoutine(rom)
    expect(r.ok && r.shift).toBe(0x26)
  })

  it.each([
    ['the level JSL skips CODE_05BB39', { jsl: [0x22, 0x77, 0xac, 0x13] }, /\$13AC77/],
    ['$00A2A5 is not a JSL', { jsl: [0xea, 0xea, 0xea, 0xea] }, /\$00A2A5/],
  ])('refuses when %s', (_, opts, reason) => {
    const rom = switchRom({}, opts)
    const r = readAnimRoutine(rom)
    expect(!r.ok && r.reason).toMatch(reason)
    expect(loadAnimationData(rom, 0)!.switchUnavailable).toMatch(reason)
  })
})

describe('animation tables read from the routine', () => {
  it.each([
    ['C', 0, 'c'],
    ['B', 1, 'b'],
    ['A', 2, 'a'],
  ] as const)('follows a moved VRAM destination table %s', (_, k, key) => {
    const rom = switchRom({ [key]: 0xc600 })
    rom.writeAt(0x05c600, w(0x0440))
    for (let f = 0; f < 4; f++) entry(rom, 0xb999, k, f, 0x7d00)
    const r = readAnimRoutine(rom)
    expect(r.ok && r.vramDest[k]).toBe(0x05c600)
    expect(at(rom, 0x44).tiles[0]![0]).toBe(1)
  })

  it('follows a moved tileset offset table, and behavior 3 takes the tileset path', () => {
    const rom = switchRom({ ts: 0xc400 })
    rom.writeAt(0x05c400, [0x10])
    rom.writeAt(0x05b96b + 4, [3])
    rom.writeAt(0x05b93b + 4 * 2, w(0x04c0))
    for (let f = 0; f < 4; f++) {
      entry(rom, 0xb999, 4, f, 0x7d00)
      for (const slot of [19, 20]) entry(rom, 0xb999, slot, f, 0x7e00)
    }
    expect([at(rom, 0x48), at(rom, 0x4c)].map(s => s.tiles[0]![0])).toEqual([3, 3])
  })

  it('adds the offset of the tileset being loaded', () => {
    const rom = switchRom({ ts: 0xc400 })
    rom.writeAt(0x05c400 + 5, [0x10])
    for (let f = 0; f < 4; f++) entry(rom, 0xb999, 19, f, 0x7e00)
    const color = (ts: number) =>
      loadAnimationData(rom, ts)!.frames[0]!.find(s => s.charBase === 0x48)!.tiles[0]![0]
    expect([color(0), color(5)]).toEqual([1, 3])
  })

  it('wraps the tileset-adjusted slot to 8 bits: offset $F0 on slot 23 reads slot 7', () => {
    const rom = switchRom()
    rom.writeAt(0x05b98b, [0xf0])
    rom.writeAt(0x05b96b + 23, [2])
    rom.writeAt(0x05b93b + 23 * 2, w(0x0d00))
    for (let f = 0; f < 4; f++) entry(rom, 0xb999, 23, f, 0x2000)
    expect(at(rom, 0xd0).tiles[0]![0]).toBe(1)
  })

  it('reads each frame from its own AnimatedTileData entry', () => {
    const rom = switchRom()
    for (let f = 0; f < 4; f++) entry(rom, 0xb999, 0, f, 0x7d00 + f * 0x80)
    const frames = loadAnimationData(rom, 0)!.frames
    expect(frames.map(fr => fr.find(s => s.charBase === 0x60)!.tiles[0]![0])).toEqual([1, 2, 3, 5])
  })

  it('reads the unswitched frames from a moved AnimatedTileData', () => {
    const rom = switchRom({ atd: 0xd000 })
    for (let f = 0; f < 4; f++) entry(rom, 0xd000, 0, f, 0x7e00)
    expect(at(rom, 0x60).tiles[0]![0]).toBe(3)
  })
})

describe('switch alternates', () => {
  it('tags exactly the table-listed slots, with each frame its own switched pixels', () => {
    const data = loadAnimationData(switchRom(), 0)!
    expect(data.switchUnavailable).toBeUndefined()
    data.frames.forEach((frame, f) => {
      const tagged = frame
        .filter(s => s.alt)
        .map(s => [s.charBase, s.alt!.switch, s.alt!.tiles[0]![0]])
      expect(tagged).toEqual(SWITCH_SLOTS.map(([, c, , k]) => [c, k, ALT_COLORS[f]]))
    })
  })

  it('follows moved behavior and selector tables', () => {
    const rom = switchRom({ beh: 0xc800, sel: 0xc900 })
    const r = readAnimRoutine(rom)
    expect(r.ok && [r.behaviorTable, r.selectorTable]).toEqual([0x05c800, 0x05c900])
    expect(frame0(rom).filter(s => s.alt)).toHaveLength(8)
  })

  it('names switches from a moved timer base, and leaves an unknown RAM byte untagged', () => {
    const data = loadAnimationData(switchRom({ timer: 0x14ae }), 0)!
    const tag = (c: number) => data.frames[0]!.find(s => s.charBase === c)!.alt?.switch
    expect([tag(0x50), tag(0x5c), tag(0x7c)]).toEqual(['silver', 'onOff', undefined])
    expect(data.switchUnavailable).toMatch(/slot 11 follows RAM \$14B0/)
  })

  it('leaves a selector of 3 untagged and says why', () => {
    const rom = switchRom()
    rom.writeAt(0x05b97d + 6, [3])
    const data = loadAnimationData(rom, 0)!
    expect(data.frames[0]!.find(s => s.charBase === 0x50)!.alt).toBeUndefined()
    expect(data.frames[0]!.filter(s => s.alt)).toHaveLength(7)
    expect(data.switchUnavailable).toMatch(/slot 6 follows RAM \$14B0/)
  })

  it('wraps the shifted slot to 8 bits: ADC #$F0 on slot 23 reads slot 7', () => {
    const rom = switchRom({ shift: 0xf0, beh: 0xc800, sel: 0xc900 })
    rom.writeAt(0x05c800 + 23, [1])
    rom.writeAt(0x05b93b + 23 * 2, w(0x0d00))
    for (let f = 0; f < 4; f++) entry(rom, 0xb999, 23, f, 0x2000)
    const slot = at(rom, 0xd0)
    expect([slot.tiles[0]![0], slot.alt?.tiles[0]![0]]).toEqual([4, 1])
  })

  it.each([
    ['$05FFF0', 0xfff0, /selector table \$05FFF0 crosses its bank end/],
    ['$057FF0', 0x7ff0, /selector table \$057FF0 is in WRAM/],
  ])('keeps the frames when the selector table at %s cannot be ROM', (_, sel, reason) => {
    // Bank 6 exists, so a file read past $05FFFF would succeed where the SNES wraps.
    const rom = switchRom({ sel }, { size: 0x38000 })
    const data = loadAnimationData(rom, 0)!
    expect(data.frames[0]!.find(s => s.charBase === 0x50)!.tiles[0]![0]).toBe(1)
    expect(data.frames.flat().some(s => s.alt)).toBe(false)
    expect(data.switchUnavailable).toMatch(reason)
    // A switch-only fault leaves the frames verified and playable.
    const frameZero = frameZeroChars(rom, 0, rawVram())
    expect(frameZero?.error).toBeUndefined()
    expect(playableAnimation(frameZero)).toBeDefined()
  })

  it.each([
    ['behavior', 'beh'],
    ['tileset offset', 'ts'],
  ] as const)('names the %s table the routine read when it runs off the ROM', (name, key) => {
    // The routine sits below $05C000 and reads fine; $05E000 is past this ROM's end.
    const rom = animRom({ anim: stockRoutine({ [key]: 0xe000 }), size: 0x2c000 })
    expect(readAnimRoutine(rom).ok).toBe(true)
    const r = loadAnimationDataOrReason(rom, 0)
    expect(!r.ok && r.reason).toBe(
      `the animation ${name} table at $05E000 runs past the end of the ROM`,
    )
  })

  it('refuses an alternate on the $0800 berry split, saying why', () => {
    const rom = switchRom()
    rom.writeAt(0x05b93b + 6 * 2, w(0x0800))
    const data = loadAnimationData(rom, 0)!
    expect(data.frames[0]!.filter(s => s.alt)).toHaveLength(7)
    expect(data.switchUnavailable).toMatch(/slot 6 writes the \$0800 split/)
    // Both halves of the split stay marked switched, so their tiles still get the note (N20).
    const halves = data.frames[0]!.filter(s => s.charBase === 0x80 || s.charBase === 0x90)
    expect(halves.filter(s => s.switched).map(s => [s.charBase, s.switched])).toEqual([
      [0x80, true],
      [0x90, true],
    ])
  })

  it('drops a switched frame that points outside the animated tiles, saying why', () => {
    const rom = switchRom()
    entry(rom, 0xb999, 6 + 0x26, 0, 0x0000)
    const data = loadAnimationData(rom, 0)!
    expect(data.frames[0]!.find(s => s.charBase === 0x50)!.alt).toBeUndefined()
    expect(data.switchUnavailable).toMatch(/slot 6's switched frame is out of range/)
  })

  it('names the switches that affect a set of chars', () => {
    const data = loadAnimationData(switchRom(), 0)!
    expect([...switchesForChars(data, [0x5d, 0xdb, 0x60])].sort()).toEqual(['onOff', 'silver'])
    expect(switchesForChars(data, [0x60, 0x48, 0x80]).size).toBe(0)
  })

  it('picks pixels per caller switch state', () => {
    const slot = at(switchRom(), 0x5c)
    const off = { blue: true, silver: false, onOff: true }
    expect(slotTiles(slot, off)[0]![0]).toBe(1)
    expect(slotTiles(slot, { ...off, silver: true })[0]![0]).toBe(2)
  })
})
