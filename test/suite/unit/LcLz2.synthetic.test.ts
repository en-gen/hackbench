/**
 * LC_LZ2 decompressor - synthetic byte-vector tests.
 *
 * These vectors are hand-crafted from the LC_LZ2 header encoding
 * (see src/rom/LcLz2.ts) to exercise every command type and several
 * edge cases. **None of these bytes come from any Super Mario World
 * ROM or derived resource.** They are original test inputs authored
 * for this project, so the tests run in CI without any dependency on
 * copyrighted material.
 *
 * Header byte format (recap):
 *   CCCLLLLL                  - cmd in bits 7–5, (len-1) in bits 4–0
 *   111CC LLL + 8 bits        - extended header: real cmd in bits 4–2,
 *                               real (len-1) in bits 1–0 + next byte (10-bit length)
 *
 * Commands in SMW:
 *   0 = direct copy (literals)
 *   1 = byte fill
 *   2 = word fill (alternating two bytes)
 *   3 = increasing fill
 *   4 = back-reference (2-byte big-endian index into output so far)
 *   5, 6, and extended-7's real command = decode as command 4 (see LcLz2.ts)
 *   7 = extended-header escape (for lengths > 32)
 *
 * Stream terminator: 0xFF. A stream that ends without one, a back-reference
 * past what has been decoded, or output past the caller's cap all throw.
 */

import { describe, it, expect } from 'vitest'
import { decompress, MAX_OUTPUT } from '../../../src/rom/LcLz2'

// Helper: build a command header byte for non-extended commands.
//   cmd in 0..6, lenMinusOne in 0..31
const hdr = (cmd: number, lenMinusOne: number): number => ((cmd & 7) << 5) | (lenMinusOne & 0x1f)

// Helper: build a two-byte extended header for a real command and length.
//   realCmd in 0..6, length in 1..1024
const hdrExt = (realCmd: number, length: number): [number, number] => {
  const lm1 = (length - 1) & 0x3ff
  const byte0 = 0b1110_0000 | ((realCmd & 7) << 2) | ((lm1 >> 8) & 3)
  const byte1 = lm1 & 0xff
  return [byte0, byte1]
}

const FF = 0xff

const toBytes = (arr: number[]): Uint8Array => Uint8Array.from(arr)
const toArr = (u: Uint8Array): number[] => Array.from(u)

