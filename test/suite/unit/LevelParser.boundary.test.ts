/**
 * LevelParser - boundary-case + lesser-tested function tests.
 *
 * Existing LevelParser.test.ts covers header, objects, sprites, and the
 * vertical-level swap. This file adds:
 *   - screen-exit objects (extended, settings byte == 0; reads an extra byte)
 *   - parseL2Objects (horizontal + vertical)
 *   - parseLevelScreenExits (LM-extended trailer)
 *   - getObjectStreamLength / getSpriteStreamLength
 *   - isLevelModeVerticalL2 (the L2 verticality bit)
 *   - truncation safety (data ends mid-object).
 */

import { describe, it, expect } from 'vitest'
import {
  parseLevelObjects,
  parseL2Objects,
  parseLevelScreenExits,
  getObjectStreamLength,
  getSpriteStreamLength,
  isLevelModeVerticalL2,
} from '../../../src/rom/LevelParser'

const ZERO_HEADER: [number, number, number, number, number] = [0, 0, 0, 0, 0]
const makeLevel = (header: [number, number, number, number, number], body: number[]): Buffer =>
  Buffer.from([...header, ...body, 0xff])

// ── isLevelModeVerticalL2 ────────────────────────────────────────────────────

describe('isLevelModeVerticalL2', () => {
  it('matches VerticalTable bit-1 entries (modes where L2 is vertical)', () => {
    // Per the table in LevelParser.ts: modes 5 ($02), 6 ($82), 7 ($03), 8 ($83)
    // have bit 1 set → L2 vertical.
    const expected = new Set([5, 6, 7, 8])
    for (let m = 0; m < 32; m++) {
      expect(isLevelModeVerticalL2(m)).toBe(expected.has(m))
    }
  })

  it('mask handles values >= 32 by AND $1F', () => {
    expect(isLevelModeVerticalL2(0x25)).toBe(isLevelModeVerticalL2(0x05))
  })
})

// ── Screen-exit objects in parseLevelObjects ─────────────────────────────────

describe('parseLevelObjects - screen-exit objects (ext, settings == 0)', () => {
  it('records primary exit destination from the extra byte (no high bit)', () => {
    // Ext object (objNum=0), settings=0, then 1 extra byte = destination level lo
    // b1 = 0 → highBit=0, secondaryFlag=0 (primary)
    // extra = $42 → screenExitDest = $042
    const buf = makeLevel(ZERO_HEADER, [0x00, 0x00, 0x00, 0x42])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(1)
    expect(objects[0].type).toBe('extended')
    expect(objects[0].screenExitDest).toBe(0x042)
    expect(objects[0].screenExitIsSecondary).toBe(false)
  })

  it('combines b1 bit 0 as the destination high bit (cross-bank exit)', () => {
    // b1 = 0x01 → highBit = 1, secondaryFlag = 0
    // extra = $35 → dest = $135
    const buf = makeLevel(ZERO_HEADER, [0x00, 0x01, 0x00, 0x35])
    const { objects } = parseLevelObjects(buf)
    expect(objects[0].screenExitDest).toBe(0x135)
    expect(objects[0].screenExitIsSecondary).toBe(false)
  })

  it('marks secondary exit when b1 >> 1 != 0', () => {
    // b1 = 0x02 → highBit=0, secondary flag=1 (exit is index into DATA_05F800)
    const buf = makeLevel(ZERO_HEADER, [0x00, 0x02, 0x00, 0x10])
    const { objects } = parseLevelObjects(buf)
    expect(objects[0].screenExitDest).toBe(0x010)
    expect(objects[0].screenExitIsSecondary).toBe(true)
  })

  it('does NOT consume an extra byte for a non-screen-exit extended object', () => {
    // Ext but settings != 0 → no extra byte
    const buf = makeLevel(ZERO_HEADER, [0x00, 0x00, 0x12, 0x00, 0x10, 0x00])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(2)
    expect(objects[0].screenExitDest).toBeUndefined()
    expect(objects[1].objectNumber).toBe(1) // second object parsed correctly
  })

  it('skips the extra-byte read when the stream ends exactly at the exit object', () => {
    // 5-byte header + 3-byte ext-exit, total 8 bytes. After parsing the object,
    // pos === data.length → the `pos < data.length` guard prevents over-read.
    const buf = Buffer.from([0, 0, 0, 0, 0, 0x00, 0x00, 0x00])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(1)
    expect(objects[0].screenExitDest).toBeUndefined()
  })
})

// ── parseLevelObjects - truncation safety ─────────────────────────────────────

describe('parseLevelObjects - truncation safety', () => {
  it('stops cleanly when only 2 bytes are available after the header', () => {
    // header (5) + 2 partial bytes; no terminator.
    const buf = Buffer.from([0, 0, 0, 0, 0, 0x00, 0x10])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(0)
  })

  it('returns immediately when the byte right after the header is undefined', () => {
    // 5-byte buffer = pure header, no object area. Loop condition pos < length
    // exits before reading b0.
    const { objects } = parseLevelObjects(Buffer.from([0, 0, 0, 0, 0]))
    expect(objects).toHaveLength(0)
  })
})

