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
 *   If bit 7 = 1 and bit 6 = 0: non-tide overlay (cage, windows, crusher, fish…).
 *     Layer3YPos = $D0.
 *   If bits 7:6 = 11: code takes another branch (BigCrusherColors, etc.) — no L3 bg.
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
const L3_SETTINGS_ADDR = 0x009F88

/** Number of entries per tileset in Layer3TilemapSettings. */
const L3_SETTINGS_PER_TILESET = 3

/** SNES address of Layer3Ptr long-pointer table (bank_05.asm line 1720). */
const L3_PTR_TABLE = 0x059000

/** Bytes per entry in Layer3Ptr (3-byte long address). */
const L3_PTR_ENTRY_SIZE = 3

/** SNES address of DATA_05F200 (per-level primary-entrance settings byte). */
const DATA_05F200_ADDR = 0x05F200

/** SNES address of DATA_05F600 (first level-data byte per level — holds vertical page for vert levels). */
const DATA_05F600_ADDR = 0x05F600

/** SNES address of DATA_05F800 — secondary-entrance target level LOW byte (indexed by entrance ID). */
const DATA_05F800_ADDR = 0x05F800

/** SNES address of DATA_05FA00 — secondary-entrance settings (bits 5:4 index DATA_05D708 for camera Y). */
const DATA_05FA00_ADDR = 0x05FA00

/** SNES address of DATA_05FC00 — secondary-entrance extra bits (bit 0 is target level HIGH byte). */
const DATA_05FC00_ADDR = 0x05FC00

/**
 * SNES address of DATA_05D708 — initial Layer1YPos (camera Y) low-byte table.
 * Contents: $00, $60, $C0, $00.
 */
const DATA_05D708_ADDR = 0x05D708

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
const STATUS_BAR_ROW1_ADDR = 0x008C81  // 4 tiles → VRAM $502E
const STATUS_BAR_ROW2_ADDR = 0x008C89  // 28 tiles → VRAM $5042
const STATUS_BAR_ROW3_ADDR = 0x008CC1  // 27 tiles → VRAM $5063
const STATUS_BAR_ROW4_ADDR = 0x008CF7  // 4 tiles → VRAM $508E

/**
 * TimerTable at $0584D7 (bank_05.asm:510). `db $00, $02, $03, $04` indexed
 * by header byte 3 bits 7:6 (timeLimit field).  At level load, CODE_05827C
 * (~line 607) loads TimerTable[timeLimit] into InGameTimerHundreds;
 * InGameTimerTens and InGameTimerOnes start at 0. UpdateTime (bank_00:1599)
 * then writes all three to StatusBar+!HUDTimerOffset each frame as the tile
 * char-index for the three timer digits.
 */
const TIMER_TABLE_ADDR = 0x0584D7

/**
 * Overlay the static status-bar tiles into the L3 tilemap buffer at the same
 * VRAM offsets the game uses at level load. This is what `UploadStaticBar`
 * writes before the stripe image runs; for tilesets whose stripe image writes
 * to the HUD area (e.g. Tilemap_L3Crusher), the stripe data will overwrite
 * these again — matching the game's actual ordering.
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
    [STATUS_BAR_ROW2_ADDR, 2 * L3_TILEMAP_COLS + 2,  28],
    [STATUS_BAR_ROW3_ADDR, 3 * L3_TILEMAP_COLS + 3,  27],
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
export function applyInitialTimer(
  rom: RomFile,
  tilemap: Uint16Array,
  timeLimit: number,
): void {
  const idx = timeLimit & 0x03
  const hundreds = rom.readByte(TIMER_TABLE_ADDR + idx) ?? 0
  if (hundreds === 0) return  // no timer on this level — leave placeholders
  // StatusBarRow3 entries at these positions have attribute byte $3C
  // (palette 7, priority set); UpdateTime's 1-byte DMA only overwrites the
  // char-index, so attributes are inherited from UploadStaticBar.
  const ATTR = 0x3C
  // HUD3 base in flat layout = row 3 col 3 (from hw $5063 sub 0 row 3 col 3).
  // Timer digits sit at HUD3 positions 16-18 = row 3 cols 19-21.
  const base = 3 * L3_TILEMAP_COLS + (3 + 16)
  tilemap[base]     = (ATTR << 8) | hundreds
  tilemap[base + 1] = (ATTR << 8) | 0  // tens = 0
  tilemap[base + 2] = (ATTR << 8) | 0  // ones = 0
}

/**
 * Return the initial Layer1YPos (camera Y) in pixels for a level, picking the
 * correct entrance based on level number.
 *
 * Primary entrances (levels $000-$0FF, bank_05.asm:7329-7335):
 *   Layer1YPos = DATA_05D708[bits 3:2 of DATA_05F200[level]]
 *
 * Secondary entrances (levels $100-$1FF and any level reached via pipe/door,
 *  bank_05.asm:7129-7136):
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
      const settings = rom.readByte(DATA_05F200_ADDR + levelId) ?? 0
      const idx = (settings >> 2) & 0x03
      loByte = rom.readByte(DATA_05D708_ADDR + idx) ?? 0
    }
  } else {
    const settings = rom.readByte(DATA_05F200_ADDR + levelId) ?? 0
    const idx = (settings >> 2) & 0x03
    loByte = rom.readByte(DATA_05D708_ADDR + idx) ?? 0
  }

  if (!isVertical) return loByte
  const hiByte = (rom.readByte(DATA_05F600_ADDR + levelId) ?? 0) & 0x1F
  return (hiByte << 8) | loByte
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
 * Per CODE_009FB8 (bank_00.asm):
 *   byte < $80 → tide effect: $70 (up-and-down) or $40 (stationary tide)
 *   byte >= $80 and byte < $C0 → non-tide overlay → $D0
 *   byte >= $C0 → no L3 background written (crusherColors / special) → 0
 */
