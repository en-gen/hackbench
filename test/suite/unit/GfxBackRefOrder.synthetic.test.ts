/**
 * LC_LZ2 back-reference byte order (#274). The Japanese and E1 builds carry
 * one extra XBA in CODE_00B966 (SMWDisX bank_00.asm:6383-6389), so their
 * back-references are little-endian. The decoder reads the order from the
 * ROM's own routine and the gate refuses a routine that is neither form.
 * The entry gate (#696) takes the JSR ReadByte operand from the entry itself
 * and accepts it only when the back-reference routine's own JSRs name the
 * same operand, so the real J, E0 and E1 operand sets are swept through
 * `readDecompressor` below. Those are synthetic fixtures built from the
 * SMWDisX sym operands; no J or E ROM is in the corpus.
 *
 * Synthetic cartridges only: every byte is built in the test or in
 * `syntheticGfxCart`, written from the 65816 encoding. No ROM needed.
 */
import { describe, it, expect } from 'vitest'
import { decompress, tryDecompress } from '../../../src/rom/LcLz2'
import { checkStockCompression, checkWritableCompression } from '../../../src/rom/GfxArena'
import { readGfxFile } from '../../../src/rom/GfxLoader'
import { readBackRefOrder, readDecompressor } from '../../../src/rom/GfxDecompressor'
import { RomFile } from '../../../src/rom/RomFile'
import { GfxTable, planGfxSave } from '../../../src/rom/GfxTable'
import { GfxRefusal, foldGfxRun, readGfxBase } from '../../../src/rom/GfxLayer'
import {
  BACKREF_AT,
  BACKREF_DISPATCH,
  backRefDispatch,
  backRefRoutine,
  buildCart,
  DECOMP_ENTRY,
  DISPATCH_AT,
  gfxStreams,
} from '../support/syntheticGfxCart'

// Three literals, then a 2-byte copy from output index 1: 10 20 30 20 30.
// The index is $0001 big-endian, $0100 little-endian, and the two are not
// interchangeable: the other reading points past the 3 bytes decoded so far.
const LITERALS = [0x10, 0x20, 0x30]
const EXPECTED = [0x10, 0x20, 0x30, 0x20, 0x30]
const stream = (addr: [number, number]): Uint8Array =>
  Uint8Array.from([0x02, ...LITERALS, 0x81, ...addr, 0xff])
const BE_STREAM = stream([0x00, 0x01])
const LE_STREAM = stream([0x01, 0x00])

function cartWith(order: 'be' | 'le', file0: Uint8Array) {
  const streams = gfxStreams()
  streams[0] = file0
  return buildCart({ streams, backRef: order }).rom
}

describe('decompress back-reference byte order', () => {
  it('reads the index big-endian by default, as the US ROM does', () => {
    expect([...decompress(BE_STREAM)]).toEqual(EXPECTED)
  })

  it('reads the index little-endian when told to', () => {
    expect([...decompress(LE_STREAM, 0, undefined, undefined, undefined, 'le')]).toEqual(EXPECTED)
  })

  it('refuses the stream in the other order rather than decoding garbage', () => {
    expect(tryDecompress(LE_STREAM).ok).toBe(false)
    expect(tryDecompress(BE_STREAM, { order: 'le' }).ok).toBe(false)
  })
})