// ── parseL2Objects ───────────────────────────────────────────────────────────

describe('parseL2Objects', () => {
  it('horizontal: same byte format as L1, no header parsed', () => {
    // L2 stream: 5-byte "header" we discard, then a 3-byte normal object.
    // Object: $0A=0x03 (y=3), $0B=0x25 (objNum=2, x=5), $59=0x10
    const buf = Buffer.from([0, 0, 0, 0, 0, 0x03, 0x25, 0x10, 0xff])
    const objs = parseL2Objects(buf, 1, false)
    expect(objs).toHaveLength(1)
    expect(objs[0].x).toBe(5)
    expect(objs[0].y).toBe(3)
    expect(objs[0].objectNumber).toBe(2)
  })

  it('vertical: x = b0 low + (highCoord ? 16 : 0); y = screen*16 + b1 low', () => {
    // Same object encoding but vertical interpretation.
    const buf = Buffer.from([0, 0, 0, 0, 0, 0x15, 0x17, 0x00, 0xff])
    const objs = parseL2Objects(buf, 1, true)
    expect(objs[0].x).toBe(5 + 16) // highCoord set → right half
    expect(objs[0].y).toBe(7) // screen 0, low nibble of b1
  })

  it('honours the ext-$01 screen jump', () => {
    const buf = Buffer.from([
      0,
      0,
      0,
      0,
      0,
      0x00,
      0x10,
      0x00, // std on screen 0
      0x0a,
      0x00,
      0x01, // ext $01 → set screen to 0x0A
      0x00,
      0x10,
      0x00, // std on screen 10
      0xff,
    ])
    const objs = parseL2Objects(buf, 16, false)
    expect(objs).toHaveLength(3)
    expect(objs[2].screen).toBe(10)
  })

  it('stops at $FF terminator and on truncation', () => {
    // Truncated 2 bytes at end (no third byte for the next object).
    const buf = Buffer.from([0, 0, 0, 0, 0, 0x00, 0x10])
    expect(parseL2Objects(buf, 0, false)).toHaveLength(0)
  })
})

// ── parseLevelScreenExits (LM trailer) ───────────────────────────────────────

describe('parseLevelScreenExits', () => {
  it('reads 2 bytes per screen after the object-stream $FF terminator', () => {
    // Header (5) + 1 object (3) + $FF + 2 screens × 2 bytes
    // Screen 0 exit: lo=$30, hi=$01 → bit 0 of hi = 1 → dest = $130
    // Screen 1 exit: lo=$10, hi=$00 → dest = $010
    const buf = Buffer.from([0, 0, 0, 0, 0, 0x00, 0x10, 0x00, 0xff, 0x30, 0x01, 0x10, 0x00])
    expect(parseLevelScreenExits(buf, 2)).toEqual([0x130, 0x010])
  })

  it('returns fewer entries than `screens` when data runs out', () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0xff, 0x42, 0x00])
    expect(parseLevelScreenExits(buf, 5)).toEqual([0x042])
  })

  it('returns an empty array when no $FF terminator is found', () => {
    // Object byte stream never terminates; pos walks past the end.
    const buf = Buffer.from([0, 0, 0, 0, 0, 0x00, 0x10, 0x00])
    expect(parseLevelScreenExits(buf, 4)).toEqual([])
  })
})

// ── getObjectStreamLength ────────────────────────────────────────────────────

describe('getObjectStreamLength', () => {
  it('returns header(5) + objects(3) + terminator(1) for a normal stream', () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0x00, 0x10, 0x00, 0xff])
    expect(getObjectStreamLength(buf, true)).toBe(9)
  })

  it('counts the extra byte for screen-exit ext objects', () => {
    // hasHeader=false → starts at byte 0
    // ext-exit: 3 + 1 (extra) = 4 bytes, then $FF
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x42, 0xff])
    expect(getObjectStreamLength(buf, false)).toBe(5)
  })

  it('returns total length when no $FF terminator is present', () => {
    const buf = Buffer.from([0x00, 0x10, 0x00])
    expect(getObjectStreamLength(buf, false)).toBe(3)
  })

  it('stops cleanly on a partial trailing object (pos+2 >= length)', () => {
    // Two bytes after the header - not enough for a 3-byte object.
    const buf = Buffer.from([0, 0, 0, 0, 0, 0x00, 0x10])
    expect(getObjectStreamLength(buf, true)).toBe(5)
  })
})

// ── getSpriteStreamLength ────────────────────────────────────────────────────

describe('getSpriteStreamLength', () => {
  it('returns 1 (header) + 3*N + 1 ($FF) for valid sprite streams', () => {
    // Header(1) + 1 sprite(3) + $FF
    const buf = Buffer.from([0x00, 0x40, 0xa0, 0x0e, 0xff])
    expect(getSpriteStreamLength(buf)).toBe(5)
  })

  it('returns full length when no terminator is found', () => {
    const buf = Buffer.from([0x00, 0x40, 0xa0, 0x0e])
    expect(getSpriteStreamLength(buf)).toBe(4)
  })

  it('returns 1 for header-only input', () => {
    expect(getSpriteStreamLength(Buffer.from([0x00]))).toBe(1)
  })
})