export function l3InitialYPx(settingsByte: number): number {
  if (settingsByte >= 0xC0) return 0
  if (settingsByte >= 0x80) return 0xD0  // cage bars, windows, crusher, fish
  // Tide: bit 0 distinguishes up-and-down ($01) from stationary ($00)
  return (settingsByte & 0x01) !== 0 ? 0x70 : 0x40
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
 * Parse a stripe-image byte stream into a 64×64 VRAM tilemap buffer.
 *
 * The returned Uint16Array has 4096 entries; index = row*64 + col.
 * VRAM word address for entry i = L3_TILEMAP_BASE + i.
 * Entries outside $5000–$5FFF are silently ignored.
 *
 * RLE format (bit 6 of FLAGS set): the data payload is exactly 2 bytes
 * (one tile word) that gets DMA-repeated countBytes/2 times in VRAM.
 * Y advances by 2 in the stream (not countBytes) — per LoadStripeImage ASM
 * LDX.W #2 / STX.B _3 / ADC.B _3 / TAY after the RLE DMA branch.
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
    if (b0 & 0x80) break  // terminator (bit 7 set)
    if (i + 3 >= data.length) break

    const b1 = data[i + 1]!
    const b2 = data[i + 2]!
    const b3 = data[i + 3]!
    const vramAddr = (b0 << 8) | b1
    const vertical = (b2 & 0x80) !== 0
    const rle      = (b2 & 0x40) !== 0
    const countBytes = (((b2 & 0x3F) << 8) | b3) + 1
    i += 4

    const tileCount = countBytes >> 1
    const vramOffset = vramAddr - L3_TILEMAP_BASE

    if (rle) {
      // RLE: 2 data bytes (one tile word) repeated tileCount times.
      // The stream advances by only 2, not countBytes.
      if (i + 1 >= data.length) break
      const lo = data[i]!
      const hi = data[i + 1]!
      i += 2
      const word = (hi << 8) | lo
      for (let t = 0; t < tileCount; t++) {
        const pos = vertical
          ? vramOffset + t * L3_TILEMAP_COLS
          : vramOffset + t
        if (pos >= 0 && pos < L3_TILEMAP_COLS * L3_TILEMAP_ROWS) {
          tilemap[pos] = word
        }
      }
      continue
    }

    for (let t = 0; t < tileCount; t++) {
      if (i + 1 >= data.length) break
      const lo = data[i]!
      const hi = data[i + 1]!
      i += 2
      const word = (hi << 8) | lo
      const pos = vertical
        ? vramOffset + t * L3_TILEMAP_COLS
        : vramOffset + t
      if (pos >= 0 && pos < L3_TILEMAP_COLS * L3_TILEMAP_ROWS) {
        tilemap[pos] = word
      }
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
  const initialYPx   = l3InitialYPx(settingsByte)
  const initialCameraYPx = readInitialLayer1YPos(rom, levelId)

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
  }
}
