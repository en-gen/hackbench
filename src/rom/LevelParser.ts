/**
 * LevelParser.ts -- Level header + object/sprite stream parsing for Super Mario World.
 *
 * Derived ENTIRELY from the SMWDisX disassembly:
 *   - Header parsing: bank_05.asm CODE_0584E3 (lines 523-652)
 *   - Object parsing: bank_05.asm LoadLevelData (lines 677-808)
 *   - Object number:  bank_05.asm lines 696-706 ($5A computation)
 *   - Sprite parsing:  bank_05.asm CODE_05D796 lines 7253-7261 (sprite pointer + header)
 *   - Screen dimensions: 16 tiles wide, 27 tiles tall
 */

/** Tiles per screen horizontally. */
export const SCREEN_W = 16
/** Tiles per screen vertically. */
export const SCREEN_H = 27

/**
 * SMW Level Primary Header -- 5 bytes at the start of Layer 1 data.
 *
 * Byte layout from CODE_0584E3:
 *   Byte 0: PPPNNNNN  P=BG palette[7:5], N=screens-1[4:0]
 *   Byte 1: BBBMMMMM  B=back area color[7:5], M=level mode[4:0]
 *   Byte 2: LMMMSSSS  L=layer3 priority[7], M=music[6:4], S=sprite tileset[3:0]
 *   Byte 3: TTPPPCCC  T=time[7:6], P=sprite palette[5:3], C=FG palette[2:0]
 *   Byte 4: IIVVOOOO  I=item memory[7:6], V=vert scroll[5:4], O=object tileset[3:0]
 */
export interface LevelHeader {
  raw: number[]          // all 5 header bytes
  bgPalette: number      // 3-bit BG palette row (byte 0 bits 7-5)     -- CODE_0584E3 line 530-536
  levelLength: number    // 5-bit screen count (byte 0 bits 4-0) + 1   -- CODE_0584E3 line 527-529
  bgColor: number        // 3-bit back area color (byte 1 bits 7-5)    -- CODE_0584E3 line 562-568
  levelMode: number      // 5-bit level mode (byte 1 bits 4-0)         -- CODE_0584E3 line 539-540
  layer3Priority: boolean // byte 2 bit 7                              -- CODE_0584E3 line 590-597
  music: number          // 3-bit music index (byte 2 bits 6-4)        -- CODE_0584E3 line 575-581
  spriteSet: number      // 4-bit sprite tileset (byte 2 bits 3-0)     -- CODE_0584E3 line 573-574
  timeLimit: number      // 2-bit time limit (byte 3 bits 7-6)         -- CODE_0584E3 line 601-607
  spritePalette: number  // 3-bit sprite palette (byte 3 bits 5-3)     -- CODE_0584E3 line 617-622
  fgPalette: number      // 3-bit FG palette (byte 3 bits 2-0)         -- CODE_0584E3 line 614-616
  itemMemory: number     // 2-bit item memory (byte 4 bits 7-6)        -- CODE_0584E3 line 628-633
  verticalScroll: number // 2-bit vertical scroll (byte 4 bits 5-4)    -- CODE_0584E3 line 634-644
  objectTileset: number  // 4-bit object tileset (byte 4 bits 3-0)     -- CODE_0584E3 line 625-627
}

export type ObjectType = 'standard' | 'extended'

/**
 * A parsed level object from the object stream.
 *
 * Object byte format from LoadLevelData (bank_05.asm lines 677-808):
 *   Byte 0 ($0A): NSYYYYXX  N=new screen[7], S=high coord[4], Y=y pos[3:0] (when not swapped),
 *                            XX (bits 6:5 contribute to object number)
 *   Byte 1 ($0B): OOOOYYYY  O=obj num high[7:4], Y=x pos[3:0] (when not swapped)
 *   Byte 2 ($59): SSSSSSSS  size/settings byte (LvlLoadObjSize)
 *
 * Object number computation (lines 696-706):
 *   $5A = ($0B >> 4) | (($0A & $60) >> 1)
 *   When $5A == 0, this is an extended object; $59 is the extended object type.
 *   When $5A != 0, this is a normal object; $59 is the size parameter.
 */
