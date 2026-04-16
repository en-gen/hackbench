import { describe, it, expect } from 'vitest'
import { parseLevelObjects, parseLevelSprites } from '../../../src/rom/LevelParser'

/**
 * Build a minimal valid level buffer.
 * 5-byte primary header followed by 3-byte objects and 0xFF terminator.
 *
 * Object format (LoadLevelData, bank_05.asm lines 677-808):
 *   Byte 0 ($0A): NSSYYYYx  N=new screen[7], SS=objNo bits 6-5[6:5],
 *                            H=high coord[4], YYYY=y pos[3:0]
 *   Byte 1 ($0B): OOOOxxxx  O=objNo bits 3-0[7:4], x=x pos[3:0]
 *   Byte 2 ($59): SSSSSSSS  settings/size byte
 *
 * ObjNo = ($0B >> 4) | (($0A & $60) >> 1)
 * When ObjNo == 0: extended object, $59 = extended type
 * When ObjNo != 0: normal object, $59 = size
 */
function makeLevel(
  header: [number, number, number, number, number],
  objectBytes: number[],
): Buffer {
  return Buffer.from([...header, ...objectBytes, 0xFF])
}

const ZERO_HEADER: [number, number, number, number, number] = [0, 0, 0, 0, 0]

describe('parseLevelObjects — header', () => {
  it('parses 5-byte header fields from CODE_0584E3', () => {
    // byte0 = 0xAA = 0b10101010 → bgPalette = bits 7-5 = 5, screens-1 = bits 4-0 = 10 → levelLength = 11
    // byte1 = 0x66 = 0b01100110 → bgColor = bits 7-5 = 3, levelMode = bits 4-0 = 6
    // byte2 = 0xB8 = 0b10111000 → layer3Priority = bit 7 = true, music = bits 6-4 = 3, spriteSet = bits 3-0 = 8
    // byte3 = 0x99 = 0b10011001 → timeLimit = bits 7-6 = 2, spritePalette = bits 5-3 = 3, fgPalette = bits 2-0 = 1
    // byte4 = 0x67 = 0b01100111 → itemMemory = bits 7-6 = 1, verticalScroll = bits 5-4 = 2, objectTileset = bits 3-0 = 7
    const buf = makeLevel([0xAA, 0x66, 0xB8, 0x99, 0x67], [])
    const { header } = parseLevelObjects(buf)
    expect(header.raw).toEqual([0xAA, 0x66, 0xB8, 0x99, 0x67])
    expect(header.bgPalette).toBe(5)
    expect(header.levelLength).toBe(11)   // (0x0A & 0x1F) + 1 = 10 + 1 = 11
    expect(header.bgColor).toBe(3)
    expect(header.levelMode).toBe(6)
    expect(header.layer3Priority).toBe(true)
    expect(header.music).toBe(3)
    expect(header.spriteSet).toBe(8)      // byte 2 bits 3-0
    expect(header.timeLimit).toBe(2)
    expect(header.spritePalette).toBe(3)  // byte 3 bits 5-3
    expect(header.fgPalette).toBe(1)      // byte 3 bits 2-0
    expect(header.itemMemory).toBe(1)
    expect(header.verticalScroll).toBe(2)
    expect(header.objectTileset).toBe(7)  // byte 4 bits 3-0
  })
})

