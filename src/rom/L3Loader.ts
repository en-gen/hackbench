/**
 * L3Loader.ts -- Layer 3 tilemap loading for Super Mario World.
 *
 * Derived from SMWDisX disassembly (bank_00.asm, bank_05.asm):
 *   - CODE_009FB8: main L3 handler (bank_00.asm ~line 4135)
 *   - Layer3TilemapSettings: bank_00.asm line 4121 ($009F8D)
 *   - Layer3Ptr: bank_05.asm line 1720 ($059000)
 *   - LoadStripeImage: bank_00.asm line 886
 *   - CODE_00A993: L3 GFX upload to VRAM $4000 (bank_00.asm ~line 5287)
 *
 * Layer 3 in SMW uses BG3 in 2BPP mode.  GFX28–GFX2B (file indices 40–43)
 * are uploaded as 2BPP chars to VRAM word $4000 (VRam_L3Tiles).  The tilemap
 * is a 64×64 word grid at VRAM word $5000 (VRam_L3Tilemap), written frame-0
 * by LoadStripeImage from one of the fixed tilemap datasets.
 *
 * Stripe-image format (LoadStripeImage, bank_00.asm line 886):
 *   Repeat while first byte has bit 7 = 0:
 *     [VRAM_HI] [VRAM_LO] [FLAGS] tile-data × ((((FLAGS&0x3F)<<8)|COUNT)+1 bytes)
 *   FLAGS byte: bit 7 = vertical (0=horizontal), bit 6 = RLE (not used in vanilla)
 *   COUNT byte (byte 3): combined with upper 6 bits of FLAGS to give byte count
 *   Terminated by a byte with bit 7 = 1 (typically $FF)
 *
 * Tile word format (16-bit LE in the tilemap buffer):
 *   [15] Y-flip, [14] X-flip, [13] BG priority, [12:10] palette (0–7), [9:0] char index
 *   (char space: file = idx>>7, local = idx&0x7F)
 *
 * Layer3Setting (from readLayer3Setting in ObjectExpander.ts):
 *   0 = no L3; 1–3 = which entry in the per-tileset group to use.
 *
 * Layer3TilemapSettings (3 bytes per tileset × 16 tilesets at $009F8D):
 *   Each byte encodes the tide behaviour / initial Y position.
 *   If bit 7 = 0: !Tide_UpAndDown ($01) or !Tide_Stationary ($00) → tide effect.
 *     Layer3YPos = $70 (up-and-down) or $40 (stationary).
 *   If bit 7 = 1 and bit 6 = 0 ($80/$81): non-tide overlay.
 *     $80 / $C0: Layer3YPos = $D0 (fixed, scroll type incremented).
 *     $81 Castle1/Underground1: Layer3YPos = $C0 (fixed via CODE_009FFA).
 *     $81 other tilesets: Layer3YPos = Layer1YPos every frame (camera-tracked)
 *       → tiles sit at fixed level Y = row*8 (cage bars, windows, fish…).
 *   If bits 7:6 = 11: code takes another branch (BigCrusherColors, etc.) - no L3 bg.
 *
 * VRAM layout:
 *   $4000–$4FFF  L3 char graphics (GFX28–GFX2B, 2BPP)
 *   $5000–$5FFF  L3 tilemap (64×64 words; rows 0–7 = HUD area; rows 8+ = gameplay)
 */

import type { RomFile } from './RomFile'
import { readLayer3Setting } from './ObjectExpander'

// ── VRAM / table addresses ────────────────────────────────────────────────────

/** VRAM word address of the BG3 tilemap (VRam_L3Tilemap, SMW_E0.sym). */
export const L3_TILEMAP_BASE = 0x5000

/** Tilemap dimensions. BG3 is configured 64×64 (HW_BGSC_Size_64x64). */
export const L3_TILEMAP_COLS = 64
export const L3_TILEMAP_ROWS = 64

/** First row index that belongs to gameplay (rows 0–7 = HUD / off-screen). */
export const L3_HUD_ROW_CUTOFF = 8

/** SNES address of Layer3TilemapSettings (bank_00.asm line 4122). Verified against ROM. */
const L3_SETTINGS_ADDR = 0x009f88

/** Number of entries per tileset in Layer3TilemapSettings. */
const L3_SETTINGS_PER_TILESET = 3

/** SNES address of Layer3Ptr long-pointer table (bank_05.asm line 1720). */
const L3_PTR_TABLE = 0x059000

/** Bytes per entry in Layer3Ptr (3-byte long address). */
const L3_PTR_ENTRY_SIZE = 3

/** SNES address of DATA_05F000 (per-level primary-entrance Y settings byte). */
const DATA_05F000_ADDR = 0x05f000

/** SNES address of DATA_05F200 (per-level primary-entrance settings byte). */
const DATA_05F200_ADDR = 0x05f200

/**
 * SNES address of DATA_05F400 - per-level Layer1/Layer2 startup Y-index byte.
 * Bits 3:2 index DATA_05D708 for primary-entrance Layer1YPos init.
 * Bits 1:0 index DATA_05D70C for primary-entrance Layer2YPos init.
 * Distinct from DATA_05F200 (which holds Layer3Setting + entrance type +
 * palettes) - confirmed via bank_05.asm:7323-7335 (LDA DATA_05F400,Y; STA _2;
 * AND #$0C; LSR; LSR; TAX; LDA DATA_05D708,X; STA Layer1YPos).
 */
