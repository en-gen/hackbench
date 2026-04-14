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

  while (pos < data.length) {
    const b0 = data[pos]
    if (b0 === undefined) break

    if (b0 === 0xFF) {
      if (pos + 1 < data.length && data[pos + 1] === 0xFF) {
        screen++
        pos += 2
      } else {
        break  // lone 0xFF = terminator
      }
      continue
    }

    const yNibble = (b0 >> 4) & 0xF

    if (yNibble <= 0x0C) {
      // Standard 2-byte object (Y nibble 0x0–0xC = rows 0–12; 0xD–0xF reserved/extended)
      if (pos + 1 >= data.length) break
      const b1 = data[pos + 1]
      objects.push({
        type: 'standard',
        screen,
        x: screen * SCREEN_W + (b0 & 0xF),
        y: yNibble,
        objectType: (b1 >> 4) & 0xF,
        param: b1 & 0xF,
        raw: [b0, b1],
      })
      pos += 2
    } else {
      // Extended 3-byte object
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

  return { header, objects, screens: screen + 1 }
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