describe('the decompressor gate reads the back-reference routine', () => {
  it('reports big-endian for the stock routine and little-endian for the XBA form', () => {
    const be = checkStockCompression(buildCart({ backRef: 'be' }).rom)
    const le = checkStockCompression(buildCart({ backRef: 'le' }).rom)
    expect(be.ok && be.order).toBe('be')
    expect(le.ok && le.order).toBe('le')
  })

  it('decodes a big-endian ROM big-endian: the stream with its index swapped is refused', () => {
    const rom = cartWith('be', BE_STREAM)
    const r = readGfxFile(rom, 0)
    expect(r.ok && [...r.bytes]).toEqual(EXPECTED)
    expect(readGfxFile(cartWith('be', LE_STREAM), 0).ok).toBe(false)
  })

  it('decodes a little-endian ROM little-endian, and refuses the big-endian stream', () => {
    const r = readGfxFile(cartWith('le', LE_STREAM), 0)
    expect(r.ok && [...r.bytes]).toEqual(EXPECTED)
    expect(readGfxFile(cartWith('le', BE_STREAM), 0).ok).toBe(false)
  })

  it('refuses a routine that is neither form, and names the back-reference', () => {
    const wrong = backRefRoutine('be')
    wrong[3] = 0xea // NOP where the XBA belongs
    const r = checkStockCompression(buildCart({ backRef: wrong }).rom)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/back-reference routine/)
    expect(readGfxFile(buildCart({ backRef: wrong }).rom, 0).ok).toBe(false)
  })

  it('refuses a planted defect at every byte of either form', () => {
    const survived: string[] = []
    for (const order of ['be', 'le'] as const) {
      const clean = backRefRoutine(order)
      for (let i = 0; i < clean.length; i++) {
        const routine = [...clean]
        routine[i] = (routine[i]! + 1) & 0xff
        if (checkStockCompression(buildCart({ backRef: routine }).rom).ok)
          survived.push(`${order}@${i}`)
      }
    }
    expect(survived).toEqual([])
  })

  it('refuses when the dispatch that reaches the routine is not PLA / BEQ / BMI', () => {
    const survived: number[] = []
    for (const i of [0, 1, 2, 3, 4]) {
      const rom = buildCart().rom
      const bytes = [...BACKREF_DISPATCH]
      bytes[i] = (bytes[i]! + 1) & 0xff
      rom.writeAt(DECOMP_ENTRY + DISPATCH_AT, bytes)
      if (checkStockCompression(rom).ok) survived.push(i)
    }
    expect(survived).toEqual([])
  })

  it('finds the routine through the BMI, not at a fixed address', () => {
    // Relocate the routine 4 bytes on and repoint the BMI: still accepted, so
    // the gate follows the branch. Left at the old spot it would be refused.
    const rom = buildCart({ backRef: backRefRoutine('le') }).rom
    rom.writeAt(DECOMP_ENTRY + BACKREF_AT, new Array(40).fill(0))
    rom.writeAt(DECOMP_ENTRY + BACKREF_AT + 4, backRefRoutine('le'))
    expect(checkStockCompression(rom).ok).toBe(false)
    rom.writeAt(DECOMP_ENTRY + DISPATCH_AT + 4, [BACKREF_AT + 4 - DISPATCH_AT - 5])
    const r = checkStockCompression(rom)
    expect(r.ok && r.order).toBe('le')
  })

  it('follows a negative BMI offset to a routine placed before the dispatch', () => {
    // The offset is a signed byte: a negative one reaches back, and read as unsigned it would
    // point 200 bytes forward.
    const at = DISPATCH_AT - 40
    const rom = buildCart({ backRef: backRefRoutine('le') }).rom
    rom.writeAt(DECOMP_ENTRY + at, backRefRoutine('le'))
    rom.writeAt(DECOMP_ENTRY + DISPATCH_AT + 4, [(at - DISPATCH_AT - 5) & 0xff])
    const r = checkStockCompression(rom)
    expect(r.ok && r.order).toBe('le')
  })

  it('lets a little-endian ROM be read but not written', () => {
    const be = checkWritableCompression(buildCart({ backRef: 'be' }).rom)
    const le = checkWritableCompression(buildCart({ backRef: 'le' }).rom)
    expect(be.ok).toBe(true)
    expect(le.ok).toBe(false)
    if (!le.ok) expect(le.reason).toMatch(/little-endian/)
  })
})

// Entry, ReadByte, CODE_00B966 and the loop head CODE_00B8E3 from SMWDisX's SMW_*.sym files.
const BUILDS = [
  ['US', 0xb8de, 0xb983, 0xb8e3, 'be'],
  ['E0', 0xb8f1, 0xb996, 0xb8f6, 'be'],
  ['J', 0xb87e, 0xb924, 0xb883, 'le'],
  ['E1', 0xb8f1, 0xb997, 0xb8f6, 'le'],
] as const

describe('readBackRefOrder on the real J, E0 and E1 layouts', () => {
  function planted(entry: number, readByte: number, loop: number, order: 'be' | 'le') {
    const buf = Buffer.alloc(0x10000, 0)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('layout.sfc', buf)
    // entry: REP #$10 / LDY #0 / JSR ReadByte, as that build lays it out
    rom.writeAt(entry, [0xc2, 0x10, 0xa0, 0x00, 0x00, 0x20, readByte & 0xff, readByte >> 8])
    rom.writeAt(entry + DISPATCH_AT, backRefDispatch(BACKREF_AT))
    rom.writeAt(entry + BACKREF_AT, backRefRoutine(order, readByte, loop))
    return rom
  }

  it.each(BUILDS)(
    '%s: reads %s operands and reports the order its routine has',
    (_n, entry, rb, loop, order) => {
      expect(readBackRefOrder(planted(entry, rb, loop, order), entry)).toBe(order)
    },
  )

  it('refuses a routine whose JSR or JMP operand is not the entry-derived one', () => {
    // J's routine behind a US entry: the operands name J's ReadByte, not this entry's.
    const rom = planted(0xb8de, 0xb983, 0xb8e3, 'le')
    rom.writeAt(0xb8de + BACKREF_AT, backRefRoutine('le', 0xb924, 0xb8e3))
    expect(readBackRefOrder(rom, 0xb8de)).toBeNull()
    rom.writeAt(0xb8de + BACKREF_AT, backRefRoutine('le', 0xb983, 0xb883))
    expect(readBackRefOrder(rom, 0xb8de)).toBeNull()
  })
})