const DATA_05F400_ADDR = 0x05f400

/**
 * Mario start Y lookup - low byte at $05D730, high byte at $05D740.
 * Indexed by low nibble of the entrance-Y byte (DATA_05F000 primary, DATA_05FA00 secondary).
 * bank_05.asm:7045-7049.
 */
const DATA_05D730_ADDR = 0x05d730
const DATA_05D740_ADDR = 0x05d740

/**
 * Mario start X lookup - low byte at $05D750, high byte at $05D758.
 * Primary: indexed by low 3 bits of DATA_05F200 (bank_05.asm:7311).
 * Secondary: indexed by top 3 bits of DATA_05FC00 (bank_05.asm:7153).
 */
const DATA_05D750_ADDR = 0x05d750
const DATA_05D758_ADDR = 0x05d758

/** SNES address of DATA_05F600 (first level-data byte per level - holds vertical page for vert levels). */
const DATA_05F600_ADDR = 0x05f600

/** SNES address of DATA_05F800 - secondary-entrance target level LOW byte (indexed by entrance ID). */
const DATA_05F800_ADDR = 0x05f800

/** SNES address of DATA_05FA00 - secondary-entrance settings (bits 5:4 index DATA_05D708 for camera Y). */
const DATA_05FA00_ADDR = 0x05fa00

/** SNES address of DATA_05FC00 - secondary-entrance extra bits (bit 0 is target level HIGH byte). */
const DATA_05FC00_ADDR = 0x05fc00

/**
 * SNES address of DATA_05D708 - initial Layer1YPos (camera Y) low-byte table.
 * Contents: $00, $60, $C0, $00.
 */
const DATA_05D708_ADDR = 0x05d708

/** Max secondary-entrance index (9-bit: bit 0 of DATA_05FC00 extends to 0x1FF). */
const SECONDARY_ENTRANCE_COUNT = 0x200

/**
 * Find the secondary entrance that targets the given level number, if any.
 * Returns the entrance ID (0..$1FF), or null if no entrance points here.
 *
 * Sublevels (range $100-$1FF) are only reachable via secondary entrances
 * (pipes/doors), so their primary-entrance Layer1YPos data is not what the
 * game actually uses when Mario enters the level.
 */
export function findSecondaryEntranceForLevel(rom: RomFile, levelId: number): number | null {
  for (let e = 0; e < SECONDARY_ENTRANCE_COUNT; e++) {
    const lo = rom.readByte(DATA_05F800_ADDR + e) ?? 0
    const hi = (rom.readByte(DATA_05FC00_ADDR + e) ?? 0) & 0x01
    const target = (hi << 8) | lo
    if (target === levelId) return e
  }
  return null
}

/**
 * SNES addresses of the four static status-bar tilemap rows in bank 00.
 * Verified against SMW_U.sym. UploadStaticBar (bank_00.asm:1440) DMA-writes
 * each of these into BG3 VRAM at !VRAMAddrHUD1..4 ($502E, $5042, $5063, $508E).
 */
const STATUS_BAR_ROW1_ADDR = 0x008c81 // 4 tiles → VRAM $502E
const STATUS_BAR_ROW2_ADDR = 0x008c89 // 28 tiles → VRAM $5042
const STATUS_BAR_ROW3_ADDR = 0x008cc1 // 27 tiles → VRAM $5063
const STATUS_BAR_ROW4_ADDR = 0x008cf7 // 4 tiles → VRAM $508E

/**
 * TimerTable at $0584D7 (bank_05.asm:510). `db $00, $02, $03, $04` indexed
 * by header byte 3 bits 7:6 (timeLimit field).  At level load, CODE_05827C
 * (~line 607) loads TimerTable[timeLimit] into InGameTimerHundreds;
 * InGameTimerTens and InGameTimerOnes start at 0. UpdateTime (bank_00:1599)
 * then writes all three to StatusBar+!HUDTimerOffset each frame as the tile
 * char-index for the three timer digits.
 */
const TIMER_TABLE_ADDR = 0x0584d7

/**
 * Overlay the static status-bar tiles into the L3 tilemap buffer at the same
 * VRAM offsets the game uses at level load. This is what `UploadStaticBar`
 * writes before the stripe image runs; for tilesets whose stripe image writes
 * to the HUD area (e.g. Tilemap_L3Crusher), the stripe data will overwrite
 * these again - matching the game's actual ordering.
 */
