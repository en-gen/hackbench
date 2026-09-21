import { describe, it, expect } from 'vitest'
import {
  parseLevelObjects,
  parseLevelSprites,
  isLevelModeVertical,
} from '../../../src/rom/LevelParser'

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
  return Buffer.from([...header, ...objectBytes, 0xff])
}

const ZERO_HEADER: [number, number, number, number, number] = [0, 0, 0, 0, 0]

describe('parseLevelObjects - header', () => {
  it('parses 5-byte header fields from CODE_0584E3', () => {
    // byte0 = 0xAA = 0b10101010 → bgPalette = bits 7-5 = 5, screens-1 = bits 4-0 = 10 → levelLength = 11
    // byte1 = 0x66 = 0b01100110 → bgColor = bits 7-5 = 3, levelMode = bits 4-0 = 6
    // byte2 = 0xB8 = 0b10111000 → layer3Priority = bit 7 = true, music = bits 6-4 = 3, spriteSet = bits 3-0 = 8
    // byte3 = 0x99 = 0b10011001 → timeLimit = bits 7-6 = 2, spritePalette = bits 5-3 = 3, fgPalette = bits 2-0 = 1
    // byte4 = 0x67 = 0b01100111 → itemMemory = bits 7-6 = 1, verticalScroll = bits 5-4 = 2, objectTileset = bits 3-0 = 7
    const buf = makeLevel([0xaa, 0x66, 0xb8, 0x99, 0x67], [])
    const { header } = parseLevelObjects(buf)
    expect(header.raw).toEqual([0xaa, 0x66, 0xb8, 0x99, 0x67])
    expect(header.bgPalette).toBe(5)
    expect(header.levelLength).toBe(11) // (0x0A & 0x1F) + 1 = 10 + 1 = 11
    expect(header.bgColor).toBe(3)
    expect(header.levelMode).toBe(6)
    expect(header.layer3Priority).toBe(true)
    expect(header.music).toBe(3)
    expect(header.spriteSet).toBe(8) // byte 2 bits 3-0
    expect(header.timeLimit).toBe(2)
    expect(header.spritePalette).toBe(3) // byte 3 bits 5-3
    expect(header.fgPalette).toBe(1) // byte 3 bits 2-0
    expect(header.itemMemory).toBe(1)
    expect(header.verticalScroll).toBe(2)
    expect(header.objectTileset).toBe(7) // byte 4 bits 3-0
  })
})

describe('parseLevelObjects - 3-byte objects', () => {
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
    expect(obj.objectNumber).toBe(2) // ($0B>>4) = 2
    expect(obj.objectType).toBe(2) // backward compat alias
    expect(obj.settings).toBe(0x10)
    expect(obj.param).toBe(0x10) // backward compat alias
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
    expect(obj.objectNumber).toBe(0x12) // ext type from $59
    expect(obj.objectType).toBe(0x100 + 0x12) // backward compat
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

describe('parseLevelObjects - new screen flag', () => {
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
      0x80,
      0x10,
      0x00, // screen 1 (new screen)
      0x85,
      0x13,
      0x00, // screen 2 (new screen), y=5, x=3
    ])
    const { objects } = parseLevelObjects(buf)
    expect(objects[1].screen).toBe(2)
    expect(objects[1].x).toBe(2 * 16 + 3)
  })
})

describe('parseLevelObjects - extended object $01 screen jump', () => {
  it('overwrites the screen counter with (byte0 & 0x1F) after the object', () => {
    // CODE_0DA53D: LDA _A; AND #$1F; STA LevelLoadObject
    // Sequence: a normal object on screen 0, then ext $01 with byte0=0x0A
    // jumping the counter to 10, then a normal object (no NS) should land on
    // screen 10 -- NOT screen 1.
    const buf = makeLevel(ZERO_HEADER, [
      0x00,
      0x10,
      0x00, // std objNo=1, screen 0
      0x0a,
      0x00,
      0x01, // ext $01, b0=0x0A → set screen to 10
      0x00,
      0x10,
      0x00, // std objNo=1, no NS → screen 10
    ])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(3)
    expect(objects[0].screen).toBe(0)
    expect(objects[1].screen).toBe(0) // ext $01 itself reports pre-jump screen
    expect(objects[2].screen).toBe(10) // subsequent object uses new counter
  })

  it('composes with the NS flag: NS increments first, then ext $01 overwrites', () => {
    const buf = makeLevel(ZERO_HEADER, [
      0x80,
      0x10,
      0x00, // NS → screen 1
      0x0a,
      0x00,
      0x01, // ext $01, screen jumps to 10
      0x80,
      0x10,
      0x00, // NS → screen 11 (0x0B)
    ])
    const { objects } = parseLevelObjects(buf)
    expect(objects[0].screen).toBe(1)
    expect(objects[1].screen).toBe(1)
    expect(objects[2].screen).toBe(11)
  })

  it('ignores extended objects with settings != 0x01', () => {
    const buf = makeLevel(ZERO_HEADER, [
      0x0a,
      0x00,
      0x12, // ext $12 -- not a screen jump; no counter change
      0x00,
      0x10,
      0x00, // std -- still on screen 0
    ])
    const { objects } = parseLevelObjects(buf)
    expect(objects[1].screen).toBe(0)
  })
})

