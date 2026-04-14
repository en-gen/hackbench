import { RomFile } from './RomFile'

/** SNES addresses for SMW ROM structures. */
export const ADDR = {
  ROM_NAME:         0x00FFC0,
  ROM_SPEED_MAP:    0x00FFD5,
  ROM_SIZE:         0x00FFD7,
  SRAM_SIZE:        0x00FFD8,

  // Level layer-1 object pointer table — interleaved 3-byte entries (lo, hi, bank).
  // 512 entries × 3 bytes = $600 bytes ($05E000–$05E5FF).
  LEVEL_L1_PTR:     0x05E000,
  LEVEL_L1_LOW:     0x05E000,   // alias (base address, index * 3 to find entry)

  // Level sprite pointer table — same interleaved 3-byte layout.
  // 512 entries × 3 bytes = $600 bytes ($05EC00–$05F1FF).
  LEVEL_SPR_PTR:    0x05EC00,
  LEVEL_SPR_LOW:    0x05EC00,   // alias

  // Map16 tile data
  MAP16_LOW:        0x0D8000,
  MAP16_HIGH:       0x0DC000,

  // GFX files base address
  GFX_BASE:         0x088000,
  GFX_FILE_SIZE:    0x600,    // bytes per GFX file (3BPP, 0x40 = 64 tiles)

  // GFX tileset lookup table: $05D760[spriteSet] → GFX tileset index (used to index $00A92B)
  // Confirmed via Mesen2 watchpoint: STA $1931 ← LDA $05D760,X where X = spriteSet.
  // e.g. spriteSet=8 (Yoshi's Island 1) → $05D760[8] = 7 → FGBG table entry 7.
  TILESETID_TABLE:  0x05D760,

  // Layer 2 pointer table — interleaved 3-byte entries (lo, hi, bank).
  // 512 entries × 3 bytes = $600 bytes ($05E600–$05EBFF).
  LEVEL_L2_PTR:     0x05E600,

  // Secondary entrance tables (midpoints, pipes, doors)
  SEC_EXIT_LO:      0x05FA00,
  SEC_EXIT_SCREEN:  0x05FC00,
  SEC_EXIT_FLAGS:   0x05FE00,

  // Overworld tables
  OW_EXIT_DIRS:     0x04D678,   // 96 bytes, indexed by translevel
  OW_EVENT_ASSOC:   0x05D608,   // event associations, indexed by translevel
  OW_INIT_FLAGS:    0x009EE0,   // initial level flags: [translevel, flags] pairs

  // Global palette
  GLOBAL_PALETTE:   0x00B0A0,
} as const

const SMW_ROM_NAME = 'SUPER MARIOWORLD'
export const LEVEL_COUNT = 0x200

/**
 * Overworld-accessible level pointer table ranges.
 * Derived from the translevel→room conversion at $7E:13BF:
 *   Translevel $00–$24 → room $000–$024  (main overworld, 37 slots)
 *   Translevel $25–$5F → room $101–$13B  (submaps, 59 slots)
 * Total: 96 overworld locations.
 * See docs/smw-overworld-levels.md.
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
        `(expected $20 or $30 for LoROM — is this an SNES ROM?)`
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

  getLevelL1Pointer(index: number): number | null {
    // Pointer table is interleaved 3-byte entries (lo, hi, bank) per level,
    // NOT three separate split tables. 512 entries × 3 bytes = $600.
    const base = ADDR.LEVEL_L1_LOW + index * 3
    const lo = this.rom.readByte(base)
    const hi = this.rom.readByte(base + 1)
    const bk = this.rom.readByte(base + 2)
    if (lo === null || hi === null || bk === null) return null
    return (bk << 16) | (hi << 8) | lo
  }

  getLevelSpritePointer(index: number): number | null {
    // Same interleaved 3-byte layout as L1 pointers.
    const base = ADDR.LEVEL_SPR_LOW + index * 3
    const lo = this.rom.readByte(base)
    const hi = this.rom.readByte(base + 1)
    const bk = this.rom.readByte(base + 2)
    if (lo === null || hi === null || bk === null) return null
    return (bk << 16) | (hi << 8) | lo
  }

  getAllLevelPointers(): Array<{ index: number; address: number | null }> {
    return Array.from({ length: LEVEL_COUNT }, (_, i) => ({
      index: i,
      address: this.getLevelL1Pointer(i)
    }))
  }

  getLevelRawData(index: number): Buffer | null {
    const ptr = this.getLevelL1Pointer(index)
    if (!ptr) return null
    return this.rom.readAt(ptr, 0x200)
  }

  getGfxFile(slot: number): Buffer | null {
    return this.rom.readAt(ADDR.GFX_BASE + slot * ADDR.GFX_FILE_SIZE, ADDR.GFX_FILE_SIZE)
  }

  /**
   * Returns true if the level has at least one object (not just a header + terminator).
   * Object data begins at byte 5 (after the 5-byte primary header).
   *
   * Bank byte validation: in vanilla SMW all level data is in banks $02–$09.
   * Slots with bank $00/$01 or > $09 typically point to code/tables rather than
   * level data and must be excluded, otherwise ~80 garbage entries leak through.
   */
  levelHasObjects(index: number): boolean {
    const data = this.getLevelRawData(index)
    if (data === null || data.length <= 5) return false

    // Level mode (byte 1 bits 4–0): SMW only defines modes 0–20.
    // Values above 20 indicate the pointer hit non-level ROM data (code/tables).
    const levelMode = data[1] & 0x1F
    if (levelMode > 20) return false

    // data[5] is first object byte; 0xFF = immediate terminator = no objects
    return data[5] !== 0xFF
  }

  /**
   * Returns the GFX tileset index for a level (used to index into the FGBG table at $00A92B).
   *
   * The GFX tileset is NOT stored directly in the L1 header. Instead it is derived at
   * runtime by the game via: tilesetId = ROM[$05D760 + spriteSet].
   * Confirmed via Mesen2 write watchpoint on $7E:1931:
   *   LDA $05D760,X (X = spriteSet from header byte 3 bits 3-0) → STA $1931
   * e.g. YI1: spriteSet=8 → $05D760[8]=7 → FGBG table entry 7 → GFX15/1B/17/14.
   */
  getGfxTilesetId(index: number): number {
    const ptr = this.getLevelL1Pointer(index)
    if (!ptr) return 0
    const buf = this.rom.readAt(ptr, 4)
    if (!buf || buf.length < 4) return 0
    const spriteSet = buf[3] & 0x0F  // header byte 3 bits 3-0
    return this.rom.readByte(ADDR.TILESETID_TABLE + spriteSet) ?? 0
  }
}