export function applyStaticStatusBar(rom: RomFile, tilemap: Uint16Array): void {
  // BG3 in 64x64 mode uses four 32x32 sub-screens. The HUD writes all land in
  // sub 0 ($5000-$53FF, 32-col stride). Our tilemap buffer indexes as a flat
  // 64-col table, so translate each hw (row, col) pair into its 64-col offset.
  //   hw $502E = sub 0 row 1 col 14 → flat row 1 col 14 → flat offset 1*64+14
  //   hw $5042 = sub 0 row 2 col 2  → flat row 2 col 2  → flat offset 2*64+2
  //   hw $5063 = sub 0 row 3 col 3  → flat row 3 col 3  → flat offset 3*64+3
  //   hw $508E = sub 0 row 4 col 14 → flat row 4 col 14 → flat offset 4*64+14
  const writes: Array<[number, number, number]> = [
    [STATUS_BAR_ROW1_ADDR, 1 * L3_TILEMAP_COLS + 14, 4],
    [STATUS_BAR_ROW2_ADDR, 2 * L3_TILEMAP_COLS + 2, 28],
    [STATUS_BAR_ROW3_ADDR, 3 * L3_TILEMAP_COLS + 3, 27],
    [STATUS_BAR_ROW4_ADDR, 4 * L3_TILEMAP_COLS + 14, 4],
  ]
  for (const [src, dst, count] of writes) {
    for (let i = 0; i < count; i++) {
      const lo = rom.readByte(src + i * 2) ?? 0
      const hi = rom.readByte(src + i * 2 + 1) ?? 0
      const word = (hi << 8) | lo
      if (word !== 0 && dst + i >= 0 && dst + i < tilemap.length) {
        tilemap[dst + i] = word
      }
    }
  }
}

/**
 * Write the initial timer digits into the HUD tilemap. The game's UpdateTime
 * routine (bank_00.asm:1599) writes InGameTimerHundreds/Tens/Ones into
 * StatusBar+!HUDTimerOffset each frame; at level load these are set from
 * TimerTable[timeLimit] / 0 / 0. Simulating the first UpdateTime replaces
 * the static-bar placeholders ($FE/$FE/$00 at row 3 positions 16-18) with
 * the digits the player would see on frame 1.
 *
 * @param timeLimit 2-bit value from header byte 3 bits 7:6 (0 = no timer).
 */
export function applyInitialTimer(rom: RomFile, tilemap: Uint16Array, timeLimit: number): void {
  const idx = timeLimit & 0x03
  const hundreds = rom.readByte(TIMER_TABLE_ADDR + idx) ?? 0
  if (hundreds === 0) return // no timer on this level - leave placeholders
  // StatusBarRow3 entries at these positions have attribute byte $3C
  // (palette 7, priority set); UpdateTime's 1-byte DMA only overwrites the
  // char-index, so attributes are inherited from UploadStaticBar.
  const ATTR = 0x3c
  // HUD3 base in flat layout = row 3 col 3 (from hw $5063 sub 0 row 3 col 3).
  // Timer digits sit at HUD3 positions 16-18 = row 3 cols 19-21.
  const base = 3 * L3_TILEMAP_COLS + (3 + 16)
  tilemap[base] = (ATTR << 8) | hundreds
  tilemap[base + 1] = (ATTR << 8) | 0 // tens = 0
  tilemap[base + 2] = (ATTR << 8) | 0 // ones = 0
}

/**
 * Return the initial Layer1YPos (camera Y) in pixels for a level, picking the
 * correct entrance based on level number.
 *
 * Primary entrances (levels $000-$0FF, bank_05.asm:7323-7335):
 *   Layer1YPos = DATA_05D708[bits 3:2 of DATA_05F400[level]]
 *
 *   ↑ NOTE: bits come from DATA_05F400, NOT DATA_05F200. The ASM at lines
 *     7309-7322 first loads $05F200 into _2 to extract entrance-type bits,
 *     THEN at line 7324 reloads _2 from $05F400 before computing the camera
 *     Y index. Earlier versions of this code read from $05F200 by mistake,
 *     producing camera Y = $00 for levels that should start at $C0 - a
 *     192-pixel L3 misposition for ~all L3-using vanilla levels.
 *
 * Secondary entrances (levels $100-$1FF and any level reached via pipe/door,
 *  bank_05.asm:7120-7136):
 *   Layer1YPos = DATA_05D708[bits 5:4 of DATA_05FA00[entranceId]]
 *
 * Vertical levels (bank_05.asm:7386-7388): same low byte, plus the high byte
 *   from DATA_05F600[level] & $1F.
 *
 * BG3 tile at VRAM row R ultimately appears at level Y = (R*8 - Layer3YPos) + Layer1YPos.
 */
export function readInitialLayer1YPos(rom: RomFile, levelId: number, isVertical = false): number {
  // For sublevels ($100+), prefer the secondary-entrance data since that's how
  // the game actually reaches them.  For primary levels, use the primary data.
  let loByte: number
  if (levelId >= 0x100) {
    const entrance = findSecondaryEntranceForLevel(rom, levelId)
    if (entrance !== null) {
      const faByte = rom.readByte(DATA_05FA00_ADDR + entrance) ?? 0
      const idx = (faByte >> 4) & 0x03
      loByte = rom.readByte(DATA_05D708_ADDR + idx) ?? 0
    } else {
      // Primary fallback for sublevels with no targeting entrance - uses
      // DATA_05F400 bits 3:2, same as the standard primary path.
      const settings = rom.readByte(DATA_05F400_ADDR + levelId) ?? 0
      const idx = (settings >> 2) & 0x03
      loByte = rom.readByte(DATA_05D708_ADDR + idx) ?? 0
    }
  } else {
    const settings = rom.readByte(DATA_05F400_ADDR + levelId) ?? 0
    const idx = (settings >> 2) & 0x03
    loByte = rom.readByte(DATA_05D708_ADDR + idx) ?? 0
  }

  if (!isVertical) return loByte
  const hiByte = (rom.readByte(DATA_05F600_ADDR + levelId) ?? 0) & 0x1f
  return (hiByte << 8) | loByte
}