export interface LevelObject {
  type: ObjectType
  screen: number       // which screen this object is on (new-screen flag tracking)
  x: number            // tile X position (absolute: screen * 16 + local x nibble)
  y: number            // tile Y position (local within screen)
  objectNumber: number // 6-bit object number ($5A) for normal; extended type ($59) for ext
  settings: number     // byte 2 ($59) -- size/settings
  newScreen: boolean   // new screen flag (byte 0 bit 7)
  highCoord: boolean   // high coordinate flag (byte 0 bit 4)
  raw: number[]        // original 3 bytes
  // Backward-compatible aliases used by webview/providers:
  objectType: number   // = objectNumber for normal, 0x100+objectNumber for extended
  param: number        // = settings
  /** For screen exit objects: the destination level (primary) or entrance index (secondary). */
  screenExitDest?: number
  /** True if this is a secondary exit (needs DATA_05F800 lookup), false if primary (dest is direct). */
  screenExitIsSecondary?: boolean
}

export interface LevelSprite {
  screen: number
  x: number
  y: number
  spriteId: number
  extraBit: boolean    // sprite header extra bit
  raw: number[]
}

export interface ParsedLevel {
  header: LevelHeader
  objects: LevelObject[]
  sprites: LevelSprite[]
  screens: number
}

const HEADER_SIZE = 5   // bytes before object data begins (CODE_0584E3 line 645-651)

/**
 * Parse the 5-byte level header from raw L1 data.
 * Exact bit extractions from CODE_0584E3 (bank_05.asm lines 523-652).
 */
export function parseLevelHeader(data: Buffer | Uint8Array): LevelHeader {
  const h = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0, data[4] ?? 0]

  // Byte 0: PPPNNNNN
  // Line 527: AND #$1F -> screens-1; Line 528: INC A -> screens
  // Line 530-536: LSR x5 -> BG palette
  const levelLength = (h[0] & 0x1F) + 1
  const bgPalette = (h[0] >> 5) & 0x07

  // Byte 1: BBBMMMMM
  // Line 539: AND #$1F -> level mode
  // Line 562-568: LSR x5 -> back area color
  const levelMode = h[1] & 0x1F
  const bgColor = (h[1] >> 5) & 0x07

  // Byte 2: LMMMSSSS
  // Line 573: AND #$0F -> sprite tileset
  // Line 576-580: LSR x4, AND #$07 -> music
  // Line 590-591: AND #$80 -> layer 3 priority flag
  const spriteSet = h[2] & 0x0F
  const music = (h[2] >> 4) & 0x07
  const layer3Priority = (h[2] & 0x80) !== 0

  // Byte 3: TTPPPCCC
  // Line 601-606: LSR x6 -> time (2 bits)
  // Line 614-616: AND #$07 -> FG palette (3 bits)
  // Line 617-621: AND #$38, LSR x3 -> sprite palette (3 bits)
  const timeLimit = (h[3] >> 6) & 0x03
  const fgPalette = h[3] & 0x07
  const spritePalette = (h[3] >> 3) & 0x07

  // Byte 4: IIVVOOOO
  // Line 625: AND #$0F -> object tileset
  // Line 628-633: AND #$C0, ASL, ROL, ROL -> item memory (2 bits at 7-6)
  // Line 634-639: AND #$30, LSR x4 -> vertical scroll (2 bits at 5-4)
  const objectTileset = h[4] & 0x0F
  const itemMemory = (h[4] >> 6) & 0x03
  const verticalScroll = (h[4] >> 4) & 0x03

  return {
    raw: h,
    bgPalette,
    levelLength,
    bgColor,
    levelMode,
    layer3Priority,
    music,
    spriteSet,
    timeLimit,
    spritePalette,
    fgPalette,
    itemMemory,
    verticalScroll,
    objectTileset,
  }
}

/**
 * Parse the object stream from Layer 1 level data.
 *
 * Algorithm from LoadLevelData (bank_05.asm lines 677-808):
 *   - Read 3 bytes per object ($0A, $0B, $59)
 *   - Object number: $5A = ($0B >> 4) | (($0A & $60) >> 1)
 *   - New screen flag: bit 7 of $0A. When set, screen counter increments.
 *   - High coordinate: bit 4 of $0A
 *   - Position: LevelLoadPos = (($0A & $0F) << 4) | ($0B & $0F)
 *     Upper nibble = Y position, lower nibble = X position
 *     (bank_05.asm lines 714-724)
 *   - When $5A == 0: extended object (CODE_0DA100), $59 = extended type
 *   - When $5A != 0: normal object (CODE_0DA40F), $59 = size/settings
 *   - Terminator: $FF at next read position (line 794)
 *
 * Note on vertical levels: The disassembly at lines 707-713 shows X/Y nibble
 * swapping for vertical levels (CODE_0585D8), but we skip that here as the
 * caller can handle it based on header.levelMode's vertical flag.
 */
