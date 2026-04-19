/**
 * SmwRom.ts -- ROM access and level enumeration for Super Mario World.
 *
 * Derived from SMWDisX disassembly:
 *   - Layer1Ptrs: bank_05.asm line 7680 (L1 pointer table at $05E000)
 *   - Layer2Ptrs: bank_05.asm line 8194 (L2 pointer table at $05E600)
 *   - Ptrs05EC00: bank_05.asm line 8708 (sprite pointer table at $05EC00)
 *   - CODE_05D796: bank_05.asm line 7079 (level load / translevel conversion)
 *   - CODE_05D8B7: bank_05.asm lines 7228-7258 (pointer table indexing)
 *
 * Pointer table layout (bank_05.asm lines 7228-7258):
 *   Level number is multiplied by 3 for L1/L2 (3-byte interleaved: lo, hi, bank)
 *   Level number is multiplied by 2 for sprites (2-byte: lo, hi; bank always $07)
 *
 * Translevel conversion (CODE_05D8A2, line 7217-7222):
 *   If translevel >= $25, subtract $24 to get the level index.
 *   Combined with submap flag to form the full 9-bit level number.
 */

import { RomFile } from './RomFile'
import { parseLevelObjects } from './LevelParser'
import { getLevelNameByIndex } from './SmwLevelNames'

/** SNES addresses for SMW ROM structures. */
export const ADDR = {
  ROM_NAME:         0x00FFC0,
  ROM_SPEED_MAP:    0x00FFD5,
  ROM_SIZE:         0x00FFD7,
  SRAM_SIZE:        0x00FFD8,

  // Layer 1 pointer table: interleaved 3-byte entries (lo, hi, bank).
  // bank_05.asm line 7680: Layer1Ptrs at $05E000.
  // 512 entries x 3 bytes = $600 bytes ($05E000-$05E5FF).
  LEVEL_L1_PTR:     0x05E000,
  LEVEL_L1_LOW:     0x05E000,

  // Layer 2 pointer table: same 3-byte layout.
  // bank_05.asm line 8194: Layer2Ptrs at $05E600.
  LEVEL_L2_PTR:     0x05E600,

  // Sprite pointer table: 2-byte entries (lo, hi), bank always $07.
  // bank_05.asm line 8708: Ptrs05EC00 at $05EC00.
  LEVEL_SPR_PTR:    0x05EC00,
  LEVEL_SPR_LOW:    0x05EC00,

  // Map16 tile data
  MAP16_LOW:        0x0D8000,
  MAP16_HIGH:       0x0DC000,

  // GFX tileset lookup: $05D760[spriteSet] -> tileset index
  // bank_05.asm: referenced in the game's sprite tileset loading
  TILESETID_TABLE:  0x05D760,

  // Secondary entrance tables (bank_05.asm CODE_05D796 lines 7117-7161)
  SEC_EXIT_DEST:    0x05F800,   // DATA_05F800: lo byte of destination
  SEC_EXIT_LO:      0x05FA00,   // DATA_05FA00: BG/FG/Mario Y pos info
  SEC_EXIT_SCREEN:  0x05FC00,   // DATA_05FC00: Mario X pos + screen
  SEC_EXIT_FLAGS:   0x05FE00,   // DATA_05FE00: flags (action, slippery, dest hi bit)

  SEC_ENTRANCE_COUNT: 512,

  // Overworld translevel table
  OW_TRANSLEVEL:    0x049E00,   // OWLayer1Translevel (bank_05.asm line 7214)

  // Global palette
  GLOBAL_PALETTE:   0x00B0A0,
} as const

const SMW_ROM_NAME = 'SUPER MARIOWORLD'
export const LEVEL_COUNT = 0x200

/**
 * Overworld-accessible level pointer table ranges.
 *
 * From CODE_05D8A2 (bank_05.asm line 7217):
 *   Translevel $00-$24 -> room $000-$024 (main overworld, 37 slots)
 *   Translevel $25-$5F -> room $101-$13B (submaps, 59 slots)
 *     (subtract $24, then add $100 for submap flag)
 */
export function isOverworldLevel(index: number): boolean {
  return (index >= 0x000 && index <= 0x024) || (index >= 0x101 && index <= 0x13B)
}

export interface RomSummary {
  filePath: string
  internalName: string
  romSizeKb: number
  sramSizeKb: number
  hasHeader: boolean
  romSize: number
  isVanilla: boolean
}

export class SmwRom {
  readonly rom: RomFile

  constructor(romFile: RomFile) {
    this.rom = romFile
    this._validateOrWarn()
  }

  static open(filePath: string): SmwRom {
    return new SmwRom(RomFile.load(filePath))
  }

  private _validateOrWarn(): void {
    const mapMode = this.rom.readByte(ADDR.ROM_SPEED_MAP)
    if (mapMode !== 0x20 && mapMode !== 0x30) {
      throw new Error(
        `Unexpected ROM map mode: $${mapMode?.toString(16).toUpperCase()} ` +
        `(expected $20 or $30 for LoROM)`
      )
    }
  }