/**
 * Read Mario's starting pixel position for a level, picking the primary
 * entrance for main levels ($000-$0FF) and the secondary entrance that
 * targets the level for sublevels ($100-$1FF).
 *
 * Primary entry (bank_05.asm:7302-7316):
 *   Y = { DATA_05D740[F000[lvl] & $0F] : DATA_05D730[F000[lvl] & $0F] }
 *   X = { DATA_05D758[F200[lvl] & $07] : DATA_05D750[F200[lvl] & $07] }
 *
 * Secondary entry (bank_05.asm:7120-7158):
 *   Y = { DATA_05D740[FA00[ent] & $0F] : DATA_05D730[FA00[ent] & $0F] }
 *   X = { DATA_05D758[FC00[ent] >> 5]  : DATA_05D750[FC00[ent] >> 5] }
 *
 * Sublevels in the primary-only range (e.g. $100 with no entrance target)
 * fall back to their primary-table bytes so callers still get a usable
 * coordinate - that's also how the LM "view as entrance" workflow decodes
 * unreachable sublevels.
 */
export function readMarioStartPos(rom: RomFile, levelId: number): { x: number; y: number } {
  let yByte: number
  let xByte: number
  let xIdx: number
  if (levelId >= 0x100) {
    const entrance = findSecondaryEntranceForLevel(rom, levelId)
    if (entrance !== null) {
      yByte = rom.readByte(DATA_05FA00_ADDR + entrance) ?? 0
      xByte = rom.readByte(DATA_05FC00_ADDR + entrance) ?? 0
      xIdx = (xByte >> 5) & 0x07
    } else {
      yByte = rom.readByte(DATA_05F000_ADDR + levelId) ?? 0
      xByte = rom.readByte(DATA_05F200_ADDR + levelId) ?? 0
      xIdx = xByte & 0x07
    }
  } else {
    yByte = rom.readByte(DATA_05F000_ADDR + levelId) ?? 0
    xByte = rom.readByte(DATA_05F200_ADDR + levelId) ?? 0
    xIdx = xByte & 0x07
  }
  const yIdx = yByte & 0x0f
  const yLo = rom.readByte(DATA_05D730_ADDR + yIdx) ?? 0
  const yHi = rom.readByte(DATA_05D740_ADDR + yIdx) ?? 0
  const xLo = rom.readByte(DATA_05D750_ADDR + xIdx) ?? 0
  const xHi = rom.readByte(DATA_05D758_ADDR + xIdx) ?? 0
  return { x: (xHi << 8) | xLo, y: (yHi << 8) | yLo }
}

// ── Per-tileset settings ──────────────────────────────────────────────────────

/**
 * Return the Layer3TilemapSettings byte for a specific (tileset, layer3Setting) pair.
 * Returns null if the read fails.
 */
export function readL3SettingsByte(
  rom: RomFile,
  tileset: number,
  layer3Setting: number,
): number | null {
  if (layer3Setting < 1 || layer3Setting > 3) return null
  const offset = tileset * L3_SETTINGS_PER_TILESET + (layer3Setting - 1)
  return rom.readByte(L3_SETTINGS_ADDR + offset)
}

/**
 * Derive the initial Layer3YPos (in pixels) from a Layer3TilemapSettings byte.
 *
 * Per CODE_009FB8 (bank_00.asm:4154-4161):
 *   LSR A; PHP; ...; LDA #$70; PLP; BEQ +; LDA #$40; + STA Layer3YPos
 *
 * The LSR-then-test-Z logic means:
 *   byte $00 → A=$00 after LSR → Z=1 → BEQ branches → init Y = $70
 *   byte $01 → A=$00 after LSR → Z=1 → BEQ branches → init Y = $70
 *   byte $02..$7F → A≠0 after LSR → Z=0 → BEQ doesn't branch → init Y = $40
 *   byte $80..$BF → BMI branch (CODE_009FEA) → $D0 fixed
 *   byte $C0+ → no L3 background written → 0
 */
export function l3InitialYPx(settingsByte: number): number {
  if (settingsByte >= 0xc0) return 0
  if (settingsByte >= 0x80) return 0xd0 // cage bars, windows, crusher, fish
  // Tide range: bytes $00 and $01 both keep init Y at $70 (BEQ branches when
  // LSR result is zero). Bytes $02..$7F fall through to LDA #$40.
  return settingsByte <= 0x01 ? 0x70 : 0x40
}

// ── Routine classification (editor metadata) ────────────────────────────────

/**
 * Animation/static kind for a level's L3 routine. Mirrors the vocabulary used
 * by computeL3ScrollRange, plus a 'disabled' state that signals "Layer3Setting
 * is 0 - no L3 selected at all" (distinct from 'none' which means the table
 * entry exists but the byte is in the $C0+ no-L3 range).
 */
export type L3RoutineKind = 'tide' | 'fixed' | 'camera-tracked' | 'none' | 'disabled'