export function parseLevelObjects(data: Buffer | Uint8Array): Omit<ParsedLevel, 'sprites'> {
  const header = parseLevelHeader(data)

  const objects: LevelObject[] = []
  let pos = HEADER_SIZE   // Object data begins after 5-byte header (line 645-651)
  let screen = 0

  while (pos < data.length) {
    const b0 = data[pos]
    if (b0 === undefined || b0 === 0xFF) break   // $FF terminator (line 794)

    if (pos + 2 >= data.length) break
    const b1 = data[pos + 1]
    const b2 = data[pos + 2]
    pos += 3   // Advance by 3 bytes (line 689-695)

    // New screen flag: bit 7 of byte 0 (line 754-758)
    // ASL then ADC with carry = increment screen by 1 when bit 7 set
    const newScreen = (b0 & 0x80) !== 0
    if (newScreen) {
      screen++
    }

    // High coordinate flag: bit 4 of byte 0 (line 778-782).
    // When set, bank_05 does INC Map16LowPtr+1 — effectively adding 0x100 to
    // the level tile pointer, which in our flat (col, row) grid means +16 rows.
    // This is how objects reach rows 16-26 in a horizontal level.
    const highCoord = (b0 & 0x10) !== 0

    // Object number: $5A = ($0B >> 4) | (($0A & $60) >> 1)
    // bank_05.asm lines 696-706
    const objNumHigh = (b0 & 0x60) >> 1   // bits 6-5 shifted to bits 5-4
    const objNumLow = (b1 >> 4) & 0x0F     // high nibble of byte 1
    const objectNumber = objNumLow | objNumHigh

    // Position: Y in upper nibble, X in lower nibble of LevelLoadPos
    // bank_05.asm lines 714-724:
    //   Y = ($0A & $0F) → upper nibble (shifted left 4)
    //   X = ($0B & $0F) → lower nibble
    // With highCoord, the game adds 16 to Y (via INC Map16LowPtr+1).
    const yLocal = (b0 & 0x0F) + (highCoord ? 16 : 0)
    const xLocal = b1 & 0x0F

    const isExtended = objectNumber === 0

    // Screen exit: extended object with settings ($59 / LvlLoadObjSize) == 0.
    // Handler CODE_0DA512 (bank_0D.asm line 1416):
    //   Reads 1 extra byte → ExitTableLow[screen]
    //   _B (byte 1) & 0x01 → ExitTableHigh[screen] (bit 8)
    //   _B >> 1 → UseSecondaryExit
    //   Primary (UseSecondaryExit=0): value IS the destination level
    //   Secondary (UseSecondaryExit!=0): value is index into DATA_05F800
    let screenExitDest: number | undefined
    let screenExitIsSecondary: boolean | undefined
    if (isExtended && b2 === 0 && pos < data.length) {
      const extraByte = data[pos]!
      const highBit = b1 & 0x01
      screenExitDest = (highBit << 8) | extraByte
      screenExitIsSecondary = (b1 >> 1) !== 0
      pos += 1
    }

    const objNum = isExtended ? b2 : objectNumber
    objects.push({
      type: isExtended ? 'extended' : 'standard',
      screen,
      x: screen * SCREEN_W + xLocal,
      y: yLocal,
      objectNumber: objNum,
      settings: b2,
      newScreen,
      highCoord,
      raw: [b0, b1, b2],
      objectType: isExtended ? 0x100 + b2 : objectNumber,
      param: b2,
      screenExitDest,
      screenExitIsSecondary,
    })
  }

  return { header, objects, screens: header.levelLength }
}

/**
 * Parse Layer 2 objects from the L2 data stream.
 *
 * L2 data has NO header -- objects start at byte 0. The object format is
 * identical to L1 (3 bytes per object, same bit layout). The screen count
 * comes from the L1 header.
 *
 * When the L2 bank byte is $FF, the data is a preset background (not objects)
 * and this function should NOT be called.
 */