describe('LC_LZ2 decompress - synthetic vectors', () => {
  it('empty stream (immediate terminator) produces empty output', () => {
    expect(toArr(decompress(toBytes([FF])))).toEqual([])
  })

  it('cmd 0 (direct copy): 3 literals', () => {
    // hdr(0, 2) = length 3; literals 0xAA 0xBB 0xCC; terminator
    const input = toBytes([hdr(0, 2), 0xaa, 0xbb, 0xcc, FF])
    expect(toArr(decompress(input))).toEqual([0xaa, 0xbb, 0xcc])
  })

  it('cmd 1 (byte fill): 5 copies of 0x7F', () => {
    const input = toBytes([hdr(1, 4), 0x7f, FF])
    expect(toArr(decompress(input))).toEqual([0x7f, 0x7f, 0x7f, 0x7f, 0x7f])
  })

  it('cmd 2 (word fill): 6 bytes alternating 0x12 0x34', () => {
    const input = toBytes([hdr(2, 5), 0x12, 0x34, FF])
    expect(toArr(decompress(input))).toEqual([0x12, 0x34, 0x12, 0x34, 0x12, 0x34])
  })

  it('cmd 2 (word fill): odd length stops mid-pair cleanly', () => {
    // length 5: write [b0, b1, b0, b1, b0]
    const input = toBytes([hdr(2, 4), 0xab, 0xcd, FF])
    expect(toArr(decompress(input))).toEqual([0xab, 0xcd, 0xab, 0xcd, 0xab])
  })

  it('cmd 3 (increasing fill): 4 bytes starting at 0x10', () => {
    const input = toBytes([hdr(3, 3), 0x10, FF])
    expect(toArr(decompress(input))).toEqual([0x10, 0x11, 0x12, 0x13])
  })

  it('cmd 3 wraps around at byte boundary', () => {
    // start at 0xFE, length 4 → [0xFE, 0xFF, 0x00, 0x01]
    const input = toBytes([hdr(3, 3), 0xfe, FF])
    expect(toArr(decompress(input))).toEqual([0xfe, 0xff, 0x00, 0x01])
  })

  it('cmd 4 (back-reference): copy earlier bytes using 2-byte big-endian index', () => {
    // First write 4 literal bytes, then copy 3 bytes starting at output position 1.
    // Layout: [cmd0 len4][A B C D] then [cmd4 len3][hi=0x00, lo=0x01] → copies B,C,D
    const input = toBytes([hdr(0, 3), 0xa1, 0xa2, 0xa3, 0xa4, hdr(4, 2), 0x00, 0x01, FF])
    expect(toArr(decompress(input))).toEqual([0xa1, 0xa2, 0xa3, 0xa4, 0xa2, 0xa3, 0xa4])
  })

  it('cmd 4 referencing position 0 behaves like a forward copy of the first bytes', () => {
    const input = toBytes([
      hdr(0, 2),
      0xde,
      0xad,
      0xbe,
      hdr(4, 2),
      0x00,
      0x00, // copy 3 bytes starting at output index 0
      FF,
    ])
    expect(toArr(decompress(input))).toEqual([0xde, 0xad, 0xbe, 0xde, 0xad, 0xbe])
  })

  it('extended header: cmd 0 with length > 32 (literals, length 100)', () => {
    const literals = Array.from({ length: 100 }, (_, k) => k & 0xff)
    const input = toBytes([...hdrExt(0, 100), ...literals, FF])
    expect(toArr(decompress(input))).toEqual(literals)
  })

  it('extended header: cmd 1 byte-fill for length 500', () => {
    const input = toBytes([...hdrExt(1, 500), 0x42, FF])
    const out = decompress(input)
    expect(out.length).toBe(500)
    expect(out.every(b => b === 0x42)).toBe(true)
  })

  it('extended header: cmd 3 increasing fill for length 256 wraps two full times', () => {
    // start at 0, length 256 → values 0..255
    const out = decompress(toBytes([...hdrExt(3, 256), 0x00, FF]))
    expect(out.length).toBe(256)
    for (let i = 0; i < 256; i++) expect(out[i]).toBe(i)
  })

  it('extended header: max length 1024 works (boundary of 10-bit field)', () => {
    const out = decompress(toBytes([...hdrExt(1, 1024), 0x99, FF]))
    expect(out.length).toBe(1024)
    expect(out[0]).toBe(0x99)
    expect(out[1023]).toBe(0x99)
  })

  it('mixed stream: literals → byte fill → word fill → back-reference', () => {
    // out = [0xAA, 0xBB, 0x55, 0x55, 0x55, 0xC0, 0xD0, 0xC0, 0xD0, 0xAA, 0xBB]
    const input = toBytes([
      hdr(0, 1),
      0xaa,
      0xbb, // literals → [AA BB]
      hdr(1, 2),
      0x55, // 3 × 0x55 → [AA BB 55 55 55]
      hdr(2, 3),
      0xc0,
      0xd0, // 4 alternating → [AA BB 55 55 55 C0 D0 C0 D0]
      hdr(4, 1),
      0x00,
      0x00, // copy 2 starting at idx 0 → [...AA BB]
      FF,
    ])
    expect(toArr(decompress(input))).toEqual([
      0xaa, 0xbb, 0x55, 0x55, 0x55, 0xc0, 0xd0, 0xc0, 0xd0, 0xaa, 0xbb,
    ])
  })

  it('decompress honors srcOffset: ignores garbage before the stream', () => {
    const input = toBytes([0x00, 0x00, 0x00, hdr(0, 1), 0x11, 0x22, FF])
    expect(toArr(decompress(input, 3))).toEqual([0x11, 0x22])
  })

  it('terminator byte can appear as payload data without ending the stream', () => {
    // A literal run writing 0xFF-valued bytes must NOT terminate early.
    const input = toBytes([hdr(1, 2), 0xff, FF]) // 3 × 0xFF, then terminator
    expect(toArr(decompress(input))).toEqual([0xff, 0xff, 0xff])
  })
})