export interface L3RoutineSummary {
  /** 0..3, from $05F200[levelId] bits 7:6. 0 means L3 disabled for this level. */
  layer3Setting: number
  /** Raw byte from $009F88[tileset*3 + (setting-1)], or null when layer3Setting is 0. */
  settingsByte: number | null
  /** Animation/static kind (see L3RoutineKind). */
  kind: L3RoutineKind
  /**
   * Initial Layer3YPos in pixels, or null when there is no static initial Y
   * (camera-tracked, none, or disabled). Tide and fixed routines have a
   * concrete static initial value.
   */
  initialYPx: number | null
  /** True when the byte is < $80 with bit 0 set (Tide_UpAndDown). */
  isTideUpAndDown: boolean
}

export interface ClassifyL3Input {
  /** 0..3, bits 7:6 of $05F200[levelId]. */
  layer3Setting: number
  /** Raw byte from $009F88, or null when layer3Setting is 0. */
  settingsByte: number | null
  /** Object tileset (header byte 4 bits 3:0) - needed for the $81 special case. */
  tileset: number
}

/**
 * Classify a Layer3Setting + $009F88 byte + tileset triple into a routine kind.
 *
 * Rules (verified against bank_00.asm:4139-4165 + bank_05.asm:5504-5630):
 *   - layer3Setting === 0 → 'disabled' (no L3 lookup performed)
 *   - byte === $01        → 'tide' (Tide_UpAndDown - only byte that animates Y;
 *                            CODE_05C494 falls through when TideSetting-1 == 0)
 *   - byte === $00        → 'fixed' (CODE_05C40C BEQ skips JMP CODE_05C494, so
 *                            no animation; init Y = $70 per ASM)
 *   - byte $02..$7F       → 'fixed' (Tide_Stationary; CODE_05C494 BNE jumps to
 *                            CODE_05C4EC which only updates Layer3XPos, not Y)
 *   - byte === $80        → 'fixed' (static at $D0)
 *   - byte === $81 + tileset 1 (Castle1) or 3 (Underground1) → 'fixed' (static at $C0)
 *   - byte === $81 + other tileset → 'camera-tracked' (Layer3YPos = Layer1YPos)
 *   - byte ≥ $C0          → 'none'
 *
 * isTideUpAndDown is true only for byte $01 - the canonical Tide_UpAndDown
 * value (rammap.asm:1511 `!Tide_UpAndDown = 1`).
 */
export function classifyL3Routine(input: ClassifyL3Input): L3RoutineSummary {
  const { layer3Setting, settingsByte, tileset } = input
  if (layer3Setting === 0 || settingsByte === null) {
    return {
      layer3Setting: 0,
      settingsByte: null,
      kind: 'disabled',
      initialYPx: null,
      isTideUpAndDown: false,
    }
  }
  // Only byte $01 reaches the Y-animating path. Byte $00 short-circuits at
  // CODE_05C40C; byte $02..$7F takes CODE_05C4EC which only scrolls X.
  if (settingsByte === 0x01) {
    return { layer3Setting, settingsByte, kind: 'tide', initialYPx: 0x70, isTideUpAndDown: true }
  }
  if (settingsByte < 0x80) {
    // Byte $00 or $02..$7F - no Y animation. Treat as fixed.
    return {
      layer3Setting,
      settingsByte,
      kind: 'fixed',
      initialYPx: l3InitialYPx(settingsByte),
      isTideUpAndDown: false,
    }
  }
  if (settingsByte >= 0xc0) {
    return { layer3Setting, settingsByte, kind: 'none', initialYPx: 0, isTideUpAndDown: false }
  }
  // $80..$BF
  if (settingsByte === 0x81 && tileset !== 1 && tileset !== 3) {
    // CODE_00A01F path: Layer3YPos = Layer1YPos every frame; no static value.
    return {
      layer3Setting,
      settingsByte,
      kind: 'camera-tracked',
      initialYPx: null,
      isTideUpAndDown: false,
    }
  }
  return {
    layer3Setting,
    settingsByte,
    kind: 'fixed',
    initialYPx: l3InitialYPx(settingsByte),
    isTideUpAndDown: false,
  }
}

/**
 * Read the L3 routine summary for a level. Pure metadata - does not parse
 * the stripe image (use loadL3Tilemap when you need the actual tilemap).
 *
 * @param tileset Object tileset (header byte 4 bits 3:0) for the level.
 */
export function readL3RoutineSummary(
  rom: RomFile,
  levelId: number,
  tileset: number,
): L3RoutineSummary {
  const layer3Setting = readLayer3Setting(rom, levelId)
  const settingsByte = layer3Setting === 0 ? null : readL3SettingsByte(rom, tileset, layer3Setting)
  return classifyL3Routine({ layer3Setting, settingsByte, tileset })
}

// ── Scroll-range derivation (editor overlay) ─────────────────────────────────

/** Tide Layer3YPos sweep bounds (CODE_05C494, bank_05.asm:5576-5630). */
export const L3_TIDE_YPOS_MIN = 0x30
export const L3_TIDE_YPOS_MAX = 0xa0

