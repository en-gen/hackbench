import { describe, it, expect } from 'vitest'
import { parseLevelObjects, parseLevelSprites } from '../../../src/rom/LevelParser'

/**
 * Build a minimal valid level buffer.
 * 5-byte primary header followed by 3-byte objects and 0xFF terminator.
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

describe('parseLevelObjects — 3-byte object format', () => {
  // Confirmed format from ROM disassembly at $0585FF:
  //   Byte 0: NHOO YYYY — N=new screen, H=half-screen, OO=obj# high, YYYY=Y pos
  //   Byte 1: OOOO YYYY — obj# low 4 bits, sub-Y offset
  //   Byte 2: settings ($59)
  //   $5A = ((byte0 & $60) >> 1) | (byte1 >> 4) = object number
  //   Y = byte0 & $0F = Map16 row

  it('parses a single standard object', () => {
    // $5A = ((0x20 & 0x60)>>1) | (0x50>>4) = 0x10 | 0x05 = 0x15 = obj $15
    // Y = 0x20 & 0x0F = 0
    // settings = 0x42
    const buf = makeLevel(ZERO_HEADER, [0x20, 0x50, 0x42])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(1)
    expect(objects[0].objectType).toBe(0x15)  // $5A
    expect(objects[0].param).toBe(0x42)       // $59 = byte 2
    expect(objects[0].y).toBe(0)              // byte0 & 0x0F
    expect(objects[0].type).toBe('standard')
  })

  it('parses extended object ($5A = 0)', () => {
    // $5A = ((0x0E & 0x60)>>1) | (0x00>>4) = 0 | 0 = 0 → extended
    // Y = 0x0E & 0x0F = 14
    // settings = 0x85 (extended type number)
    const buf = makeLevel(ZERO_HEADER, [0x0E, 0x00, 0x85])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(1)
    expect(objects[0].type).toBe('extended')
    expect(objects[0].objectType).toBe(0x00)  // $5A = 0
    expect(objects[0].param).toBe(0x85)       // $59 = ext type
    expect(objects[0].y).toBe(14)             // byte0 & 0x0F
  })

  it('extracts object number from bytes 0 and 1', () => {
    // $5A = ((0x60 & 0x60)>>1) | (0xF0>>4) = 0x30 | 0x0F = 0x3F
    const buf = makeLevel(ZERO_HEADER, [0x60, 0xF0, 0x00])
    const { objects } = parseLevelObjects(buf)
    expect(objects[0].objectType).toBe(0x3F)
  })
})

describe('parseLevelObjects — new-screen flag', () => {
  it('increments screen counter when bit 7 of byte 0 is set', () => {
    const buf = makeLevel(ZERO_HEADER, [
      0x05, 0x10, 0x00,  // screen 0, obj $01, Y=5
      0x83, 0x10, 0x00,  // N=1 → screen 1, obj $01, Y=3
    ])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(2)
    expect(objects[0].screen).toBe(0)
    expect(objects[1].screen).toBe(1)
    expect(objects[1].y).toBe(3)
  })

  it('column comes from byte1 low nibble', () => {
    // byte0=0x10, byte1=0x50 → col = 0x50 & 0x0F = 0, Y = 0
    // byte0=0x13, byte1=0xA7 → col = 0xA7 & 0x0F = 7, Y = 3
    const buf = makeLevel(ZERO_HEADER, [0x13, 0xA7, 0x00])
    const { objects } = parseLevelObjects(buf)
    expect(objects[0].x).toBe(7)
    expect(objects[0].y).toBe(3)
  })
})

describe('parseLevelObjects — terminator', () => {
  it('stops at 0xFF immediately after header', () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0xFF])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(0)
  })

  it('does not parse past 0xFF terminator', () => {
    const buf = Buffer.from([
      0, 0, 0, 0, 0,       // header
      0x05, 0x10, 0x00,    // one object
      0xFF,                 // terminator
      0x03, 0x20, 0x01,    // should NOT be parsed
    ])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(1)
  })
})

describe('parseLevelObjects — level $104 (Yoshi House) integration', () => {
  const LEVEL_104_RAW = Buffer.from([
    0x20, 0x00, 0x09, 0x00, 0x04,  // header
    0x0e, 0x00, 0x85,              // ext obj, Y=14, ext type $85
    0x78, 0x00, 0x2f,              // $5A=((0x78&0x60)>>1)|(0>>4)=0x30=48→obj $30... wait
    0x10, 0x02, 0x1d,              // ext obj ($5A=0+0=0), Y=0, ext type $1D
    0x10, 0x06, 0x1d,
    0x10, 0x0b, 0x1d,
    0x11, 0x03, 0x1d,
    0x11, 0x09, 0x1d,
    0x11, 0x0d, 0x1d,
    0x12, 0x07, 0x1d,
    0xff,
  ])

  it('parses 9 objects with clean termination', () => {
    const { objects } = parseLevelObjects(LEVEL_104_RAW)
    expect(objects).toHaveLength(9)
  })

  it('all objects on screen 0', () => {
    const { objects } = parseLevelObjects(LEVEL_104_RAW)
    expect(objects.every(o => o.screen === 0)).toBe(true)
  })

  it('first object is extended ($5A=0) at Y=14 with ext type $85', () => {
    const { objects } = parseLevelObjects(LEVEL_104_RAW)
    // byte0=0x0E: $5A = ((0x0E & 0x60)>>1) | (0x00>>4) = 0
    expect(objects[0].objectType).toBe(0x00)  // extended
    expect(objects[0].y).toBe(14)             // 0x0E & 0x0F = 14
    expect(objects[0].param).toBe(0x85)       // ext type from byte 2
  })

  it('second object has $5A = $30', () => {
    const { objects } = parseLevelObjects(LEVEL_104_RAW)
    // byte0=0x78: $5A = ((0x78 & 0x60)>>1) | (0x00>>4) = (0x60>>1)|0 = 0x30
    expect(objects[1].objectType).toBe(0x30)
    expect(objects[1].y).toBe(8)  // 0x78 & 0x0F = 8
    expect(objects[1].param).toBe(0x2F)
  })

  it('fence objects ($1D byte2) are extended ($5A=0)', () => {
    const { objects } = parseLevelObjects(LEVEL_104_RAW)
    // byte0=0x10: $5A = ((0x10&0x60)>>1)|(0x02>>4) = 0|0 = 0 → extended
    const fences = objects.filter(o => o.param === 0x1D && o.objectType === 0)
    expect(fences).toHaveLength(7)
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