describe('parseLevelObjects - terminator', () => {
  it('stops at 0xFF immediately after header', () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0xff])
    const { objects } = parseLevelObjects(buf)
    expect(objects).toHaveLength(0)
  })
})

describe('isLevelModeVertical - VerticalTable bit 0', () => {
  it('matches bank_05.asm:480 VerticalTable entries with bit 0 set', () => {
    // Modes with bit-0 set per the table: 3 ($01), 4 ($81), 7 ($03), 8 ($83),
    // 10 ($01), 13 ($01). Every other mode is horizontal for L1.
    const expectedVertical = new Set([3, 4, 7, 8, 10, 13])
    for (let mode = 0; mode < 32; mode++) {
      expect(isLevelModeVertical(mode)).toBe(expectedVertical.has(mode))
    }
  })
})

describe('parseLevelObjects - vertical level layout', () => {
  it('places object at 32-wide column + screen*16 row when levelMode is vertical (mode 3)', () => {
    // levelMode = 3 → VerticalTable[3] = $01 → L1 vertical.
    // Header byte 1 low 5 bits = levelMode = 3.
    const vertHeader: [number, number, number, number, number] = [0, 3, 0, 0, 0]

    // Object bytes encode (after CODE_0585D8 swap):
    //   $0A = NSxxYYYY : we use $05 → highCoord=0, x_local=5 (low nibble of $0A)
    //   $0B = OOOOyyyy : we use $17 → objNumHigh nibble of $17 = 1 (so objNo base = 1),
    //                    y_local = 7
    // In vertical mode: x_abs = 5, y_abs = screen(0)*16 + 7 = 7
    const buf = makeLevel(vertHeader, [0x05, 0x17, 0x00])
    const { objects, isVertical } = parseLevelObjects(buf)
    expect(isVertical).toBe(true)
    expect(objects).toHaveLength(1)
    expect(objects[0].x).toBe(5)
    expect(objects[0].y).toBe(7)
  })

  it('high-coord moves object to the right half (col += 16) in vertical mode', () => {
    const vertHeader: [number, number, number, number, number] = [0, 3, 0, 0, 0]
    // $0A = 0x15 = 0001_0101 → highCoord=1 (bit 4), low nibble = 5 (x within screen)
    // $0B = 0x17 → low nibble = 7 (y within screen)
    const buf = makeLevel(vertHeader, [0x15, 0x17, 0x00])
    const { objects } = parseLevelObjects(buf)
    expect(objects[0].x).toBe(5 + 16) // right half
    expect(objects[0].y).toBe(7)
  })

  it('new-screen flag advances downward (y += 16) in vertical mode', () => {
    const vertHeader: [number, number, number, number, number] = [0, 3, 0, 0, 0]
    const buf = makeLevel(vertHeader, [
      0x03,
      0x10,
      0x00, // screen 0, x=3, y=0
      0x82,
      0x14,
      0x00, // NS → screen 1, x=2, y=4  → y_abs = 16 + 4 = 20
    ])
    const { objects } = parseLevelObjects(buf)
    expect(objects[1].screen).toBe(1)
    expect(objects[1].x).toBe(2)
    expect(objects[1].y).toBe(16 + 4)
  })

  it('leaves horizontal levels unchanged (mode 0)', () => {
    // levelMode = 0 → VerticalTable[0] = $00 → not vertical.
    // Same encoding as before my change: x = screen*16 + x_local, y = b0 low nibble.
    const buf = makeLevel([0, 0, 0, 0, 0], [0x03, 0x25, 0x10])
    const { objects, isVertical } = parseLevelObjects(buf)
    expect(isVertical).toBe(false)
    expect(objects[0].x).toBe(5) // screen 0, x = 5 (low of $25)
    expect(objects[0].y).toBe(3) // y = 3 (low of $03, no highCoord)
  })
})