export interface L3ScrollRange {
  /**
   * Animation kind:
   *   - tide:           Layer3YPos sweeps L3_TIDE_YPOS_MIN..MAX every frame.
   *   - fixed:          Layer3YPos stays at initialYPx (no animation).
   *   - camera-tracked: Layer3YPos = Layer1YPos every frame; cells sit at
   *                     fixed level Y = row*8.
   *   - none:           no L3 background or no gameplay-area content.
   */
  kind: 'tide' | 'fixed' | 'camera-tracked' | 'none'
  /** Level pixel coordinates of the rectangle the L3 band can occupy. */
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  /**
   * For `kind: 'tide'` - Y-coordinate of the wave-surface row (top of band)
   * at the extremes of the BG3VOFS sweep. Designers see the wave-surface
   * position at high tide (Layer3YPos = L3_TIDE_YPOS_MAX) and low tide
   * (Layer3YPos = L3_TIDE_YPOS_MIN). Equal to yMin / (yMin + sweep) when
   * the band-detection works perfectly; surfaced separately so the overlay
   * can always draw explicit "HIGH" / "LOW" reference lines.
   */
  yHighTide?: number
  yLowTide?: number
}

export interface L3ScrollRangeInput {
  tilemap: Uint16Array
  /** Initial Layer3YPos used by L3TilemapLayer's static render. */
  initialYPx: number
  /** Initial Layer1YPos at level start. */
  initialCameraYPx: number
  /** Level pixel width (screens × 256). */
  levelPixelW: number
  /** Raw byte from Layer3TilemapSettings ($009F88). */
  settingsByte: number
  /** Object tileset (header byte 4 bits 3:0). */
  tileset: number
}

/**
 * Find the first row >= L3_HUD_ROW_CUTOFF that contains any non-zero cell.
 * Returns -1 if no gameplay-area cells exist.
 */
function findFirstDataRow(tilemap: Uint16Array): number {
  for (let r = L3_HUD_ROW_CUTOFF; r < L3_TILEMAP_ROWS; r++) {
    for (let c = 0; c < L3_TILEMAP_COLS; c++) {
      if (tilemap[r * L3_TILEMAP_COLS + c] !== 0) return r
    }
  }
  return -1
}

/**
 * Tide stripe images write two identical row patterns (e.g. rows 32-47 then
 * 48-63) for smooth animation. Detect the repeat boundary so the band-height
 * isn't doubled. Mirrors L3TilemapLayer's repeat-detection.
 */
function findTideDataEndRow(tilemap: Uint16Array, firstDataRow: number): number {
  for (let r = firstDataRow + 1; r < L3_TILEMAP_ROWS; r++) {
    let match = true
    for (let c = 0; c < L3_TILEMAP_COLS; c++) {
      const a = tilemap[firstDataRow * L3_TILEMAP_COLS + c] ?? 0
      const b = tilemap[r * L3_TILEMAP_COLS + c] ?? 0
      const aChar = a & 0x3ff
      const bChar = b & 0x3ff
      const aEmpty = a === 0
      const bEmpty = b === 0
      if (aEmpty !== bEmpty || (!aEmpty && !bEmpty && aChar !== bChar)) {
        match = false
        break
      }
    }
    if (match) return r
  }
  return L3_TILEMAP_ROWS
}

/** Find the last gameplay row <= dataEndRow-1 with any non-zero cell. */
function findLastDataRow(tilemap: Uint16Array, dataEndRow: number): number {
  for (let r = dataEndRow - 1; r >= L3_HUD_ROW_CUTOFF; r--) {
    for (let c = 0; c < L3_TILEMAP_COLS; c++) {
      if (tilemap[r * L3_TILEMAP_COLS + c] !== 0) return r
    }
  }
  return -1
}

/**
 * Compute the rectangle (in level pixel coordinates) that the L3 band can
 * occupy as the game animates it. Used by the editor's scroll-range overlay
 * so the designer can see where BG3 will be visible during play.
 *
 * Animation rules (from CODE_05C40C / CODE_05C494, bank_05.asm:5504-5630):
 *   - Tide (settings byte < $80):
 *       Layer3YPos oscillates [L3_TIDE_YPOS_MIN..MAX].
 *       pixelY = row*8 - liveYPos + initialCamY for liveYPos ∈ [MIN..MAX].
 *       So yMin = firstRow*8 - YPOS_MAX + initialCamY
 *          yMax = (lastRow+1)*8 - YPOS_MIN + initialCamY
 *   - Fixed (settings byte $80, or $81 with tileset 1/3):
 *       pixelY = row*8 - initialYPx + initialCamY (no animation).
 *   - Camera-tracked (settings byte $81 with tileset != 1, 3):
 *       Layer3YPos = Layer1YPos every frame → pixelY = row*8 in level coords.
 *   - None (settings byte $C0+, or no gameplay content): no overlay.
 *
 * X is full level width: tide scrolls 1:1 with camera (Layer3XPos +=
 * Layer1DXPos, CODE_05C4EC), fixed/camera-tracked tile across the level.
 */
