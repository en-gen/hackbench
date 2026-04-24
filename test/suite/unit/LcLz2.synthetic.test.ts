/**
 * LC_LZ2 decompressor — synthetic byte-vector tests.
 *
 * These vectors are hand-crafted from the LC_LZ2 header encoding
 * (see src/rom/LcLz2.ts) to exercise every command type and several
 * edge cases. **None of these bytes come from any Super Mario World
 * ROM or derived resource.** They are original test inputs authored
 * for this project, so the tests run in CI without any dependency on
 * copyrighted material.
 *
 * Header byte format (recap):
 *   CCCLLLLL                  — cmd in bits 7–5, (len-1) in bits 4–0
 *   111CC LLL + 8 bits        — extended header: real cmd in bits 4–2,
 *                               real (len-1) in bits 1–0 + next byte (10-bit length)
 *
 * Commands in SMW:
 *   0 = direct copy (literals)
 *   1 = byte fill
 *   2 = word fill (alternating two bytes)
 *   3 = increasing fill
 *   4 = back-reference (2-byte big-endian index into output so far)
 *   7 = extended-header escape (for lengths > 32)
 *
 * Stream terminator: 0xFF.
 */

import { describe, it, expect } from 'vitest'
import { decompress } from '../../../src/rom/LcLz2'

// Helper: build a command header byte for non-extended commands.
//   cmd in 0..6, lenMinusOne in 0..31
const hdr = (cmd: number, lenMinusOne: number): number => ((cmd & 7) << 5) | (lenMinusOne & 0x1F)

// Helper: build a two-byte extended header for a real command and length.
//   realCmd in 0..6, length in 1..1024
const hdrExt = (realCmd: number, length: number): [number, number] => {
  const lm1 = (length - 1) & 0x3FF
  const byte0 = 0b1110_0000 | ((realCmd & 7) << 2) | ((lm1 >> 8) & 3)
  const byte1 = lm1 & 0xFF
  return [byte0, byte1]
}

const FF = 0xFF

const toBytes = (arr: number[]): Uint8Array => Uint8Array.from(arr)
const toArr   = (u: Uint8Array): number[] => Array.from(u)

describe('LC_LZ2 decompress — synthetic vectors', () => {
  it('empty stream (immediate terminator) produces empty output', () => {
    expect(toArr(decompress(toBytes([FF])))).toEqual([])
  })

  it('cmd 0 (direct copy): 3 literals', () => {
    // hdr(0, 2) = length 3; literals 0xAA 0xBB 0xCC; terminator
    const input = toBytes([hdr(0, 2), 0xAA, 0xBB, 0xCC, FF])
    expect(toArr(decompress(input))).toEqual([0xAA, 0xBB, 0xCC])
  })

  it('cmd 1 (byte fill): 5 copies of 0x7F', () => {
    const input = toBytes([hdr(1, 4), 0x7F, FF])
    expect(toArr(decompress(input))).toEqual([0x7F, 0x7F, 0x7F, 0x7F, 0x7F])
  })

  it('cmd 2 (word fill): 6 bytes alternating 0x12 0x34', () => {
    const input = toBytes([hdr(2, 5), 0x12, 0x34, FF])
    expect(toArr(decompress(input))).toEqual([0x12, 0x34, 0x12, 0x34, 0x12, 0x34])
  })

  it('cmd 2 (word fill): odd length stops mid-pair cleanly', () => {
    // length 5: write [b0, b1, b0, b1, b0]
    const input = toBytes([hdr(2, 4), 0xAB, 0xCD, FF])
    expect(toArr(decompress(input))).toEqual([0xAB, 0xCD, 0xAB, 0xCD, 0xAB])
  })

  it('cmd 3 (increasing fill): 4 bytes starting at 0x10', () => {
    const input = toBytes([hdr(3, 3), 0x10, FF])
    expect(toArr(decompress(input))).toEqual([0x10, 0x11, 0x12, 0x13])
  })

  it('cmd 3 wraps around at byte boundary', () => {
    // start at 0xFE, length 4 → [0xFE, 0xFF, 0x00, 0x01]
    const input = toBytes([hdr(3, 3), 0xFE, FF])
    expect(toArr(decompress(input))).toEqual([0xFE, 0xFF, 0x00, 0x01])
  })

  it('cmd 4 (back-reference): copy earlier bytes using 2-byte big-endian index', () => {
    // First write 4 literal bytes, then copy 3 bytes starting at output position 1.
    // Layout: [cmd0 len4][A B C D] then [cmd4 len3][hi=0x00, lo=0x01] → copies B,C,D
    const input = toBytes([
      hdr(0, 3), 0xA1, 0xA2, 0xA3, 0xA4,
      hdr(4, 2), 0x00, 0x01,
      FF,
    ])
    expect(toArr(decompress(input))).toEqual([0xA1, 0xA2, 0xA3, 0xA4, 0xA2, 0xA3, 0xA4])
  })

  it('cmd 4 referencing position 0 behaves like a forward copy of the first bytes', () => {
    const input = toBytes([
      hdr(0, 2), 0xDE, 0xAD, 0xBE,
      hdr(4, 2), 0x00, 0x00,        // copy 3 bytes starting at output index 0
      FF,
    ])
    expect(toArr(decompress(input))).toEqual([0xDE, 0xAD, 0xBE, 0xDE, 0xAD, 0xBE])
  })

  it('extended header: cmd 0 with length > 32 (literals, length 100)', () => {
    const literals = Array.from({ length: 100 }, (_, k) => k & 0xFF)
    const input = toBytes([...hdrExt(0, 100), ...literals, FF])
    expect(toArr(decompress(input))).toEqual(literals)
  })

  it('extended header: cmd 1 byte-fill for length 500', () => {
    const input = toBytes([...hdrExt(1, 500), 0x42, FF])
    const out   = decompress(input)
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
      hdr(0, 1), 0xAA, 0xBB,              // literals → [AA BB]
      hdr(1, 2), 0x55,                    // 3 × 0x55 → [AA BB 55 55 55]
      hdr(2, 3), 0xC0, 0xD0,              // 4 alternating → [AA BB 55 55 55 C0 D0 C0 D0]
      hdr(4, 1), 0x00, 0x00,              // copy 2 starting at idx 0 → [...AA BB]
      FF,
    ])
    expect(toArr(decompress(input))).toEqual([
      0xAA, 0xBB, 0x55, 0x55, 0x55, 0xC0, 0xD0, 0xC0, 0xD0, 0xAA, 0xBB,
    ])
  })

  it('decompress honors srcOffset: ignores garbage before the stream', () => {
    const input = toBytes([0x00, 0x00, 0x00, hdr(0, 1), 0x11, 0x22, FF])
    expect(toArr(decompress(input, 3))).toEqual([0x11, 0x22])
  })

  it('terminator byte can appear as payload data without ending the stream', () => {
    // A literal run writing 0xFF-valued bytes must NOT terminate early.
    const input = toBytes([hdr(1, 2), 0xFF, FF])   // 3 × 0xFF, then terminator
    expect(toArr(decompress(input))).toEqual([0xFF, 0xFF, 0xFF])
  })
})