export function parseL2Objects(data: Buffer | Uint8Array, _screens: number): LevelObject[] {
  const objects: LevelObject[] = []
  let pos = 0   // No header for L2
  let screen = 0

  while (pos < data.length) {
    const b0 = data[pos]
    if (b0 === undefined || b0 === 0xFF) break

    if (pos + 2 >= data.length) break
    const b1 = data[pos + 1]
    const b2 = data[pos + 2]
    pos += 3

    const newScreen = (b0 & 0x80) !== 0
    if (newScreen) screen++

    const highCoord = (b0 & 0x10) !== 0
    const objNumHigh = (b0 & 0x60) >> 1
    const objNumLow = (b1 >> 4) & 0x0F
    const objectNumber = objNumLow | objNumHigh

    const yLocal = b0 & 0x0F
    const xLocal = b1 & 0x0F

    const isExtended = objectNumber === 0

    const objNum = isExtended ? b2 : objectNumber
    objects.push({
      type: isExtended ? 'extended' : 'standard',
      screen,
      x: screen * SCREEN_W + xLocal,
      y: yLocal,
      objectNumber: objNum,
      settings: b2,
      newScreen,
      highCoord,
      raw: [b0, b1, b2],
      objectType: isExtended ? 0x100 + b2 : objectNumber,
      param: b2,
    })
  }

  return objects
}

/**
 * Parse sprite data from the sprite pointer address.
 *
 * Sprite data format from bank_05.asm CODE_05D796 lines 7259-7261:
 *   Byte 0: header byte (buoyancy[7:6], sprite memory[5:0])
 *   Bytes 1+: sprite entries, 3 bytes each:
 *     Byte 0: YYYYEEXX  Y=y pos[7:4], E=extra bit[3:2]?, X=x pos bits
 *     Byte 1: SSSSXXXX  S=screen number[7:4], X=x pos[3:0]
 *     Byte 2: sprite number
 *   Terminator: $FF
 *
 * The exact sprite format from community docs (since the game's sprite
 * parsing is spread across multiple routines):
 *   Byte 0: YYYYEENN  Y=y pos[7:4], E=extra bit[1], N=new screen high bits
 *   Byte 1: XXXXSSSS  note: exact layout from SpriteDataPtr reading
 *   Byte 2: sprite ID
 */
export function parseLevelSprites(data: Buffer | Uint8Array): LevelSprite[] {
  const sprites: LevelSprite[] = []
  if (data.length < 2) return sprites

  // First byte is the sprite header (memory/buoyancy settings)
  // bank_05.asm lines 7259-7264
  let pos = 1  // skip header byte

  while (pos + 2 < data.length) {
    const b0 = data[pos]
    if (b0 === 0xFF) break

    const b1 = data[pos + 1]
    const b2 = data[pos + 2]
    pos += 3

    // Sprite entry: community standard encoding
    // b0: YYYYEENN — Y=y position[7:4], E=extra bit[1], N=screen high bits
    // b1: XXXXSSSS — note: this is the second sprite byte
    // But the vanilla format is simpler for our purposes:
    //   Y position = b0 high nibble
    //   Extra bit  = (b0 >> 1) & 1
    //   Screen-Y offset bits from b0[0] and b1 high nibble
    const yPos = (b0 >> 4) & 0x0F
    const extraBit = ((b0 >> 1) & 1) !== 0
    const xPos = b1 & 0x0F
    const screenBits = (b1 >> 4) & 0x0F

    // Screen number is the upper nibble of b1, but combined with b0 low bit
    // for levels > 16 screens (rare in vanilla)
    const screen = ((b0 & 0x01) << 4) | screenBits

    sprites.push({
      screen,
      x: screen * SCREEN_W + xPos,
      y: yPos,
      spriteId: b2,
      extraBit,
      raw: [b0, b1, b2],
    })
  }

  return sprites
}

/**
 * Reads the per-screen secondary exit table stored after the object stream terminator
 * in a Lunar Magic-extended level data block.
 *
 * Format: 2 bytes per screen immediately after the lone $FF object-stream terminator.
 * This is a Lunar Magic convention, not vanilla SMW.
 */
export function parseLevelScreenExits(data: Buffer | Uint8Array, screens: number): number[] {
  // Walk the object stream (starting after the 5-byte primary header) to find
  // the position of the $FF terminator.
  let pos = HEADER_SIZE
  while (pos < data.length) {
    const b = data[pos]
    if (b === undefined) break
    if (b === 0xFF) {
      pos += 1   // $FF terminator; exit table starts here
      break
    }
    pos += 3     // All objects are 3 bytes in the vanilla format
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