export function computeL3ScrollRange(input: L3ScrollRangeInput): L3ScrollRange {
  const { tilemap, initialYPx, initialCameraYPx, levelPixelW, settingsByte, tileset } = input

  if (settingsByte >= 0xc0) {
    return { kind: 'none', xMin: 0, xMax: 0, yMin: 0, yMax: 0 }
  }

  const firstDataRow = findFirstDataRow(tilemap)
  if (firstDataRow < 0) {
    return { kind: 'none', xMin: 0, xMax: 0, yMin: 0, yMax: 0 }
  }

  // Y animation only happens for byte $01 (Tide_UpAndDown). Bytes $00 and
  // $02..$7F look superficially "tide-like" (byte < $80) but don't update
  // Layer3YPos at runtime - see classifyL3Routine for the ASM trace.
  const isAnimatedTide = settingsByte === 0x01
  const dataEndRow = isAnimatedTide ? findTideDataEndRow(tilemap, firstDataRow) : L3_TILEMAP_ROWS
  const lastDataRow = findLastDataRow(tilemap, dataEndRow)
  if (lastDataRow < 0) {
    return { kind: 'none', xMin: 0, xMax: 0, yMin: 0, yMax: 0 }
  }

  const xMin = 0
  const xMax = levelPixelW

  if (isAnimatedTide) {
    return {
      kind: 'tide',
      xMin,
      xMax,
      yMin: firstDataRow * 8 - L3_TIDE_YPOS_MAX + initialCameraYPx,
      yMax: (lastDataRow + 1) * 8 - L3_TIDE_YPOS_MIN + initialCameraYPx,
      // Wave-surface row position at the two BG3VOFS extremes. The renderer
      // uses these for explicit "HIGH" / "LOW" tide reference lines.
      yHighTide: firstDataRow * 8 - L3_TIDE_YPOS_MAX + initialCameraYPx,
      yLowTide: firstDataRow * 8 - L3_TIDE_YPOS_MIN + initialCameraYPx,
    }
  }

  // settingsByte in [$80, $C0)
  const isCameraTracked = settingsByte === 0x81 && tileset !== 1 && tileset !== 3
  if (isCameraTracked) {
    return {
      kind: 'camera-tracked',
      xMin,
      xMax,
      yMin: firstDataRow * 8,
      yMax: (lastDataRow + 1) * 8,
    }
  }

  return {
    kind: 'fixed',
    xMin,
    xMax,
    yMin: firstDataRow * 8 - initialYPx + initialCameraYPx,
    yMax: (lastDataRow + 1) * 8 - initialYPx + initialCameraYPx,
  }
}

// ── Layer3Ptr table ───────────────────────────────────────────────────────────

/**
 * Read the SNES address of the stripe-image tilemap for (tileset, layer3Setting).
 *
 * Index into Layer3Ptr = (layer3Setting-1 + tileset*3) * 3  (each entry is 3 bytes).
 * Returns null if layer3Setting is 0 or the ROM read fails.
 */
export function readL3TilemapAddr(
  rom: RomFile,
  tileset: number,
  layer3Setting: number,
): number | null {
  if (layer3Setting < 1 || layer3Setting > 3) return null
  const idx = (layer3Setting - 1 + tileset * L3_SETTINGS_PER_TILESET) * L3_PTR_ENTRY_SIZE
  const lo = rom.readByte(L3_PTR_TABLE + idx)
  const hi = rom.readByte(L3_PTR_TABLE + idx + 1)
  const bk = rom.readByte(L3_PTR_TABLE + idx + 2)
  if (lo === null || hi === null || bk === null) return null
  return (bk << 16) | (hi << 8) | lo
}

// ── Stripe-image parser ───────────────────────────────────────────────────────

/**
 * Convert a VRAM word address in the BG3 64×64 tilemap to a flat row-major
 * index (row * L3_TILEMAP_COLS + col) usable in our 64×64 buffer.
 *
 * SNES 64×64 BG tilemap splits into four 32×32 sub-screens in VRAM:
 *   sub 0  $5000–$53FF  → rows  0-31, cols  0-31
 *   sub 1  $5400–$57FF  → rows  0-31, cols 32-63
 *   sub 2  $5800–$5BFF  → rows 32-63, cols  0-31
 *   sub 3  $5C00–$5FFF  → rows 32-63, cols 32-63
 * Within each sub, entry (r_sub, c_sub) lives at sub_base + r_sub*32 + c_sub.
 *
 * Returns -1 for addresses outside $5000–$5FFF.
 */
function vramAddrToFlat(vramAddr: number): number {
  const off = vramAddr - L3_TILEMAP_BASE
  if (off < 0 || off >= L3_TILEMAP_COLS * L3_TILEMAP_ROWS) return -1
  const sub = (off >> 10) & 3 // which sub-screen (0-3)
  const within = off & 0x3ff // position within sub (0-1023)
  const hwRow = (within >> 5) + (sub >= 2 ? 32 : 0)
  const hwCol = (within & 0x1f) + (sub & 1 ? 32 : 0)
  return hwRow * L3_TILEMAP_COLS + hwCol
}

/**
 * Parse a stripe-image byte stream into a 64×64 VRAM tilemap buffer.
 *
 * The returned Uint16Array has 4096 entries; index = hw_row*64 + hw_col,
 * where hw_row/hw_col are the hardware BG3 tile coordinates (0-63 each).
 * Entries outside $5000–$5FFF are silently ignored.
 *
 * Horizontal writes (FLAGS bit 7 = 0): VRAM address increments by 1 per tile
 * (SNES VMAINC mode 00 = +1 word).
 * Vertical writes (FLAGS bit 7 = 1): VRAM address increments by 32 per tile
 * (SNES VMAINC mode 01 = +32 words = one row within a 32-wide sub-screen).
 *
 * RLE format (FLAGS bit 6 = 1): 2 data bytes (one tile word) repeated
 * tileCount times. Stream advances by 2 (not countBytes) - per LoadStripeImage
 * ASM: LDX.W #2 / STX.B _3 / ADC.B _3 / TAY after the RLE DMA branch.
 */
