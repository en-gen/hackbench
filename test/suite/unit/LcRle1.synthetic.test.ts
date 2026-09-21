/**
 * LC_RLE1 decompressor - synthetic byte-vector tests.
 *
 * Port of CODE_058126 (bank_05.asm:159-240). Command format:
 *   FLLLLLLL  - F=0: LITERAL (emit (L+1) bytes from input)
 *               F=1: RLE    (emit next byte (L+1) times)
 * Terminator: two consecutive 0xFF at a command position.
 *
 * Key subtlety: a single 0xFF is NOT a terminator - it is a valid RLE
 * command (bit 7 set → RLE, length = (0x7F)+1 = 128). The terminator
 * check peeks two bytes; only FF FF ends the stream.
 *
 * None of these bytes come from any SMW ROM or derived resource. They
 * are original test inputs authored for this project.
 */

import { describe, it, expect } from 'vitest'
import { decompressRle1 } from '../../../src/rom/LcRle1'

const toBytes = (arr: number[]): Uint8Array => Uint8Array.from(arr)
const toArr = (u: Uint8Array): number[] => Array.from(u)

describe('LC_RLE1 - empty and terminator', () => {
  it('FF FF immediately terminates with empty output', () => {
    expect(toArr(decompressRle1(toBytes([0xff, 0xff])))).toEqual([])
  })

  it('empty buffer produces empty output', () => {
    expect(toArr(decompressRle1(toBytes([])))).toEqual([])
  })
})

describe('LC_RLE1 - LITERAL mode (F=0)', () => {
  it('cmd=0x00: literal length 1 - emits one byte', () => {
    // 0x00 → F=0, L=0 → length=1; payload: 0xAA; terminator: FF FF
    const out = decompressRle1(toBytes([0x00, 0xaa, 0xff, 0xff]))
    expect(toArr(out)).toEqual([0xaa])
  })

  it('cmd=0x02: literal length 3 - emits three bytes', () => {
    // 0x02 → length=3; payload: 0x11 0x22 0x33
    const out = decompressRle1(toBytes([0x02, 0x11, 0x22, 0x33, 0xff, 0xff]))
    expect(toArr(out)).toEqual([0x11, 0x22, 0x33])
  })

  it('cmd=0x7F: max literal length 128 - emits 128 bytes', () => {
    // 0x7F → F=0, L=0x7F → length=128
    const payload = Array.from({ length: 128 }, (_, i) => i & 0xff)
    const out = decompressRle1(toBytes([0x7f, ...payload, 0xff, 0xff]))
    expect(toArr(out)).toEqual(payload)
  })
})

describe('LC_RLE1 - RLE mode (F=1)', () => {
  it('cmd=0x80: RLE length 1 - emits one copy', () => {
    // 0x80 → F=1, L=0 → length=1; fill byte: 0xBB
    const out = decompressRle1(toBytes([0x80, 0xbb, 0xff, 0xff]))
    expect(toArr(out)).toEqual([0xbb])
  })

  it('cmd=0x84: RLE length 5 - emits five copies', () => {
    // 0x84 → F=1, L=4 → length=5
    const out = decompressRle1(toBytes([0x84, 0x42, 0xff, 0xff]))
    expect(toArr(out)).toEqual([0x42, 0x42, 0x42, 0x42, 0x42])
  })

  it('cmd=0xFF: single 0xFF is a valid RLE cmd (length 128), not a terminator', () => {
    // Single 0xFF: peek(0)=0xFF, peek(1)=0x55 ≠ 0xFF → NOT terminator.
    // Consume 0xFF as cmd: F=1, L=0x7F → length=128; fill byte=0x55.
    const out = decompressRle1(toBytes([0xff, 0x55, 0xff, 0xff]))
    expect(out.length).toBe(128)
    expect(out.every(b => b === 0x55)).toBe(true)
  })

  it('cmd=0xFF with fill byte 0xFF is also not a premature terminator', () => {
    // Sequence: [0xFF, 0xFF, 0xFF, 0xFF]
    // Peek(0)=FF, peek(1)=FF → terminator? Yes: FF FF at position 0.
    // Stream terminates with empty output.
    const out = decompressRle1(toBytes([0xff, 0xff, 0xff, 0xff]))
    expect(toArr(out)).toEqual([])
  })
})

describe('LC_RLE1 - multi-command streams', () => {
  it('literal then RLE then terminator', () => {
    // cmd=0x01 → literal 2 bytes [0xAA, 0xBB]
    // cmd=0x82 → RLE 3 × 0xCC
    // FF FF
    const out = decompressRle1(toBytes([0x01, 0xaa, 0xbb, 0x82, 0xcc, 0xff, 0xff]))
    expect(toArr(out)).toEqual([0xaa, 0xbb, 0xcc, 0xcc, 0xcc])
  })

  it('RLE then literal then terminator', () => {
    // cmd=0x81 → RLE 2 × 0x10; cmd=0x02 → literal 3 [0x20,0x30,0x40]
    const out = decompressRle1(toBytes([0x81, 0x10, 0x02, 0x20, 0x30, 0x40, 0xff, 0xff]))
    expect(toArr(out)).toEqual([0x10, 0x10, 0x20, 0x30, 0x40])
  })

  it('three RLE commands in sequence', () => {
    // 0x82 3×0x01, 0x83 4×0x02, 0x84 5×0x03
    const out = decompressRle1(toBytes([0x82, 0x01, 0x83, 0x02, 0x84, 0x03, 0xff, 0xff]))
    expect(toArr(out)).toEqual([
      0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x03,
    ])
  })

  it('RLE filling 0x00 bytes', () => {
    // Confirm zero bytes are written correctly (not skipped)
    const out = decompressRle1(toBytes([0x83, 0x00, 0xff, 0xff]))
    expect(toArr(out)).toEqual([0x00, 0x00, 0x00, 0x00])
  })
})

describe('LC_RLE1 - truncated / edge cases', () => {
  it('truncated literal payload emits only available bytes then stops', () => {
    // cmd=0x04 → literal 5 bytes; only 2 payload bytes before end of buffer
    const out = decompressRle1(toBytes([0x04, 0xaa, 0xbb]))
    expect(toArr(out)).toEqual([0xaa, 0xbb])
  })

  it('truncated RLE (fill byte missing) emits nothing for that command', () => {
    // cmd=0x82 → RLE 3×?; buffer ends before fill byte
    const out = decompressRle1(toBytes([0x82]))
    expect(toArr(out)).toEqual([])
  })

  it('buffer ending exactly at terminator emits prior data correctly', () => {
    // [0x00, 0x55, 0xFF, 0xFF]: literal 1×0x55 then terminator
    const out = decompressRle1(toBytes([0x00, 0x55, 0xff, 0xff]))
    expect(toArr(out)).toEqual([0x55])
  })

  it('RLE fill byte value 0xFF followed by FF FF terminator - does not mis-terminate inside payload', () => {
    // RLE cmd must have consumed fill byte before next command-position check.
    // cmd=0x81 → RLE 2×0xFF; then cmd=0x80 → RLE 1×0xAA; then FF FF
    const out = decompressRle1(toBytes([0x81, 0xff, 0x80, 0xaa, 0xff, 0xff]))
    expect(toArr(out)).toEqual([0xff, 0xff, 0xaa])
  })
})