  get internalName(): string { return this.rom.readString(ADDR.ROM_NAME, 21) }
  get romSizeKb(): number { const n = this.rom.readByte(ADDR.ROM_SIZE); return n ? (1 << n) : 0 }
  get sramSizeKb(): number { const n = this.rom.readByte(ADDR.SRAM_SIZE); return n ? (1 << n) : 0 }

  getSummary(): RomSummary {
    return {
      filePath: this.rom.filePath,
      internalName: this.internalName,
      romSizeKb: this.romSizeKb,
      sramSizeKb: this.sramSizeKb,
      hasHeader: this.rom.hasHeader,
      romSize: this.rom.romSize,
      isVanilla: this.internalName.startsWith(SMW_ROM_NAME),
    }
  }

  /**
   * Read the L1 pointer for a level.
   *
   * From CODE_05D8B7 (bank_05.asm lines 7228-7240):
   *   Y = levelNumber * 3 (each entry is 3 bytes: lo, hi, bank)
   *   ptr = Layer1Ptrs[Y] | (Layer1Ptrs[Y+1] << 8) | (Layer1Ptrs[Y+2] << 16)
   */
  getLevelL1Pointer(index: number): number | null {
    const base = ADDR.LEVEL_L1_PTR + index * 3
    const lo = this.rom.readByte(base)
    const hi = this.rom.readByte(base + 1)
    const bk = this.rom.readByte(base + 2)
    if (lo === null || hi === null || bk === null) return null
    return (bk << 16) | (hi << 8) | lo
  }

  /**
   * Read the L2 pointer for a level.
   *
   * Same 3-byte layout as L1. Bank byte = $FF means preset background.
   * (bank_05.asm lines 7241-7246)
   */
  getLevelL2Pointer(index: number): number | null {
    const base = ADDR.LEVEL_L2_PTR + index * 3
    const lo = this.rom.readByte(base)
    const hi = this.rom.readByte(base + 1)
    const bk = this.rom.readByte(base + 2)
    if (lo === null || hi === null || bk === null) return null
    return (bk << 16) | (hi << 8) | lo
  }

  /**
   * Read the sprite pointer for a level.
   *
   * From CODE_05D8B7 (bank_05.asm lines 7248-7258):
   *   Y = levelNumber * 2 (each entry is 2 bytes: lo, hi)
   *   bank is always $07 (line 7257: LDA #$07 / STA SpriteDataPtr+2)
   */
  getLevelSpritePointer(index: number): number | null {
    const base = ADDR.LEVEL_SPR_PTR + index * 2
    const lo = this.rom.readByte(base)
    const hi = this.rom.readByte(base + 1)
    if (lo === null || hi === null) return null
    return (0x07 << 16) | (hi << 8) | lo
  }

  getAllLevelPointers(): Array<{ index: number; address: number | null }> {
    return Array.from({ length: LEVEL_COUNT }, (_, i) => ({
      index: i,
      address: this.getLevelL1Pointer(i)
    }))
  }

  /**
   * Read enough of a level's Layer-1 stream to cover the object data AND
   * the Lunar Magic per-screen exit table that follows the $FF terminator.
   *
   * Why not a fixed 512 bytes (the original behavior)?
   *   Vanilla levels are tiny, but LM-extended L1 streams can exceed 512 bytes
   *   (confirmed: sublevel $103 is ~655 bytes of object data alone). Truncating
   *   at 512 drops tail objects and silently breaks rendering.
   *
   * Strategy:
   *   Read a generous ceiling (0x2000 = 8 KB) and let callers stop at the first
   *   $FF in the object stream. Vanilla max L1 is well under 1 KB; even
   *   heavily-expanded LM levels fit in a few KB. We also fall back to
   *   progressively smaller reads if the level's pointer lands near the end
   *   of the ROM buffer (RomFile.readAt returns null when the read would
   *   exceed file length).
   *
   *   This is the smallest safe change: parseLevelObjects and
   *   parseLevelScreenExits both terminate on $FF, so over-reading is
   *   harmless. The alternative (walk-and-measure) gives an exactly-sized
   *   buffer but adds complexity for no caller benefit.
   */
  getLevelRawData(index: number): Buffer | null {
    const ptr = this.getLevelL1Pointer(index)
    if (!ptr) return null
    // Try a generous ceiling first, then fall back for pointers near EOF.
    for (const len of [0x2000, 0x1000, 0x800, 0x400, 0x200]) {
      const buf = this.rom.readAt(ptr, len)
      if (buf) return buf
    }
    return null
  }

  /**
   * Returns the GFX tileset index for a level.
   *
   * From bank_05.asm: tilesetId = ROM[$05D760 + spriteSet]
   * The spriteSet comes from header byte 2 bits 3-0 (CODE_0584E3 line 573).
   */
  getGfxTilesetId(index: number): number {
    const ptr = this.getLevelL1Pointer(index)
    if (!ptr) return 0
    const buf = this.rom.readAt(ptr, 5)
    if (!buf || buf.length < 5) return 0
    // Header byte 2 bits 3-0 = sprite tileset (CODE_0584E3 line 573)
    const spriteSet = buf[2] & 0x0F
    return this.rom.readByte(ADDR.TILESETID_TABLE + spriteSet) ?? 0
  }