describe('a little-endian ROM through the readers and writers', () => {
  const leCart = () => {
    const streams = gfxStreams()
    streams[0] = LE_STREAM
    return buildCart({ streams, backRef: 'le' })
  }

  it('GfxTable.load decodes the file little-endian, and a big-endian cart does not', () => {
    expect([...GfxTable.load(leCart().rom).files[0]!.bytes]).toEqual(EXPECTED)
    const streams = gfxStreams()
    streams[0] = LE_STREAM
    expect(GfxTable.load(buildCart({ streams }).rom).files[0]!.bytes.length).toBe(0)
  })

  it('planGfxSave refuses it, saying the order', () => {
    const { rom } = leCart()
    const r = planGfxSave(rom, GfxTable.load(rom))
    expect(r.status).toBe('unavailable')
    if (r.status === 'unavailable') expect(r.reason).toMatch(/little-endian/)
  })

  it('foldGfxRun refuses it and leaves the buffer untouched', () => {
    const { rom } = leCart()
    const out = new Uint8Array(rom.buffer)
    const before = new Uint8Array(out)
    expect(() => foldGfxRun(out, false, readGfxBase(before), [])).toThrow(GfxRefusal)
    expect(out).toEqual(before)
  })
})

// The entry gate itself (#696). Fixtures are built from the SMWDisX SMW_*.sym operands.
describe('readDecompressor accepts each real build and refuses a mismatched entry', () => {
  function entryRom(entry: number, readByte: number, loop: number, order: 'be' | 'le') {
    const buf = Buffer.alloc(0x10000, 0)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('layout.sfc', buf)
    rom.writeAt(entry, [0xc2, 0x10, 0xa0, 0x00, 0x00, 0x20, readByte & 0xff, readByte >> 8])
    rom.writeAt(entry + 8, [0xc9, 0xff])
    rom.writeAt(entry + DISPATCH_AT, backRefDispatch(BACKREF_AT))
    rom.writeAt(entry + BACKREF_AT, backRefRoutine(order, readByte, loop))
    return rom
  }

  it.each(BUILDS)('%s: accepted as stock with the order its routine has', (_n, e, rb, loop, o) => {
    const d = readDecompressor(entryRom(e, rb, loop, o), e)
    expect(d.ok && d.kind).toBe('stock')
    expect(d.ok && d.order).toBe(o)
  })

  it('refuses any other opcode at entry+5', () => {
    const survived: number[] = []
    for (const op of [0x22, 0x4c, 0xea, 0x60, 0x00, 0x21]) {
      const rom = entryRom(0xb8de, 0xb983, 0xb8e3, 'be')
      rom.writeAt(0xb8de + 5, [op])
      if (readDecompressor(rom, 0xb8de).ok) survived.push(op)
      expect(readBackRefOrder(rom, 0xb8de)).toBeNull()
    }
    expect(survived).toEqual([])
  })

  it('refuses a CMP that is not CMP #$FF', () => {
    for (const [i, v] of [
      [8, 0xc8],
      [9, 0xfe],
    ] as const) {
      const rom = entryRom(0xb8de, 0xb983, 0xb8e3, 'be')
      rom.writeAt(0xb8de + i, [v])
      expect(readDecompressor(rom, 0xb8de).ok).toBe(false)
    }
  })

  it('refuses an entry operand that disagrees with the routine, in either byte', () => {
    for (const rb of [0xb924, 0xb883, 0xb984]) {
      const rom = entryRom(0xb8de, 0xb983, 0xb8e3, 'be')
      rom.writeAt(0xb8de + 6, [rb & 0xff, rb >> 8])
      expect(readDecompressor(rom, 0xb8de).ok).toBe(false)
    }
  })

  it('refuses when the back-reference routine is missing', () => {
    const rom = entryRom(0xb87e, 0xb924, 0xb883, 'le')
    rom.writeAt(0xb87e + BACKREF_AT, new Array(40).fill(0))
    const d = readDecompressor(rom, 0xb87e)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toMatch(/back-reference routine/)
  })
})