describe('parseLevelSprites', () => {
  it('returns empty array for terminator-only data', () => {
    // Sprite data starts with 1-byte header, then $FF terminator
    expect(parseLevelSprites(Buffer.from([0x00, 0xff]))).toHaveLength(0)
  })

  it('parses a single sprite: b0=YYYYEEsy, b1=XXXXSSSS, b2=id', () => {
    // Byte 0: header (buoyancy + memory settings) = 0x00
    // Entry: b0=0x40 (YYYY=4, EE=0, s=0, y=0)
    //        b1=0xA0 (XXXX=0xA, SSSS=0)       → screen 0, X=10 tiles within screen
    //        b2=0x0E (sprite id)
    // Horizontal: abs x = 0*16 + 10 = 10, abs y = 4.
    const result = parseLevelSprites(Buffer.from([0x00, 0x40, 0xa0, 0x0e, 0xff]))
    expect(result).toHaveLength(1)
    expect(result[0].spriteId).toBe(0x0e)
    expect(result[0].screen).toBe(0)
    expect(result[0].x).toBe(10)
    expect(result[0].y).toBe(4)
  })

  it('uses byte1 low nibble as screen number', () => {
    // b1=0x05 → XXXX=0, SSSS=5 → screen 5, x within screen = 0.
    // Horizontal: abs x = 5*16 + 0 = 80.
    const result = parseLevelSprites(Buffer.from([0x00, 0x30, 0x05, 0x11, 0xff]))
    expect(result).toHaveLength(1)
    expect(result[0].screen).toBe(5)
    expect(result[0].x).toBe(80)
    expect(result[0].y).toBe(3)
  })

  it('combines b0 bit 1 with b1 low nibble for 5-bit screen number', () => {
    // b0 bit 1 = s (screen high bit); bit 0 = y (Y high bit).
    // b0=0x02 → s=1, rest zero. b1=0x03 → SSSS=3 → screen = (1<<4)|3 = 19.
    // Horizontal: abs x = 19*16 + 0 = 304.
    const result = parseLevelSprites(Buffer.from([0x00, 0x02, 0x03, 0x20, 0xff]))
    expect(result).toHaveLength(1)
    expect(result[0].screen).toBe(19)
    expect(result[0].x).toBe(304)
  })

  it('does NOT treat b0 bit 0 as screen high (bit 0 is Y-high)', () => {
    // b0=0x01 → y=1 only. Screen high bit is bit 1, which is 0 here.
    const result = parseLevelSprites(Buffer.from([0x00, 0x01, 0x00, 0x00, 0xff]))
    expect(result[0].screen).toBe(0)
  })

  it('adds the Y-high bit for rows 16-31 in horizontal levels', () => {
    // Horizontal screens are 27 tiles tall, so rows 16-26 require yHi=1.
    // b0=0x41 → YYYY=4, yHi=1 → row 16+4 = 20.
    const result = parseLevelSprites(Buffer.from([0x00, 0x41, 0x00, 0x00, 0xff]))
    expect(result[0].y).toBe(20)
  })

  it('parses extra bits from b0 bits 2-3', () => {
    // b0=0x0C → EE=0b11 → extra bit flag true.
    const result = parseLevelSprites(Buffer.from([0x00, 0x0c, 0x00, 0x00, 0xff]))
    expect(result[0].extraBit).toBe(true)
  })

  it('stops at 0xFF', () => {
    const result = parseLevelSprites(Buffer.from([0x00, 0x40, 0xa0, 0x0e, 0xff, 0x10, 0x05, 0x01]))
    expect(result).toHaveLength(1)
  })

  it('vertical level swaps X/Y: YYYY→x, XXXX→within-screen y', () => {
    // Vertical: YYYY is x-within-screen; XXXX is y-within-screen; SSSS indexes
    // the vertical screen. b0=0x40 (YYYY=4), b1=0x32 (XXXX=3, SSSS=2).
    // abs y = 2*16 + 3 = 35; abs x = 4.
    const result = parseLevelSprites(Buffer.from([0x00, 0x40, 0x32, 0x0e, 0xff]), true)
    expect(result).toHaveLength(1)
    expect(result[0].screen).toBe(2)
    expect(result[0].x).toBe(4)
    expect(result[0].y).toBe(35)
  })
})