describe('LC_LZ2 decompress - commands 4-7 all decode as a back-reference', () => {
  // bank_00.asm:6329-6331 branches into the back-reference handler on the
  // command's sign bit, set for 4-7 alike, so all four read the same
  // operand shape: 2-byte big-endian index, copy `len` bytes. Command 4 is
  // the control row: it was never broken, so it must keep passing too.
  const backrefLayout = [0xa1, 0xa2, 0xa3, 0xa4] // written first via cmd 0
  const expected = [0xa1, 0xa2, 0xa3, 0xa4, 0xa2, 0xa3, 0xa4] // + 3 bytes from index 1

  it.each([
    ['4 (control)', [hdr(4, 2)]],
    ['5', [hdr(5, 2)]],
    ['6', [hdr(6, 2)]],
    ['extended 7', hdrExt(7, 3)],
  ])('command %s decodes as a back-reference', (_, header) => {
    const input = toBytes([hdr(0, 3), ...backrefLayout, ...header, 0x00, 0x01, FF])
    expect(toArr(decompress(input))).toEqual(expected)
  })
})

describe('LC_LZ2 decompress - refusals', () => {
  it('a stream that runs out before the terminator throws, naming the window it was given', () => {
    const input = toBytes([hdr(0, 2), 0xaa, 0xbb, 0xcc]) // no FF
    // The window is `input.length`, not some notion of "the ROM's stream":
    // the message must not blame the ROM for a slice the caller chose (#494).
    expect(() => decompress(input)).toThrow(/did not terminate within 4 bytes/i)
  })

  it('a stream that breaks off mid-command still names the whole window', () => {
    const input = toBytes([hdr(0, 5), 0xaa, 0xbb]) // direct copy of 6, only 2 present
    expect(() => decompress(input)).toThrow(/did not terminate within 3 bytes/i)
  })

  it('extended header with no ext byte throws', () => {
    expect(() => decompress(toBytes([0xe0]))).toThrow(/did not terminate/i)
  })

  it('word fill with only one fill byte available throws', () => {
    expect(() => decompress(toBytes([0x40, 0xaa]))).toThrow(/did not terminate/i)
  })

  it('the window is measured from srcOffset, not the whole buffer', () => {
    const input = toBytes([0x00, 0x00, hdr(0, 2), 0xaa, 0xbb, 0xcc]) // 2 leading bytes, no FF
    expect(() => decompress(input, 2)).toThrow(/did not terminate within 4 bytes/i)
  })

  it('a back-reference past the current write position throws', () => {
    // Write 1 byte via byte-fill, then back-ref addr=5 (beyond) len=2.
    const input = toBytes([hdr(1, 0), 0xaa, hdr(4, 1), 0x00, 0x05, FF])
    expect(() => decompress(input)).toThrow(/back-reference/i)
  })

  it('initialBuffer: back-reference reads pre-filled data before write position', () => {
    // No bytes written yet (wp=0). Reading inside initialBuffer's own length is valid.
    const init = new Uint8Array([0xaa, 0xbb])
    const result = toArr(decompress(toBytes([hdr(4, 1), 0x00, 0x00, FF]), 0, init))
    expect(result).toEqual([0xaa, 0xbb])
  })

  it('initialBuffer: a back-reference past the pre-filled data throws', () => {
    const init = new Uint8Array([0x55])
    const input = toBytes([hdr(4, 0), 0x00, 0x01, FF]) // addr=1, just outside init
    expect(() => decompress(input, 0, init)).toThrow(/back-reference/i)
  })

  it('output past the caller cap throws', () => {
    const input = toBytes([hdr(1, 4), 0xaa, FF]) // 5 bytes
    expect(() => decompress(input, 0, undefined, undefined, 4)).toThrow(/exceeds/i)
  })

  it('output landing exactly on the cap is not a refusal', () => {
    const input = toBytes([hdr(1, 3), 0xaa, FF]) // 4 bytes
    expect(toArr(decompress(input, 0, undefined, undefined, 4))).toEqual([0xaa, 0xaa, 0xaa, 0xaa])
  })

  it('the default cap is MAX_OUTPUT (one 64 KB bank), not unbounded', () => {
    // 64 extended byte-fills of 1024 bytes each = MAX_OUTPUT exactly.
    const fillBurst = (total: number, fillByte: number): number[] => {
      const out: number[] = []
      for (let left = total; left > 0; left -= 1024) {
        out.push(...hdrExt(1, Math.min(left, 1024)), fillByte)
      }
      return out
    }
    expect(decompress(toBytes([...fillBurst(MAX_OUTPUT, 0x11), FF])).length).toBe(MAX_OUTPUT)

    const oneOver = toBytes([...fillBurst(MAX_OUTPUT, 0x11), hdr(1, 0), 0x11, FF])
    expect(() => decompress(oneOver)).toThrow(/exceeds/i)
  })
})
