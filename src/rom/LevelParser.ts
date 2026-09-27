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
/** Tiles per screen vertically (horizontal levels). */
export const SCREEN_H = 27
/** Tiles per screen vertically (vertical levels - screens stack downward, 16 rows each). */
export const SCREEN_H_VERT = 16
/** Tiles per screen horizontally (vertical levels - always 32 tiles wide, 2 sub-screens). */
export const SCREEN_W_VERT = 32

/**
 * True if a level's Layer 1 is vertical, per VerticalTable bit 0
 * (CODE_0584E3, bank_05.asm:552, `LDA.L VerticalTable,X`; format per entry
 * `?uuuuu?v`, v=bit 0 = L1 vertical, bit 1 = L2 vertical, bit 7 = a
 * boss-level flag this project does not use). `verticalTable` is read from
 * the ROM by LevelTableGate.readVerticalTable, never transcribed, so a
 * relocated table still resolves and a replaced read is refused rather than
 * answered from the vanilla layout. The game loads this entry into
 * ScreenMode ($7E:005B); rammap.asm:481 confirms `!ScrMode_Layer1Vert = %01`.
 */
export function isLevelModeVertical(levelMode: number, verticalTable: readonly number[]): boolean {
  const entry = verticalTable[levelMode & 0x1f] ?? 0
  return (entry & 0x01) !== 0
}

/**
 * True if a level's Layer 2 is vertical, per VerticalTable bit 1.
 * Per bank_05.asm LoadLevelData (lines 707-715): when LayerProcessing=1 (L2)
 * the game right-shifts ScreenMode once before AND #$01, so L2's vertical bit
 * lives at position 1 of the same table entry.
 */
export function isLevelModeVerticalL2(
  levelMode: number,
  verticalTable: readonly number[],
): boolean {
  const entry = verticalTable[levelMode & 0x1f] ?? 0
  return (entry & 0x02) !== 0
}

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
  raw: number[] // all 5 header bytes
  bgPalette: number // 3-bit BG palette row (byte 0 bits 7-5)     -- CODE_0584E3 line 530-536
  levelLength: number // 5-bit screen count (byte 0 bits 4-0) + 1   -- CODE_0584E3 line 527-529
  bgColor: number // 3-bit back area color (byte 1 bits 7-5)    -- CODE_0584E3 line 562-568
  levelMode: number // 5-bit level mode (byte 1 bits 4-0)         -- CODE_0584E3 line 539-540
  layer3Priority: boolean // byte 2 bit 7                              -- CODE_0584E3 line 590-597
  music: number // 3-bit music index (byte 2 bits 6-4)        -- CODE_0584E3 line 575-581
  spriteSet: number // 4-bit sprite tileset (byte 2 bits 3-0)     -- CODE_0584E3 line 573-574
  timeLimit: number // 2-bit time limit (byte 3 bits 7-6)         -- CODE_0584E3 line 601-607
  spritePalette: number // 3-bit sprite palette (byte 3 bits 5-3)     -- CODE_0584E3 line 617-622
  fgPalette: number // 3-bit FG palette (byte 3 bits 2-0)         -- CODE_0584E3 line 614-616
  itemMemory: number // 2-bit item memory (byte 4 bits 7-6)        -- CODE_0584E3 line 628-633
  verticalScroll: number // 2-bit vertical scroll (byte 4 bits 5-4)    -- CODE_0584E3 line 634-644
  objectTileset: number // 4-bit object tileset (byte 4 bits 3-0)     -- CODE_0584E3 line 625-627
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
  screen: number // which screen this object is on (new-screen flag tracking)
  x: number // tile X position (absolute: screen * 16 + local x nibble)
  y: number // tile Y position (local within screen)
  objectNumber: number // 6-bit object number ($5A) for normal; extended type ($59) for ext
  settings: number // byte 2 ($59) -- size/settings
  newScreen: boolean // new screen flag (byte 0 bit 7)
  highCoord: boolean // high coordinate flag (byte 0 bit 4)
  raw: number[] // original 3 bytes
  /**
   * Byte offset of this object's first byte within the raw L1 data, counted
   * from the start of the 5-byte header. Not uniform: most objects are 3
   * bytes but a screen exit consumes a 4th, so a caller cannot derive this by
   * multiplying an index. Needed to turn an edit into a ROM byte patch.
   */
  streamOffset: number
  // Backward-compatible aliases used by webview/providers:
  objectType: number // = objectNumber for normal, 0x100+objectNumber for extended
  param: number // = settings
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
  extraBit: boolean // sprite header extra bit
  raw: number[]
  /** Position in the sprite stream. The stable way to name a sprite for an
   *  edit: x/y change the moment it is moved, so they cannot identify it. */
  index: number
  /** Byte offset of this sprite's first byte within the raw sprite data. */
  streamOffset: number
}