describe('parseLevelObjects — 3-byte objects', () => {
  it('parses a single normal object after 5-byte header', () => {
    // 3-byte object: bytes $0A, $0B, $59
    // Want: normal object (objNo != 0), x=5, y=3, objNo=2, settings=0x10
    // objNo = 2 = ($0B>>4) | (($0A & $60)>>1)
    //   If $0B>>4 = 2, ($0A & $60) = 0, then objNo = 2
    // $0A = 0b0000_0011 = 0x03 (y=3, no new screen, no high coord, SS bits=0)
    // $0B = 0b0010_0101 = 0x25 (objNo high nibble=2, x=5)
    // $59 = 0x10 (settings)
    const buf = makeLevel(ZERO_HEADER, [0x03, 0x25, 0x10])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(1)
    const obj = objects[0]
    expect(obj.type).toBe('standard')
    expect(obj.screen).toBe(0)
    expect(obj.y).toBe(3)
    expect(obj.x).toBe(5)
    expect(obj.objectNumber).toBe(2)    // ($0B>>4) = 2
    expect(obj.objectType).toBe(2)      // backward compat alias
    expect(obj.settings).toBe(0x10)
    expect(obj.param).toBe(0x10)        // backward compat alias
    expect(obj.raw).toEqual([0x03, 0x25, 0x10])
  })

  it('parses an extended object (objNo == 0)', () => {
    // Extended: objNo must be 0, meaning ($0B>>4) = 0 AND ($0A & $60) = 0
    // $0A = 0x05 (y=5, no flags)
    // $0B = 0x03 (objNo=0, x=3)
    // $59 = 0x12 (extended type)
    const buf = makeLevel(ZERO_HEADER, [0x05, 0x03, 0x12])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(1)
    const obj = objects[0]
    expect(obj.type).toBe('extended')
    expect(obj.objectNumber).toBe(0x12)   // ext type from $59
    expect(obj.objectType).toBe(0x100 + 0x12)  // backward compat
    expect(obj.y).toBe(5)
    expect(obj.x).toBe(3)
  })

  it('parses multiple objects', () => {
    // Two 3-byte objects
    const buf = makeLevel(ZERO_HEADER, [0x00, 0x10, 0x05, 0x01, 0x20, 0x03])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(2)
  })
})

describe('parseLevelObjects — new screen flag', () => {
  it('increments screen counter when bit 7 of byte 0 is set', () => {
    // First object: no new screen flag
    // $0A=0x00, $0B=0x10, $59=0x00 → objNo=1, screen=0
    // Second object: new screen flag (bit 7 set)
    // $0A=0x80, $0B=0x10, $59=0x00 → objNo=1, screen=1
    const buf = makeLevel(ZERO_HEADER, [0x00, 0x10, 0x00, 0x80, 0x10, 0x00])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(2)
    expect(objects[0].screen).toBe(0)
    expect(objects[1].screen).toBe(1)
    expect(objects[1].newScreen).toBe(true)
  })

  it('screen x is absolute tile position', () => {
    // New screen flag set twice: screen = 2
    // $0A=0x85 (new screen + y=5), $0B=0x13 (objNo=1, x=3)
    // But we need TWO objects with new-screen to get screen=2
    const buf = makeLevel(ZERO_HEADER, [
      0x80, 0x10, 0x00,  // screen 1 (new screen)
      0x85, 0x13, 0x00,  // screen 2 (new screen), y=5, x=3
    ])
    const { objects } = parseLevelObjects(buf)
    expect(objects[1].screen).toBe(2)
    expect(objects[1].x).toBe(2 * 16 + 3)
  })
})

describe('parseLevelObjects — terminator', () => {
  it('stops at 0xFF immediately after header', () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0xFF])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(0)
  })
})

describe('parseLevelSprites', () => {
  it('returns empty array for terminator-only data', () => {
    // Sprite data starts with 1-byte header, then $FF terminator
    expect(parseLevelSprites(Buffer.from([0x00, 0xFF]))).toHaveLength(0)
  })

  it('parses a single sprite (3-byte format with header byte)', () => {
    // Byte 0: header (buoyancy + memory settings)
    // Sprite entry: b0=0x40, b1=0x0A, b2=0x0E
    //   y = (b0 >> 4) & 0xF = 4
    //   x = b1 & 0xF = 0xA = 10
    //   screen = (b1 >> 4) & 0xF = 0
    //   spriteId = b2 = 0x0E
    const result = parseLevelSprites(Buffer.from([0x00, 0x40, 0x0A, 0x0E, 0xFF]))
    expect(result).toHaveLength(1)
    expect(result[0].spriteId).toBe(0x0E)
    expect(result[0].y).toBe(4)
    expect(result[0].x).toBe(10)
  })

  it('stops at 0xFF', () => {
    const result = parseLevelSprites(Buffer.from([0x00, 0x40, 0x0A, 0x0E, 0xFF, 0x10, 0x05, 0x01]))
    expect(result).toHaveLength(1)
  })
})
