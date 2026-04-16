export const SCREEN_W = 16
export const SCREEN_H = 27

/**
 * SMW Level Primary Header — 5 bytes at the start of Layer 1 data.
 *
 * Byte 0: BBBLLLLL — BG palette row [7:5], level length in screens [4:0]
 * Byte 1: CCCOOOOO — BG color [7:5], level mode [4:0]
 * Byte 2: 3MMMOOOO — Layer 3 priority [7], music [6:4], level mode [3:0]
 * Byte 3: TTPPSSSS — time limit [7:6], sprite palette [5:4], sprite set [3:0]
 *
 * NOTE: sprite set is in byte 3 bits 3-0, confirmed empirically via Mesen2
 * write watchpoint on $7E:192B (code: LDA [$65],Y / AND #$0F / STA $192B, Y=3).
 * Byte 4: IIVVZZZZ — item memory [7:6], vertical scroll [5:4], tileset ID [3:0]
 *
 * Object data begins at byte 5 (offset 5).
 *
 * Source: smwspeedruns.com/Level_Data_Format, sneslab.net/wiki/SMW_level_data_format
 */
export interface LevelHeader {
  raw: number[]          // all 5 header bytes
  bgPalette: number      // 3-bit BG palette row (byte 0 bits 7-5)
  levelLength: number    // 5-bit screen count (byte 0 bits 4-0)
  bgColor: number        // 3-bit background color (byte 1 bits 7-5)
  levelMode: number      // 5-bit level mode (byte 1 bits 4-0)
  layer3Priority: boolean
  music: number          // 3-bit music index (byte 2 bits 6-4)
  spriteSet: number      // 4-bit sprite set (byte 3 bits 3-0)
  timeLimit: number      // 2-bit time limit (byte 3 bits 7-6)
  spritePalette: number  // 2-bit sprite palette (byte 3 bits 5-4)
  itemMemory: number     // 2-bit item memory (byte 4 bits 7-6)
  verticalScroll: number // 2-bit vertical scroll (byte 4 bits 5-4)
  bgTypeId: number       // 4-bit background type (byte 4 bits 3-0) — NOT the GFX tileset index
}

export type ObjectType = 'standard' | 'extended'

export interface LevelObject {
  type: ObjectType
  screen: number
  x: number    // absolute tile X (screen * 16 + local x)
  y: number    // tile Y
  objectType: number
  param: number
  raw: number[]
}

export interface LevelSprite {
  screen: number
  x: number
  y: number
  spriteId: number
  raw: number[]
}

export interface ParsedLevel {
  header: LevelHeader
  objects: LevelObject[]
  sprites: LevelSprite[]
  screens: number
}

const HEADER_SIZE = 5   // bytes before object data begins

export function parseLevelObjects(data: Buffer): Omit<ParsedLevel, 'sprites'> {
  const h = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0, data[4] ?? 0]
  const header: LevelHeader = {
    raw:           h,
    bgPalette:     (h[0] >> 5) & 0x7,
    levelLength:    h[0] & 0x1F,
    bgColor:       (h[1] >> 5) & 0x7,
    levelMode:      h[1] & 0x1F,
    layer3Priority: ((h[2] >> 7) & 1) === 1,
    music:         (h[2] >> 4) & 0x7,
    spriteSet:      h[3] & 0xF,
    timeLimit:     (h[3] >> 6) & 0x3,
    spritePalette: (h[3] >> 4) & 0x3,
    itemMemory:    (h[4] >> 6) & 0x3,
    verticalScroll:(h[4] >> 4) & 0x3,
    bgTypeId:       h[4] & 0xF,
  }

  const objects: LevelObject[] = []
  let pos = HEADER_SIZE
  let screen = 0

  // ── All objects are 3 bytes ──────────────────────────────────────────────
  // Verified empirically: 3-byte parsing produces clean $FF termination
  // for 47/48 tested levels (levels 0x100-0x12F).
  //
  // Format (confirmed via ROM disassembly at $0585FF with copier header):
  //   Byte 0 (→ $0A): NHOO YYYY
  //     N    = new screen flag (bit 7) — increments screen counter
  //     H    = half-screen X offset (bit 4) — adds 1 to column page pointer
  //     OO   = object number high bits (bits 6-5) — upper 2 bits of $5A
  //     YYYY = Y position (bits 3-0) — Map16 row (high nibble of cursor $57)
  //
  //   Byte 1 (→ $0B): OOOO YYYY
  //     OOOO = object number low bits (bits 7-4) — lower 4 bits of $5A
  //     YYYY = sub-Y offset (bits 3-0) — low nibble of cursor $57
  //
  //   Byte 2 (→ $59): SSSS SSSS
  //     Settings/dimensions byte. Used by handlers:
  //       Objects $01-$0E: high nibble = height-1, low nibble = width-1
  //       Extended objects ($5A=0): extended sub-type number
  //
  // Derived values:
  //   $5A = object number = ((byte0 & $60) >> 1) | (byte1 >> 4)
  //         0 = extended object, 1-63 = standard object
  //   $57 = Y cursor = ((byte0 & $0F) << 4) | (byte1 & $0F)
  //         Map16 row = byte0 & $0F (each row = $10 in cursor space)
  //
  // Dispatch path (from $0586C5):
  //   $5A = 0: JSL $0DA100 (extended object, $59 = ext type number)
  //   $5A ≠ 0: JSL $0DA40F → tileset dispatch → per-tileset object table
  //
  // Terminator: lone $FF byte ends the object stream.

  while (pos < data.length) {
    const b0 = data[pos]
    if (b0 === undefined) break
    if (b0 === 0xFF) break  // terminator

    if (pos + 2 >= data.length) break
    const b1 = data[pos + 1]
    const b2 = data[pos + 2]

    // New-screen flag (bit 7 of byte 0)
    if (b0 & 0x80) screen++

    // Object number ($5A) from bytes 0 and 1
    const objNum = ((b0 & 0x60) >> 1) | ((b1 >> 4) & 0x0F)

    // Y position: low nibble of byte 0 = Map16 row
    const y = b0 & 0x0F

    // X position: low nibble of byte 1 = column within screen
    // The cursor $57 = (byte0_low << 4) | byte1_low = (row << 4) | col
    // This directly indexes the tilemap as (row * 16 + col)
    const col = b1 & 0x0F

    // Settings: byte 2 ($59)
    const settings = b2

    objects.push({
      type: objNum === 0 ? 'extended' : 'standard',
      screen,
      x: screen * SCREEN_W + col,
      y,
      objectType: objNum,
      param: settings,
      raw: [b0, b1, b2],
    })

    pos += 3
  }

  return { header, objects, screens: header.levelLength + 1 }
}