export interface ParsedLevel {
  header: LevelHeader
  objects: LevelObject[]
  sprites: LevelSprite[]
  screens: number
  /** True for Layer-1-vertical levels (VerticalTable[levelMode] bit 0 set). */
  isVertical: boolean
}

const HEADER_SIZE = 5 // bytes before object data begins (CODE_0584E3 line 645-651)

/**
 * Parse the 5-byte level header from raw L1 data.
 * Exact bit extractions from CODE_0584E3 (bank_05.asm lines 523-652).
 */
export function parseLevelHeader(data: Buffer | Uint8Array): LevelHeader {
  const h = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0, data[4] ?? 0]

  // Byte 0: PPPNNNNN
  // Line 527: AND #$1F -> screens-1; Line 528: INC A -> screens
  // Line 530-536: LSR x5 -> BG palette
  const levelLength = (h[0] & 0x1f) + 1
  const bgPalette = (h[0] >> 5) & 0x07

  // Byte 1: BBBMMMMM
  // Line 539: AND #$1F -> level mode
  // Line 562-568: LSR x5 -> back area color
  const levelMode = h[1] & 0x1f
  const bgColor = (h[1] >> 5) & 0x07

  // Byte 2: LMMMSSSS
  // Line 573: AND #$0F -> sprite tileset
  // Line 576-580: LSR x4, AND #$07 -> music
  // Line 590-591: AND #$80 -> layer 3 priority flag
  const spriteSet = h[2] & 0x0f
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
  const objectTileset = h[4] & 0x0f
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
 * Vertical levels: In vertical mode (ScreenMode bit 0 set per VerticalTable),
 * the game calls CODE_0585D8 (bank_05.asm:654-675) which swaps the low
 * nibbles of bytes 0 and 1. The Map16 RAM layout for vertical levels is
 * TWO 16-wide half-screens concatenated, each row-major (bank_00.asm:6763
 * DATA_00BB38, stride $200 per screen; `INC Map16LowPtr+1` at line 781
 * adds $100 to skip to the right half). So within a 32×16 screen:
 *
 *   offset = (col // 16) * 256 + (row % 16) * 16 + (col % 16)
 *
 * Trace: b0=0x02, b1=0x13 → swap gives LevelLoadPos = 0x32 = 50 = row 3 *
 * 16 + col 2, placing the tile at (col=2, row=3). Under that constraint:
 *   - X (col) = byte 0 low nibble (original, pre-swap)
 *   - Y (row) = byte 1 low nibble (original, pre-swap)
 *   - highCoord (b0 bit 4) selects the right half → col += 16 (cols 16-31)
 *   - new-screen flag advances downward → row += 16 per screen
 *
 * Net effect in grid space (nibble sources are the SAME as horizontal - only
 * the axis that gets screen*16 and highCoord+16 flips):
 *   horizontal: X = screen*16 + b1_low,        Y = b0_low + (16 if highCoord)
 *   vertical:   X = b0_low + (16 if highCoord), Y = screen*16 + b1_low
 *
 * We detect verticality via isLevelModeVertical(header.levelMode, verticalTable)
 * and emit absolute (x, y) coordinates in a 32 × (screens*16) grid.
 *
 * @param verticalTable  VerticalTable's 32 bytes, from LevelTableGate.readVerticalTable.
 */
export function parseLevelObjects(
  data: Buffer | Uint8Array,
  verticalTable: readonly number[],
): Omit<ParsedLevel, 'sprites'> & { terminated: boolean } {
  const header = parseLevelHeader(data)
  const isVertical = isLevelModeVertical(header.levelMode, verticalTable)

  const objects: LevelObject[] = []
  let pos = HEADER_SIZE // Object data begins after 5-byte header (line 645-651)
  let screen = 0

  while (pos < data.length) {
    const b0 = data[pos]
    if (b0 === undefined || b0 === 0xff) break // $FF terminator (line 794)

    if (pos + 2 >= data.length) break
    const b1 = data[pos + 1]
    const b2 = data[pos + 2]
    const streamOffset = pos
    pos += 3 // Advance by 3 bytes (line 689-695)

    // New screen flag: bit 7 of byte 0 (line 754-758)
    // ASL then ADC with carry = increment screen by 1 when bit 7 set
    const newScreen = (b0 & 0x80) !== 0
    if (newScreen) {
      screen++
    }

    // High coordinate flag: bit 4 of byte 0 (line 778-782).
    // Horizontal: INC Map16LowPtr+1 → +16 rows (reach rows 16-26 below row 15).
    // Vertical:   same flag → "right half of vertical level" (cols 16-31).
    const highCoord = (b0 & 0x10) !== 0

    // Object number: $5A = ($0B >> 4) | (($0A & $60) >> 1)
    // bank_05.asm lines 696-706 (computed BEFORE the XY swap, so using raw b0/b1)
    const objNumHigh = (b0 & 0x60) >> 1 // bits 6-5 shifted to bits 5-4
    const objNumLow = (b1 >> 4) & 0x0f // high nibble of byte 1
    const objectNumber = objNumLow | objNumHigh

    // Position decoding - bank_05.asm lines 714-724.
    // Horizontal: Y = b0 low, X = b1 low (within 16-col screen at column screen*16).
    // Vertical:   after CODE_0585D8 low-nibble swap, the game interprets positions
    //             against vertical Map16 tables. Net effect in grid space:
    //               X = b0 low + (highCoord ? 16 : 0)   (0..31, whole level width)
    //               Y = b1 low + screen * 16            (screens stack down)
    let xLocal: number
    let yLocal: number
    let xAbs: number
    let yAbs: number
    if (isVertical) {
      xLocal = b0 & 0x0f
      yLocal = b1 & 0x0f
      xAbs = xLocal + (highCoord ? 16 : 0)
      yAbs = screen * 16 + yLocal
    } else {
      yLocal = (b0 & 0x0f) + (highCoord ? 16 : 0)
      xLocal = b1 & 0x0f
      xAbs = screen * SCREEN_W + xLocal
      yAbs = yLocal
    }

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
      screenExitIsSecondary = b1 >> 1 !== 0
      pos += 1
    }

    const objNum = isExtended ? b2 : objectNumber
    objects.push({
      streamOffset,
      type: isExtended ? 'extended' : 'standard',
      screen,
      x: xAbs,
      y: yAbs,
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

    // Extended object $01 - CODE_0DA53D (bank_0D.asm line 1441):
    //   LDA _A; AND #$1F; STA LevelLoadObject
    // Overwrites the screen counter with the low 5 bits of byte 0. This lets
    // level data jump forward to an arbitrary screen without emitting tiles.
    // Must run after the NS-increment for this object so subsequent objects
    // are positioned relative to the new screen value.
    if (isExtended && b2 === 0x01) {
      screen = b0 & 0x1f
    }
  }

  // False when the walk ran off the buffer instead of stopping on $FF, which
  // means it lost sync with the stream and the object list is not trustworthy.
  const terminated = data[pos] === 0xff
  return { header, objects, screens: header.levelLength, isVertical, terminated }
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
 *
 * L2 verticality is governed by ScreenMode bit 1 (rammap.asm:482), which for
 * vanilla levels tracks L1 verticality closely. Callers pass the flag down
 * from the L1 header's levelMode.
 */
export function parseL2Objects(
  data: Buffer | Uint8Array,
  _screens: number,
  isVertical = false,
): LevelObject[] {
  const objects: LevelObject[] = []
  // bank_05.asm:462-470 copies Layer2DataPtr+5 into Layer1DataPtr before
  // re-running LoadLevelData with LayerProcessing=1, so the object parser
  // starts 5 bytes past the L2 stream's start. The first 5 bytes are the
  // L2 "header" (the game discards them whether they're meaningful or not).
  // Earlier versions used `pos = 0` which read those 5 bytes as objects,
  // throwing the entire stream out of alignment.
  let pos = HEADER_SIZE
  let screen = 0

  while (pos < data.length) {
    const b0 = data[pos]
    if (b0 === undefined || b0 === 0xff) break

    if (pos + 2 >= data.length) break
    const b1 = data[pos + 1]
    const b2 = data[pos + 2]
    const streamOffset = pos
    pos += 3

    const newScreen = (b0 & 0x80) !== 0
    if (newScreen) screen++

    const highCoord = (b0 & 0x10) !== 0
    const objNumHigh = (b0 & 0x60) >> 1
    const objNumLow = (b1 >> 4) & 0x0f
    const objectNumber = objNumLow | objNumHigh

    let xAbs: number
    let yAbs: number
    if (isVertical) {
      xAbs = (b0 & 0x0f) + (highCoord ? 16 : 0)
      yAbs = screen * 16 + (b1 & 0x0f)
    } else {
      // Horizontal: highCoord (b0 bit 4) extends Y past row 15 into rows
      // 16-26 of the 27-row screen - matches parseLevelObjects line 285,
      // which mirrors bank_05.asm:778-782 ("INC Map16LowPtr+1 → +16 rows").
      // Missing this shifted half of $009's L2 structures (and others) up
      // by 256 px in the editor.
      xAbs = screen * SCREEN_W + (b1 & 0x0f)
      yAbs = (b0 & 0x0f) + (highCoord ? 16 : 0)
    }

    const isExtended = objectNumber === 0

    const objNum = isExtended ? b2 : objectNumber
    objects.push({
      streamOffset,
      type: isExtended ? 'extended' : 'standard',
      screen,
      x: xAbs,
      y: yAbs,
      objectNumber: objNum,
      settings: b2,
      newScreen,
      highCoord,
      raw: [b0, b1, b2],
      objectType: isExtended ? 0x100 + b2 : objectNumber,
      param: b2,
    })

    // Ext $01 screen-jump: see parseLevelObjects for the ASM reference.
    if (isExtended && b2 === 0x01) {
      screen = b0 & 0x1f
    }
  }

  return objects
}

/**
 * Parse sprite data from the sprite pointer address.
 *
 * Header byte (pos 0) carries sprite-memory/buoyancy settings
 * (see bank_05.asm CODE_05D796 lines 7259-7264). Each sprite entry is
 * 3 bytes, and the stream ends at $FF.
 *
 * Byte layout per bank_02.asm LoadSprFromLevel (lines 5240-5451):
 *   Byte 0: YYYYEEsy
 *     bits 7-4 = Y position within screen, in tiles (16px units)
 *     bits 3-2 = extra bits (EE) - Lunar Magic uses for extended sprite banks
 *     bit 1    = screen-number high bit (s), combined with SSSS to form 5-bit screen
 *     bit 0    = Y-position high bit (y), used only by vertical levels
 *   Byte 1: XXXXSSSS
 *     bits 7-4 = X position within screen, in tiles
 *     bits 3-0 = screen number low 4 bits
 *   Byte 2: sprite ID
 *
 * ASM evidence that the nibbles of byte 1 are X-high, screen-low:
 *   line 5263: AND.B #$0F  → masks SSSS, compares vs current screen ($_1)
 *   line 5279: AND.B #$F0  → masks XXXX, compares vs screen-relative X ($_0)
 *
 * For vertical levels (ScreenMode bit 0 set) the parser swaps: YYYY becomes
 * the X-within-screen and XXXX becomes the Y-within-screen (ASM path at
 * CODE_02A93C, lines 5427-5438).
 */
export function parseLevelSprites(data: Buffer | Uint8Array, isVertical = false): LevelSprite[] {
  const sprites: LevelSprite[] = []
  if (data.length < 2) return sprites

  let pos = 1 // skip header byte

  while (pos + 2 < data.length) {
    const b0 = data[pos]
    if (b0 === 0xff) break

    const b1 = data[pos + 1]
    const b2 = data[pos + 2]
    const streamOffset = pos
    pos += 3

    const yyyy = (b0 >> 4) & 0x0f
    const extraBits = (b0 >> 2) & 0x03
    const screenHi = (b0 >> 1) & 0x01
    const yHi = b0 & 0x01
    const xxxx = (b1 >> 4) & 0x0f
    const ssss = b1 & 0x0f

    const screen = (screenHi << 4) | ssss

    // Vertical levels swap the meaning of YYYY and XXXX; SSSS still indexes
    // the (vertical) screen. See bank_02.asm:5427-5437 - YYYY→X low byte,
    // bit 0 (y)→X high byte so X spans SCREEN_W_VERT=32 tiles.
    //
    // Horizontal levels put the y bit into the high byte of Y position
    // (bank_02.asm:5446, AND #$0D then STA SpriteYPosHigh) - combined with
    // YYYY*16 pixel low byte, Y spans 0..511 pixels (0..31 tiles), which
    // covers the 27-tile-tall horizontal screen.
    let x: number
    let y: number
    if (isVertical) {
      x = yyyy + (yHi << 4)
      y = screen * SCREEN_H_VERT + xxxx
    } else {
      x = screen * SCREEN_W + xxxx
      y = yyyy + (yHi << 4)
    }

    sprites.push({
      index: sprites.length,
      streamOffset,
      screen,
      x,
      y,
      spriteId: b2,
      extraBit: extraBits !== 0,
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
    if (b === 0xff) {
      pos += 1 // $FF terminator; exit table starts here
      break
    }
    pos += 3 // All objects are 3 bytes in the vanilla format
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

/**
 * Walk an L1 or L2 object stream and return its total byte length
 * (inclusive of the $FF terminator).
 *
 * Position-advancement rules mirror parseLevelObjects (bank_05.asm LoadLevelData
 * lines 677-808). A screen-exit extended object (objNum==0 and settings byte==0)
 * consumes one extra byte (bank_0D.asm CODE_0DA512 line 1416).
 *
 * When `hasHeader` is true, skips the 5-byte primary level header (L1 layout).
 * When false, parsing starts at byte 0 (L2 layout).
 *
 * Returns the byte count from the start of `data` up to and including the
 * terminator. If no terminator is found before the end of `data`, returns the
 * total data length.
 */
export function getObjectStreamLength(data: Buffer | Uint8Array, hasHeader: boolean): number {
  let pos = hasHeader ? HEADER_SIZE : 0
  while (pos < data.length) {
    const b0 = data[pos]
    if (b0 === undefined) return pos
    if (b0 === 0xff) return pos + 1
    if (pos + 2 >= data.length) return pos
    const b1 = data[pos + 1]!
    const b2 = data[pos + 2]!
    pos += 3
    const objNum = ((b0 & 0x60) >> 1) | ((b1 >> 4) & 0x0f)
    if (objNum === 0 && b2 === 0) pos += 1
  }
  return pos
}

/**
 * Walk a sprite stream and return its total byte length
 * (1-byte header + 3-byte sprite entries + $FF terminator).
 */
export function getSpriteStreamLength(data: Buffer | Uint8Array): number {
  let pos = 1 // skip 1-byte sprite-memory/buoyancy header
  while (pos < data.length) {
    const b0 = data[pos]
    if (b0 === undefined) return pos
    if (b0 === 0xff) return pos + 1
    pos += 3
  }
  return pos
}