  /**
   * Returns true if the level has valid object data.
   *
   * Bank byte validation: vanilla level data is in banks $02-$09.
   * Level mode check: modes 0-20 are valid (CODE_0584E3 line 539).
   */
  levelHasObjects(index: number): boolean {
    const data = this.getLevelRawData(index)
    if (data === null || data.length <= 5) return false

    const levelMode = data[1] & 0x1F
    if (levelMode > 20) return false

    // data[5] is first object byte; 0xFF = immediate terminator
    return data[5] !== 0xFF
  }

  /**
   * Classify all levels into overworld-accessible and sub-area groups.
   */
  classifyLevels(): { overworld: number[]; subarea: number[] } {
    const overworld: number[] = []
    const subarea: number[] = []
    const seenPointers = new Set<number>()

    for (let i = 0; i < LEVEL_COUNT; i++) {
      const ptr = this.getLevelL1Pointer(i)
      if (!ptr) continue
      if (seenPointers.has(ptr)) continue

      if (!this.levelHasObjects(i)) continue
      seenPointers.add(ptr)

      if (isOverworldLevel(i)) {
        overworld.push(i)
      } else {
        subarea.push(i)
      }
    }

    return { overworld, subarea }
  }

  /**
   * Build exit graph: sourceLevelIndex → [destLevelIndex].
   *
   * For each level, parse its L1 data to find screen exit entrance indices,
   * then look up destinations in the secondary entrance table at $05F800.
   *
   * Screen exits in vanilla SMW are encoded in the level's object stream.
   * The game stores per-screen exit data when loading a level. We parse
   * the level data to find which secondary entrance indices each level uses,
   * then resolve destinations via DATA_05F800.
   *
   * Additionally, the level header's L2 pointer with bank=$FF indicates
   * a secondary entrance destination (the lo/hi bytes form the dest level).
   */
  buildLevelExitGraph(): Map<number, number[]> {
    const { subarea } = this.classifyLevels()
    const validDestinations = new Set<number>(subarea)

    // Read the secondary entrance destination table
    const destTable  = this.rom.readAt(ADDR.SEC_EXIT_DEST,  ADDR.SEC_ENTRANCE_COUNT)
    const flagsTable = this.rom.readAt(ADDR.SEC_EXIT_FLAGS, ADDR.SEC_ENTRANCE_COUNT)
    if (!destTable || !flagsTable) return new Map()

    // Build entranceIdx → destLevel lookup
    const entranceToDest = new Map<number, number>()
    const n = Math.min(destTable.length, flagsTable.length)
    for (let i = 0; i < n; i++) {
      const flags  = flagsTable[i]
      const destLo = destTable[i]
      if (flags === undefined || destLo === undefined) continue
      const dest = (((flags >> 3) & 1) << 8) | destLo
      if (validDestinations.has(dest)) {
        entranceToDest.set(i, dest)
      }
    }

    const graph = new Map<number, number[]>()

    // For each level with data, find screen exit objects in the L1 stream.
    // Screen exits are extended objects (objectNumber=0, settings=0) that
    // have an extra byte: the secondary entrance index.
    for (let levelIdx = 0; levelIdx < LEVEL_COUNT; levelIdx++) {
      const rawL1 = this.getLevelRawData(levelIdx)
      if (!rawL1 || rawL1.length < 6) continue

      let parsed
      try { parsed = parseLevelObjects(rawL1) } catch { continue }

      const dests: number[] = []
      for (const obj of parsed.objects) {
        if (obj.screenExitDest === undefined) continue
        let dest: number
        if (obj.screenExitIsSecondary) {
          // Secondary exit: look up destination in DATA_05F800 table
          const resolved = entranceToDest.get(obj.screenExitDest)
          if (resolved === undefined) continue
          dest = resolved
        } else {
          // Primary exit: value IS the destination level directly
          dest = obj.screenExitDest
        }
        if (dest !== levelIdx && !dests.includes(dest)) {
          dests.push(dest)
        }
      }

      if (dests.length > 0) {
        graph.set(levelIdx, dests)
      }
    }

    return graph
  }

  /** Get level name from ROM (decoded via SmwLevelNames). */
  getLevelName(index: number): string | null {
    return getLevelNameByIndex(this.rom, index)
  }

  /** Enumerate all 512 pointer table slots, returning metadata for each. */
  enumerateAllLevels(): Array<{ index: number; hasData: boolean; name: string | null }> {
    const results: Array<{ index: number; hasData: boolean; name: string | null }> = []
    for (let i = 0; i < 0x200; i++) {
      const ptr = this.getLevelL1Pointer(i)
      let hasData = false
      if (ptr !== null) {
        const data = this.rom.readAt(ptr, 6)
        if (data && data.length >= 6) {
          const mode = data[1] & 0x1F
          hasData = mode <= 0x1F && data[5] !== undefined
        }
      }
      results.push({ index: i, hasData, name: hasData ? this.getLevelName(i) : null })
    }
    return results
  }
}
