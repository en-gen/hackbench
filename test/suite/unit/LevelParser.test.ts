import { describe, it, expect } from 'vitest'
import { parseLevelObjects, parseLevelSprites } from '../../../src/rom/LevelParser'

/**
 * Build a minimal valid level buffer.
 * 5-byte primary header:
 *   byte0: BBBLLLLL (BG palette, level length)
 *   byte1: CCCOOOOO (BG color, level mode)
 *   byte2: 3MMMOOOO (L3 priority, music, level mode lo)
 *   byte3: TTPPSSSS (time limit, sprite palette, sprite set) — confirmed Mesen2
 *   byte4: IIVVZZZZ (item memory, V-scroll, bg type ID)
 * Followed by object bytes and 0xFF terminator.
 */
function makeLevel(
  header: [number, number, number, number, number],
  objectBytes: number[],
): Buffer {
  return Buffer.from([...header, ...objectBytes, 0xFF])
}

const ZERO_HEADER: [number, number, number, number, number] = [0, 0, 0, 0, 0]

describe('parseLevelObjects — header', () => {
  it('parses 5-byte header fields', () => {
    // byte0 = 0b101_01010 = 0xAA → bgPalette=5, levelLength=10
    // byte1 = 0b011_00110 = 0x66 → bgColor=3, levelMode=6
    // byte2 = 0b1_011_1000 = 0xB8 → layer3Priority=true, music=3, levelMode(lo)=8
    // byte3 = 0b10_01_1001 = 0x99 → timeLimit=2, spritePalette=1, spriteSet=9
    //   Confirmed layout (Mesen2 watchpoint): TTPPSSSS — NOT the old TTPPPFFF
    // byte4 = 0b01_10_0111 = 0x67 → itemMemory=1, verticalScroll=2, bgTypeId=7
    //   bgTypeId is a background type field, NOT the GFX tileset index (see getGfxTilesetId)
    const buf = makeLevel([0xAA, 0x66, 0xB8, 0x99, 0x67], [])
    const { header } = parseLevelObjects(buf)
    expect(header.raw).toEqual([0xAA, 0x66, 0xB8, 0x99, 0x67])
    expect(header.bgPalette).toBe(5)
    expect(header.levelLength).toBe(10)
    expect(header.bgColor).toBe(3)
    expect(header.levelMode).toBe(6)
    expect(header.layer3Priority).toBe(true)
    expect(header.music).toBe(3)
    expect(header.spriteSet).toBe(9)
    expect(header.timeLimit).toBe(2)
    expect(header.spritePalette).toBe(1)
    expect(header.itemMemory).toBe(1)
    expect(header.verticalScroll).toBe(2)
    expect(header.bgTypeId).toBe(7)
  })
})

describe('parseLevelObjects — standard 2-byte objects', () => {
  it('parses a single standard object after 5-byte header', () => {
    // b0 = 0x3A → yNibble=3, x=10(0xA)
    // b1 = 0x52 → param=5 (high nibble), objectType=2 (low nibble)
    //
    // SMW standard objects: Y nibble 0–12 encodes EVEN tile rows (0,2,4,…24).
    // y = yNibble * 2 = 3 * 2 = 6  (tile row 6 out of 27)
    // This matches Lunar Magic's coordinate display and the ObjectExpander grid.
    const buf = makeLevel(ZERO_HEADER, [0x3A, 0x52])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(1)
    const obj = objects[0]
    expect(obj.type).toBe('standard')
    expect(obj.screen).toBe(0)
    expect(obj.y).toBe(6)   // yNibble=3 → tile row = 3 * 2 = 6
    expect(obj.x).toBe(10)
    expect(obj.objectType).toBe(2)   // b1 low nibble
    expect(obj.param).toBe(5)        // b1 high nibble
    expect(obj.raw).toEqual([0x3A, 0x52])
  })

  it('parses multiple standard objects', () => {
    const buf = makeLevel(ZERO_HEADER, [0x00, 0x10, 0x21, 0x20])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(2)
  })
})

describe('parseLevelObjects — extended 3-byte objects', () => {
  it('parses an extended object (yNibble >= 0x0D)', () => {
    // SMW extended objects: first byte high nibble >= 0xD
    // b0 = 0xD3 → yNibble=0xD (>=0x0D), localX=3
    // b1 = 0x05 → y = 0x05 & 0x3F = 5
    // b2 = 0x12 → objectNum = 0x12
    const buf = makeLevel(ZERO_HEADER, [0xD3, 0x05, 0x12])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(1)
    const obj = objects[0]
    expect(obj.type).toBe('extended')
    expect(obj.objectType).toBe(0x100 + 0x12)
    expect(obj.y).toBe(5)
    expect(obj.x).toBe(3)
  })
})

describe('parseLevelObjects — screen advance', () => {
  it('increments screen counter on 0xFF 0xFF', () => {
    const buf = makeLevel(ZERO_HEADER, [0x00, 0x10, 0xFF, 0xFF, 0x10, 0x20])
    const { objects, screens } = parseLevelObjects(buf)
    expect(objects[0].screen).toBe(0)
    expect(objects[1].screen).toBe(1)
    expect(objects[1].x).toBe(16 + 0)
    expect(screens).toBe(2)
  })

  it('screen x is absolute tile position', () => {
    const buf = makeLevel(ZERO_HEADER, [0xFF, 0xFF, 0xFF, 0xFF, 0x35, 0x00])
    const { objects } = parseLevelObjects(buf)
    expect(objects[0].screen).toBe(2)
    expect(objects[0].x).toBe(2 * 16 + 5)
  })
})

describe('parseLevelObjects — terminator', () => {
  it('stops at lone 0xFF immediately after header', () => {
    // Buffer: 5-byte header + lone 0xFF (no objects)
    const buf = Buffer.from([0, 0, 0, 0, 0, 0xFF])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(0)
  })
})

describe('parseLevelSprites', () => {
  it('returns empty array for terminator-only data', () => {
    expect(parseLevelSprites(Buffer.from([0xFF]))).toHaveLength(0)
  })

  it('parses a single sprite', () => {
    const result = parseLevelSprites(Buffer.from([0x23, 0x0E, 0xFF]))
    expect(result).toHaveLength(1)
    expect(result[0].spriteId).toBe(0x0E)
    expect(result[0].y).toBe(4)
  })

  it('stops at 0xFF', () => {
    const result = parseLevelSprites(Buffer.from([0x23, 0x0E, 0xFF, 0x10, 0x05]))
    expect(result).toHaveLength(1)
  })
})