/**
 * Parse Layer 2 background objects from the L2 data stream.
 *
 * L2 data starts at byte 0 — there is no primary header (the screen count is
 * inherited from the L1 header). Object format is identical to L1:
 *   - 2-byte standard objects (y nibble 0x0–0xC)
 *   - 3-byte extended objects (y nibble 0xD–0xF)
 *   - 0xFF 0xFF = screen boundary increment
 *   - lone 0xFF = end of object data
 *
 * @param data    Raw bytes at the L2 pointer address
 * @param screens Screen count from the L1 header (header.levelLength + 1)
 */
export function parseL2Objects(data: Buffer, screens: number): LevelObject[] {
  const objects: LevelObject[] = []
  let pos = 0   // no header — L2 object data begins at byte 0
  let screen = 0

  while (pos < data.length && screen < screens) {
    const b0 = data[pos]
    if (b0 === undefined) break

    if (b0 === 0xFF) {
      if (pos + 1 < data.length && data[pos + 1] === 0xFF) {
        screen++
        pos += 2
      } else {
        break   // lone 0xFF = terminator
      }
      continue
    }

    const yNibble = (b0 >> 4) & 0xF

    if (yNibble <= 0x0C) {
      if (pos + 1 >= data.length) break
      const b1 = data[pos + 1]
      objects.push({
        type: 'standard',
        screen,
        x: screen * SCREEN_W + (b0 & 0xF),
        y: yNibble * 2,
        objectType: b1 & 0xF,
        param: (b1 >> 4) & 0xF,
        raw: [b0, b1],
      })
      pos += 2
    } else {
      if (pos + 2 >= data.length) break
      const b1 = data[pos + 1]
      const b2 = data[pos + 2]
      objects.push({
        type: 'extended',
        screen,
        x: screen * SCREEN_W + (b0 & 0xF),
        y: b1 & 0x3F,
        objectType: 0x100 + b2,
        param: 0,
        raw: [b0, b1, b2],
      })
      pos += 3
    }
  }

  return objects
}

/**
 * Reads the per-screen secondary exit table stored after the object stream terminator
 * in a Lunar Magic-extended level data block.
 *
 * Returns an array of secondary entrance indices, indexed by screen number.
 * An index of 0 means no exit for that screen and should be ignored by the caller.
 *
 * Format: 2 bytes per screen immediately after the lone $FF object-stream terminator.
 *   lo byte:  secondary entrance index bits [7:0]
 *   hi byte:  bit 0 (h) = index bit [8]; remaining bits are LM flags
 *
 * ⚠ Format is a Lunar Magic convention — not documented in vanilla SMW disassembly.
 *   Callers should validate extracted indices against the secondary entrance table.
 */
export function parseLevelScreenExits(data: Buffer, screens: number): number[] {
  // Walk the object stream (starting after the 5-byte primary header) to find
  // the position of the lone $FF terminator.
  let pos = 5
  while (pos < data.length) {
    const b = data[pos]
    if (b === undefined) break
    if (b === 0xFF) {
      if (pos + 1 < data.length && data[pos + 1] === 0xFF) {
        pos += 2  // screen boundary — skip
      } else {
        pos += 1  // lone $FF — terminator; exit table starts here
        break
      }
    } else {
      pos += (((b >> 4) & 0xF) <= 0x0C) ? 2 : 3
    }
  }

  const exits: number[] = []
  for (let s = 0; s < screens && pos + 1 < data.length; s++) {
    const lo = data[pos]!
    const hi = data[pos + 1]!
    exits.push(((hi & 0x01) << 8) | lo)
    pos += 2
  }
  return exits
}

export function parseLevelSprites(data: Buffer): LevelSprite[] {
  const sprites: LevelSprite[] = []
  let pos = 0

  while (pos < data.length) {
    const b0 = data[pos]
    if (b0 === 0xFF || b0 === undefined) break
    if (pos + 1 >= data.length) break
    const b1 = data[pos + 1]

    const y       = (b0 >> 4) & 0xF
    const screenX =  b0 & 0xF
    const screen  = (screenX >> 3) & 0x1

    sprites.push({
      screen,
      x: screen * SCREEN_W + (screenX & 0x7) * 2,
      y: y * 2,
      spriteId: b1,
      raw: [b0, b1],
    })
    pos += 2
  }

  return sprites
}