export function parseStripeImage(data: Uint8Array): Uint16Array {
  const tilemap = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
  parseStripeImageInto(tilemap, data)
  return tilemap
}

/**
 * Like parseStripeImage but writes into an existing tilemap buffer, so a
 * static-status-bar pass can run before the stripe parser.
 */
export function parseStripeImageInto(tilemap: Uint16Array, data: Uint8Array): void {
  let i = 0
  while (i < data.length) {
    const b0 = data[i]!
    if (b0 & 0x80) break // terminator (bit 7 set)
    if (i + 3 >= data.length) break

    const b1 = data[i + 1]!
    const b2 = data[i + 2]!
    const b3 = data[i + 3]!
    const vramAddr = (b0 << 8) | b1
    const vertical = (b2 & 0x80) !== 0
    const rle = (b2 & 0x40) !== 0
    const countBytes = (((b2 & 0x3f) << 8) | b3) + 1
    i += 4

    const tileCount = countBytes >> 1
    // VRAM address stride: horizontal = +1 word, vertical = +32 words
    // (matches SNES VMAINC register modes 00/01 used by LoadStripeImage)
    const stride = vertical ? 32 : 1

    if (rle) {
      // RLE: 2 data bytes (one tile word) repeated tileCount times.
      // The stream advances by only 2, not countBytes.
      if (i + 1 >= data.length) break
      const lo = data[i]!
      const hi = data[i + 1]!
      i += 2
      const word = (hi << 8) | lo
      for (let t = 0; t < tileCount; t++) {
        const pos = vramAddrToFlat(vramAddr + t * stride)
        if (pos >= 0) tilemap[pos] = word
      }
      continue
    }

    for (let t = 0; t < tileCount; t++) {
      if (i + 1 >= data.length) break
      const lo = data[i]!
      const hi = data[i + 1]!
      i += 2
      const word = (hi << 8) | lo
      const pos = vramAddrToFlat(vramAddr + t * stride)
      if (pos >= 0) tilemap[pos] = word
    }
  }
}

// ── High-level loader ─────────────────────────────────────────────────────────

export interface L3TilemapLoad {
  /** 64×64 VRAM tilemap buffer (index = row*64+col). */
  tilemap: Uint16Array
  /** Initial Layer3YPos in pixels (used to position L3 relative to the level). */
  initialYPx: number
  /** Initial Layer1YPos (camera Y) in pixels, from DATA_05D708 via DATA_05F200 bits 3:2. */
  initialCameraYPx: number
  /** SNES address the stripe-image data was read from. */
  dataAddr: number
  /** Raw byte from Layer3TilemapSettings ($009F88). Drives scroll-range mode. */
  settingsByte: number
}

/**
 * Load the L3 tilemap for a level, or null if the level has no L3.
 */
export function loadL3Tilemap(
  rom: RomFile,
  levelId: number,
  tileset: number,
  timeLimit = 0,
): L3TilemapLoad | null {
  const layer3Setting = readLayer3Setting(rom, levelId)
  if (layer3Setting === 0) return null

  const dataAddr = readL3TilemapAddr(rom, tileset, layer3Setting)
  if (dataAddr === null) return null

  // Read generously; stripe images terminate with $FF so a large cap is fine.
  const raw = rom.readAt(dataAddr, 0x2000)
  if (!raw) return null

  const settingsByte = readL3SettingsByte(rom, tileset, layer3Setting) ?? 0
  let initialYPx = l3InitialYPx(settingsByte)
  const initialCameraYPx = readInitialLayer1YPos(rom, levelId)

  // $81 with non-castle/non-underground tilesets: CODE_009FB8 takes the
  // CODE_00A01F path (no Layer3YPos write, no Layer3ScrollType increment).
  // The game loop (CODE_05C40C → CODE_05C428 → CODE_05C48D) then runs
  //   Layer3YPos = Layer1YPos  every frame,
  // so tiles sit at fixed level Y = row*8 regardless of camera position.
  // Setting initialYPx = initialCameraYPx makes the render formula
  //   pixelY = row*8 - initialYPx + initialCamY  collapse to  row*8.
  // ObjTileset_Castle1 = 1, ObjTileset_Underground1 = 3 (constants.asm:229/231):
  // those tilesets reach CODE_009FFA which sets Layer3YPos = $C0 instead.
  if (settingsByte === 0x81 && tileset !== 1 && tileset !== 3) {
    initialYPx = initialCameraYPx
  }

  // Game order: UploadStaticBar (HUD) runs first, then UpdateStatusBar writes
  // the initial timer digits over the runtime-placeholder slots, then the
  // stripe-image parse overlays for tilesets whose stripe writes into the
  // HUD area (e.g. crusher).
  const tilemap = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
  applyStaticStatusBar(rom, tilemap)
  applyInitialTimer(rom, tilemap, timeLimit)
  parseStripeImageInto(tilemap, new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))

  return {
    tilemap,
    initialYPx,
    initialCameraYPx,
    dataAddr,
    settingsByte,
  }
}