describe('LC_LZ2 decompress — unused commands and edge cases', () => {
  // Commands 5 and 6 are not used by SMW. The decoder hits the
  // `default: break` branch and produces no output for that command.

  it('command 5 (0xA0 header) is silently skipped — no output, no throw', () => {
    // 0xA0 → cmd=(0xA0>>5)&7=5, len=(0xA0&0x1F)+1=1; default: break; 0xFF terminates
    expect(() => decompress(toBytes([0xA0, FF]))).not.toThrow()
    expect(toArr(decompress(toBytes([0xA0, FF])))).toEqual([])
  })

  it('command 6 (0xC0 header) is silently skipped — no output, no throw', () => {
    // 0xC0 → cmd=6, len=1; default: break
    expect(() => decompress(toBytes([0xC0, FF]))).not.toThrow()
    expect(toArr(decompress(toBytes([0xC0, FF])))).toEqual([])
  })

  it('command 5 followed by a real command: real command still executes', () => {
    // cmd 5 (no-op), then cmd 1 byte-fill 2 × 0xAA
    const input = toBytes([0xA0, hdr(1, 1), 0xAA, FF])
    expect(toArr(decompress(input))).toEqual([0xAA, 0xAA])
  })

  it('extended header (cmd 7) with no ext byte terminates gracefully', () => {
    // 0xE0 → cmd=7; i advances past header but ext byte is missing → break
    expect(() => decompress(toBytes([0xE0]))).not.toThrow()
    expect(toArr(decompress(toBytes([0xE0])))).toEqual([])
  })

  it('word fill (cmd 2) with only one fill byte available is skipped', () => {
    // 0x40 → cmd=2, len=1; needs 2 fill bytes but only 1 remains → break
    expect(toArr(decompress(toBytes([0x40, 0xAA])))).toEqual([])
  })

  it('back-reference beyond current write position produces zeros', () => {
    // Write 1 byte (0xAA) via byte-fill, then back-ref addr=5 (beyond) len=2 → zeros
    // hdr(1,0) = cmd1 len1; 0x81 = cmd4 len2
    const input = toBytes([hdr(1, 0), 0xAA, 0x81, 0x00, 0x05, FF])
    const result = toArr(decompress(input))
    expect(result[0]).toBe(0xAA)
    expect(result[1]).toBe(0)
    expect(result[2]).toBe(0)
  })

  it('initialBuffer: back-reference reads pre-filled data before write position', () => {
    // No bytes written yet (wp=0). initialBuffer=[0xAA, 0xBB].
    // back-ref addr=0 len=2 → reads initialBuffer[0] and [1].
    // 0x81 → cmd=(0x81>>5)&7=4, len=(0x81&0x1F)+1=2
    const init = new Uint8Array([0xAA, 0xBB])
    const result = toArr(decompress(toBytes([0x81, 0x00, 0x00, FF]), 0, init))
    expect(result[0]).toBe(0xAA)
    expect(result[1]).toBe(0xBB)
  })

  it('initialBuffer: data beyond initialBuffer length still produces zeros', () => {
    // initialBuffer=[0x55]; back-ref addr=1 (just outside) len=1 → 0
    const init = new Uint8Array([0x55])
    const result = toArr(decompress(toBytes([0x80, 0x00, 0x01, FF]), 0, init))
    // 0x80 → cmd=4, len=1; addr=0x0001; 0+1=1 >= out.length(1) → writeByte(0)
    expect(result[0]).toBe(0)
  })
})
