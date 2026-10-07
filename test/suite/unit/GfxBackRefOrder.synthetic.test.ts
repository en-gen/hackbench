/**
 * LC_LZ2 back-reference byte order (#274). The Japanese and E1 builds carry
 * one extra XBA in CODE_00B966 (SMWDisX bank_00.asm:6383-6389), so their
 * back-references are little-endian. The decoder reads the order from the
 * ROM's own routine and the gate refuses a routine that is neither form.
 *
 * Synthetic cartridges only: every byte is built in the test or in
 * `syntheticGfxCart`, written from the 65816 encoding. No ROM needed.
 */
import { describe, it, expect } from 'vitest'
import { decompress, tryDecompress } from '../../../src/rom/LcLz2'
import { checkStockCompression, checkWritableCompression } from '../../../src/rom/GfxArena'
import { readGfxFile } from '../../../src/rom/GfxLoader'
import {
  BACKREF_AT,
  BACKREF_DISPATCH,
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
    for (const i of [0, 1, 3, 4]) {
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
    const rom = buildCart({ backRef: 'le' }).rom
    rom.writeAt(DECOMP_ENTRY + BACKREF_AT, new Array(40).fill(0))
    rom.writeAt(DECOMP_ENTRY + BACKREF_AT + 4, backRefRoutine('le'))
    expect(checkStockCompression(rom).ok).toBe(false)
    rom.writeAt(DECOMP_ENTRY + DISPATCH_AT + 4, [BACKREF_AT + 4 - DISPATCH_AT - 5])
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
