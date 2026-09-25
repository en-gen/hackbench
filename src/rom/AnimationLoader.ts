/**
 * Animation tile loader for Super Mario World.
 *
 * SMW animates tiles by periodically DMA-copying new 8x8 tile graphics into VRAM.
 * The source data comes from GFX33 (the "Animated Tile Graphics" file), which is
 * LC_LZ2-compressed in ROM and decompressed at startup into RAM at $7E:7D00
 * (the AnimatedTiles buffer). The decompressed 3bpp data is expanded to 4bpp
 * in-place by the routine at $00B888.
 *
 * ── Animation frame structure ─────────────────────────────────────────────────
 *
 * The animation engine (CODE_05BB39 at $05BB39) uses an 8-bit counter called
 * EffFrame ($13). Each frame, it:
 *   1. Selects a tile group:  group = EffFrame & 7        (0–7, 8 groups)
 *   2. Selects a frame:       frame = (EffFrame >> 3) & 3 (0–3, 4 frames)
 *   3. For each group, loads 3 sets of 4 tiles (128 bytes each) from the
 *      AnimatedTiles buffer into VRAM at addresses specified by tables at
 *      $05B93B, $05B93D, $05B93F.
 *   4. The source offset within AnimatedTiles is determined by the
 *      AnimatedTileData table at $05B999, which is indexed by tile group,
 *      tileset, and P-switch/ON-OFF state.
 *
 * ── Timing ────────────────────────────────────────────────────────────────────
 *
 * CODE_00A5F9 processes all 8 groups each game frame, incrementing EffFrame
 * for each group. The frame bits (bits 3-4) change every 8 groups = 8 calls
 * to CODE_05BB39. At 60fps, the full animation cycle of 4 frames completes
 * every 32 groups / 8 groups-per-frame = 4 game frames, but CODE_00A5F9 is
 * called once per NMI and processes all 8 in a burst. So the visible frame
 * changes every NMI = every ~16.7ms. The 4-frame cycle repeats every 4 NMIs
 * = ~66.7ms = ~15 fps for the animation cycle.
 *
 * For display in the editor we use ~133ms per frame (7.5 fps) for a clearly
 * visible animation that's close to the original speed.
 *
 * ── VRAM destination mapping ──────────────────────────────────────────────────
 *
 * The DATA_05B93B/3D/3F tables store VRAM word addresses. To convert to
 * character numbers: charNum = vramAddr / 16 (since each 4bpp tile is 16 words).
 * Example: VRAM $0600 → char $060 (in FG1 slot $000–$07F).
 *
 * The animated tiles replace chars in multiple VRAM slots - not just AN1.
 * Different tile groups target different char ranges depending on the
 * animation type (coins, question blocks, water, lava, etc.).
 *
 * ── ROM addresses ─────────────────────────────────────────────────────────────
 *
 * GFX33/GFX32 sources: immediates in CODE_00B888, reached from $009414
 * AnimatedTileData:    $05B999 (table of 2-byte pointers into AnimatedTiles RAM)
 * VRAM dest tables:    $05B93B, $05B93D, $05B93F
 * Tile behavior table: $05B96B (0=static, 1=P-switch/ON-OFF, 2=tileset-dependent)
 * Tileset offset table:$05B98B (per-tileset offset into AnimatedTileData)
 * P-switch index table:$05B97D
 *
 * References: bank_05.asm lines 4145–4447, bank_00.asm lines 4891–4900, 6247–6290
 */

import { RomFile } from './RomFile'
import { decompress } from './LcLz2'
import { loromToOffset } from './addressing'
import { matchesAt, WILD, type BytePattern } from './BytePattern'
import { PIXELS_PER_TILE } from './GraphicsDecoder'
import { framesToMs } from './timing'

// ── ROM addresses ────────────────────────────────────────────────────────────

// GM01Presents' `JSR CODE_00B888` (bank_00.asm:2300); the routine is found through it.
const GFX_LOAD_CALL = 0x009414
// REP #$10 / LDY #GFX33 / STY GraphicsCompPtr / LDA #bank / STA GraphicsCompPtr+2
// (bank_00.asm:6250-6254).
const GFX33_LOAD: BytePattern = [0xc2, 0x10, 0xa0, WILD, WILD, 0x84, 0x8a, 0xa9, WILD, 0x85, 0x8c]
// CODE_00B8D7's LDA #$8000 / STA GraphicsCompPtr / SEP #$20, $4F bytes into the
// routine (bank_00.asm:6290-6292). The bank byte is left as GFX33 set it.
const GFX32_LOAD_OFFSET = 0x4f
const GFX32_LOAD: BytePattern = [0xa9, WILD, WILD, 0x85, 0x8a, 0xe2, 0x20]
// CODE_00B8C4's BMI CODE_00B8D7 (bank_00.asm:6283): the expansion loop's only exit, so
// a BMI at +$44 landing on +$4F makes the checked LDA the one that runs next.
const EXPAND_EXIT_OFFSET = 0x44
const EXPAND_EXIT: BytePattern = [0x30, GFX32_LOAD_OFFSET - EXPAND_EXIT_OFFSET - 2]

// The level-play `JSL CODE_05BB39` (bank_00.asm:4508), four JSLs past CODE_00A28A's `+`.
const LEVEL_ANIM_CALL = 0x00a2a5
const STOCK_ANIM_ROUTINE = 0x05bb39 // CODE_05BB39, bank_05.asm:4383

/** Maximum compressed size to read for GFX33 decompression. */
const GFX33_MAX_COMPRESSED = 0x4000

/** AnimatedTileData table in bank_05 - 2-byte pointers into AnimatedTiles RAM. */
const ANIMATED_TILE_DATA_ADDR = 0x05b999

/** VRAM destination address tables (each entry is 2 bytes LE). */
const VRAM_DEST_TABLE_C = 0x05b93b
const VRAM_DEST_TABLE_B = 0x05b93d
const VRAM_DEST_TABLE_A = 0x05b93f

/** Tile behavior type table - one byte per tile index (18 entries). */
const TILE_BEHAVIOR_TABLE = 0x05b96b

/** Per-slot P-switch/ON-OFF selector for behavior=1 slots (0=blue, 1=silver, 2=ON/OFF). */
const PSWITCH_SELECTOR_TABLE = 0x05b97d

/** Per-tileset offset into AnimatedTileData for behavior type 2. */
const TILESET_OFFSET_TABLE = 0x05b98b

/**
 * Slot-index shift applied by the animation routine when a P-switch/ON-OFF is
 * active (bank_05.asm:4421: `CLC; ADC #$26`). Treats the active slot as if it
 * were slot + 0x26 when indexing AnimatedTileData, loading different pixels
 * into the same VRAM chars.
 */
const PSWITCH_SLOT_SHIFT = 0x26

/** PSWITCH_SELECTOR_TABLE value meaning "track the blue P-switch timer". */
const PSWITCH_SELECTOR_BLUE = 0

/** Number of animation frames in one complete cycle. */
export const ANIM_FRAME_COUNT = 4

/** Number of tile groups processed per frame. */
const TILE_GROUP_COUNT = 8

/** Tiles per DMA transfer (128 bytes / 32 bytes per 4bpp tile). */
const TILES_PER_TRANSFER = 4

/**
 * Animation interval in ms matching SNES timing.
 *
 * From the disassembly:
 * - CODE_00A5F9 (line 4891): called once per game frame, processes all 8 tile groups
 * - TRB #$E7 clears bits 0-2,5-7 of EffFrame, preserving bits 3-4 (frame counter)
 * - The loop increments EffFrame 8 times (groups 0-7), wrapping bits 0-2 back to 0
 * - The main game loop (line 7904) also INC EffFrame once per frame
 * - Bits 3-4 (animation frame) advance when bits 0-2 overflow: every 8 game frames
 * - At 60 FPS: 8/60 ≈ 133ms per animation frame change
 * - Full 4-frame cycle = 4 × 133ms ≈ 533ms
 */
export const ANIM_FRAME_STRIDE = 8
export const ANIM_INTERVAL_MS = Math.round(framesToMs(ANIM_FRAME_STRIDE)) // ~133ms per animation frame

/**
 * RAM layout after CODE_00B888 (bank_00.asm lines 6250-6302):
 *
 *   $7E:2000 - MarioGraphics start. GFX33 decompresses here (3bpp), then gets
 *              expanded to 4bpp at $7D00-$ACFE. Then GFX32 decompresses into
 *              $2000+ (overwriting the original GFX33 3bpp data).
 *
 *   $7E:2000-$7CFF - GFX32 decompressed 3bpp data (Mario sprites). Berry
 *                     animation frames reference addresses in this region
 *                     (e.g., $6D80 = MarioGraphics + $4D80).
 *
 *   $7E:7D00-$ACFE - GFX33 expanded 4bpp data (AnimatedTiles). Most animation
 *                     frames reference addresses here.
 *
 * The AnimatedTileData table stores 16-bit WRAM pointers. We use
 * MARIO_GRAPHICS_RAM_BASE ($2000) as our buffer base so both GFX32 and GFX33
 * regions can be addressed with positive offsets.
 */
const MARIO_GRAPHICS_RAM_BASE = 0x2000
const ANIMATED_TILES_RAM_BASE = 0x7d00

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * One animation frame's data for a specific VRAM char range.
 * Contains decoded 8x8 tile pixel data (palette indices) for 4 consecutive tiles.
 */
export interface AnimFrameSlot {
  /** Starting VRAM character number where these tiles go. */
  charBase: number
  /** 4 tiles of pixel data, each PIXELS_PER_TILE palette indices. */
  tiles: Uint8Array[]
  /**
   * Alternate pixel data loaded into the same VRAM chars when the blue
   * P-switch is active. Populated only for slots whose
   * `DATA_05B96B` behavior byte is 1 and `DATA_05B97D` selector is 0
   * (blue). Undefined otherwise. bank_05.asm:4417-4422 reads the slot
   * index shifted by 0x26 into `AnimatedTileData` while the P-switch
   * timer is non-zero, so the same VRAM chars render different pixels.
   */
  altTiles?: Uint8Array[]
}

/**
 * Complete animation data for a level's tileset.
 * For each animation frame (0–3), provides the set of VRAM char replacements.
 */
export interface AnimationData {
  /** Number of frames in the cycle (always 4). */
  frameCount: number
  /** For each frame index, the list of char replacements to apply. */
  frames: AnimFrameSlot[][]
  /** Recommended interval between frames in milliseconds. */
  intervalMs: number
}

// ── 3bpp → 4bpp expansion ────────────────────────────────────────────────────

/**
 * Expand decompressed 3bpp GFX data to 4bpp format, replicating the
 * in-place expansion done by CODE_00B888 in the SMW ROM.
 *
 * 3bpp tile: 24 bytes = 16 bytes (bitplanes 0+1 interleaved) + 8 bytes (bitplane 2)
 * 4bpp tile: 32 bytes = 16 bytes (bitplanes 0+1) + 16 bytes (bitplanes 2+3, bp3=0)
 *
 * The expansion inserts a zero byte after each bitplane-2 byte to create
 * the bitplane-3 position (always zero for 3bpp source data).
 */
function expand3bppTo4bpp(data3bpp: Uint8Array): Uint8Array {
  const tileCount = Math.floor(data3bpp.length / 24)
  const out = new Uint8Array(tileCount * 32)

  for (let t = 0; t < tileCount; t++) {
    const src = t * 24
    const dst = t * 32

    // Copy bitplanes 0+1 (16 bytes) directly
    for (let i = 0; i < 16; i++) {
      out[dst + i] = data3bpp[src + i]
    }

    // Expand bitplane 2 (8 bytes) → bitplanes 2+3 (16 bytes, bp3=0)
    for (let row = 0; row < 8; row++) {
      out[dst + 16 + row * 2] = data3bpp[src + 16 + row]
      out[dst + 16 + row * 2 + 1] = 0 // bitplane 3 = zero
    }
  }

  return out
}

// ── Core loader ──────────────────────────────────────────────────────────────

export type AnimGfxSources =
  { ok: true; gfx33: number; gfx32Offset: number } | { ok: false; reason: string }

/** GFX33's address and GFX32's in-bank offset, from CODE_00B888's own immediates. */
export function readAnimGfxSources(rom: RomFile): AnimGfxSources {
  const at = (snes: number): number | null => loromToOffset(snes, rom.romSize)
  const callAt = at(GFX_LOAD_CALL)
  const call = callAt === null ? null : matchesAt(rom, callAt, [0x20, WILD, WILD])
  if (!call)
    return { ok: false, reason: '$009414 no longer calls the GFX33/GFX32 loader with a JSR' }
  const routineAt = at(call[1]! | (call[2]! << 8))
  const head = routineAt === null ? null : matchesAt(rom, routineAt, GFX33_LOAD)
  if (!head) return { ok: false, reason: 'the GFX33 load in CODE_00B888 is not LDY/LDA #imm' }
  const tail = matchesAt(rom, routineAt! + GFX32_LOAD_OFFSET, GFX32_LOAD)
  const exit = matchesAt(rom, routineAt! + EXPAND_EXIT_OFFSET, EXPAND_EXIT)
  if (!tail || !exit) return { ok: false, reason: 'the GFX32 load in CODE_00B888 is not LDA #imm' }
  const bank = (head[8]! & 0x7f) << 16
  return {
    ok: true,
    gfx33: bank | head[3]! | (head[4]! << 8),
    gfx32Offset: tail[1]! | (tail[2]! << 8),
  }
}

/** The level animation call's other target, or why it cannot be read; null while it reaches CODE_05BB39. */
export function stockAnimationUnreached(
  rom: RomFile,
): { target: number } | { reason: string } | null {
  const callAt = loromToOffset(LEVEL_ANIM_CALL, rom.romSize)
  const jsl = callAt === null ? null : matchesAt(rom, callAt, [0x22, WILD, WILD, WILD])
  if (!jsl) return { reason: 'the level animation call at $00A2A5 is no longer a JSL' }
  const target = (jsl[1]! | (jsl[2]! << 8) | (jsl[3]! << 16)) & 0x7fffff
  return target === STOCK_ANIM_ROUTINE ? null : { target }
}

/**
 * Build the full MarioGraphics RAM region as the game does in CODE_00B888.
 *
 * Replicates the sequence:
 *   1. Decompress GFX33 (3bpp) into MarioGraphics ($2000)
 *   2. Expand GFX33 3bpp → 4bpp, writing from $ACFE downward to $7D00
 *   3. Decompress GFX32 (3bpp) into MarioGraphics ($2000), overwriting the
 *      original GFX33 source data
 *
 * Returns a buffer indexed from MARIO_GRAPHICS_RAM_BASE ($2000):
 *   buffer[addr - $2000] = RAM byte at $7E:addr
 *
 * Berry animations reference $6D80-$7C80 (GFX32 3bpp region).
 * Standard animations reference $7D00-$ACFE (GFX33 expanded 4bpp region).
 */
function loadAnimatedTileBuffer(rom: RomFile): Uint8Array | null {
  // Replicate CODE_00B888 (bank_00.asm lines 6250-6302):
  //
  // Step 1: Decompress GFX33 (from CODE_00B888's immediates) into MarioGraphics ($2000).
  //         This is a SPECIAL oversized GFX33 (not the same as the pointer table entry).
  //         Decompresses to much more than 9216 bytes - fills $2000 to ~$7B00+.
  //
  // Step 2: Expand first $2400 bytes (384 tiles) from 3bpp→4bpp,
  //         writing from $ACFE downward to $7D00 (the AnimatedTiles region).
  //         Data past $4400 in the decompressed output is NOT expanded - it stays
  //         as raw 3bpp. Berry animation frames reference this region.
  //
  // Step 3: Decompress GFX32 into $2000, overwriting the first ~$C00 bytes.
  //
  // Our buffer covers $2000-$ACFE, indexed from MARIO_GRAPHICS_RAM_BASE ($2000).

  const sources = readAnimGfxSources(rom)
  if (!sources.ok) return null
  const gfx33Compressed = rom.readAt(sources.gfx33, GFX33_MAX_COMPRESSED)
  if (!gfx33Compressed) return null
  const meter = { consumed: 0, terminated: false }
  const gfx33Decompressed = decompress(gfx33Compressed, 0, undefined, meter)
  if (gfx33Decompressed.length === 0 || !meter.terminated) return null

  // Expand ALL decompressed bytes from 3bpp → 4bpp.
  // CODE_00B888 starts LDX at #$23FF and processes source bytes from X down to 0.
  // The destination starts at $ACFE and writes downward. Mesen confirms the expansion
  // writes well below $7D00 (e.g., $6D80 for berry data), meaning the full expanded
  // output is larger than just the AnimatedTiles region.
  const gfx33Expanded = expand3bppTo4bpp(gfx33Decompressed)

  // ReadByte steps into the next bank past $FFFF, terminator included (bank_00.asm:6405-6412),
  // and CODE_00B8D7 sets only the low word, so GFX32 sits in the bank GFX33's stream ended in.
  const endBank = (sources.gfx33 >> 16) + (((sources.gfx33 & 0x7fff) + meter.consumed) >> 15)
  const gfx32Compressed = rom.readAt((endBank << 16) | sources.gfx32Offset, GFX33_MAX_COMPRESSED)
  // Pre-fill the output buffer with the expanded GFX33 data at the correct offset.
  // The game decompresses GFX32 into RAM that already contains GFX33 expanded data
  // at $7D00+ ($5D00+ in our buffer). Backreferences in GFX32 can read from this data.
  const ANIM_TILES_BUF_OFFSET = ANIMATED_TILES_RAM_BASE - MARIO_GRAPHICS_RAM_BASE // $5D00
  const preFilled = new Uint8Array(ANIM_TILES_BUF_OFFSET + gfx33Expanded.length)
  preFilled.set(gfx33Expanded, ANIM_TILES_BUF_OFFSET)
  let gfx32Decompressed: Uint8Array = preFilled
  if (gfx32Compressed) {
    gfx32Decompressed = decompress(gfx32Compressed, 0, preFilled)
  }

  // The decompressed GFX32 output already includes the pre-filled GFX33 expanded data.
  // It's the full MarioGraphics buffer matching the game's RAM layout:
  //   buffer[0..$5CFF]: GFX32 4bpp data (from decompression)
  //   buffer[$5D00+]: GFX33 expanded 4bpp data (from pre-fill, preserved by GFX32 decompression)
  const buffer =
    gfx32Decompressed instanceof Uint8Array ? gfx32Decompressed : new Uint8Array(gfx32Decompressed)

  return buffer
}

/**
 * Read a 16-bit LE word from the AnimatedTileData table at $05B999.
 * @param byteOffset - byte offset into the table (already accounts for 2-byte entries)
 * The table stores WRAM addresses; we subtract AnimatedTiles base to get buffer offsets.
 */
function readAnimatedTileDataEntry(rom: RomFile, byteOffset: number): number {
  const addr = ANIMATED_TILE_DATA_ADDR + byteOffset
  const buf = rom.readAt(addr, 2)
  if (!buf) return 0
  const ramAddr = buf[0] | (buf[1] << 8)
  // Convert WRAM address to buffer offset from MarioGraphics base ($2000).
  // Most entries point into AnimatedTiles ($7D00+), but berry entries point
  // into the GFX32 region ($2000-$7CFF).
  return ramAddr - MARIO_GRAPHICS_RAM_BASE
}

/**
 * Convert a VRAM word address to a character number.
 * In 4bpp mode, each tile uses 16 VRAM words (32 bytes).
 */
function vramAddrToChar(vramAddr: number): number {
  return Math.floor(vramAddr / 16)
}

/**
 * Read a 16-bit LE VRAM destination address from the given table base.
 * @param byteOffset - byte offset into the table (X register value in the disassembly)
 */
function readVramDest(rom: RomFile, tableAddr: number, byteOffset: number): number {
  const buf = rom.readAt(tableAddr + byteOffset, 2)
  if (!buf) return 0
  return buf[0] | (buf[1] << 8)
}

/**
 * Decode 4 consecutive 4bpp tiles from the buffer at the given byte offset.
 *
 * The game DMA's 128 bytes (4 tiles × 32 bytes) from RAM to VRAM regardless
 * of the source region. VRAM always interprets the data as 4bpp. Even berry
 * animation frames that source from the GFX32 3bpp region get treated as raw
 * bytes and interpreted as 4bpp by the SNES PPU.
 */
function decodeTilesAt(buffer: Uint8Array, offset: number): Uint8Array[] {
  const tiles: Uint8Array[] = []
  for (let t = 0; t < TILES_PER_TRANSFER; t++) {
    const tileOffset = offset + t * 32
    if (tileOffset + 32 > buffer.length) {
      tiles.push(new Uint8Array(PIXELS_PER_TILE))
      continue
    }
    const px = new Uint8Array(PIXELS_PER_TILE)
    for (let row = 0; row < 8; row++) {
      const p0lo = buffer[tileOffset + row * 2]
      const p0hi = buffer[tileOffset + row * 2 + 1]
      const p1lo = buffer[tileOffset + 16 + row * 2]
      const p1hi = buffer[tileOffset + 16 + row * 2 + 1]
      for (let col = 0; col < 8; col++) {
        const bit = 7 - col
        px[row * 8 + col] =
          ((p0lo >> bit) & 1) |
          (((p0hi >> bit) & 1) << 1) |
          (((p1lo >> bit) & 1) << 2) |
          (((p1hi >> bit) & 1) << 3)
      }
    }
    tiles.push(px)
  }
  return tiles
}

/**
 * Load animation data for a given tileset.
 *
 * Replicates the logic of CODE_05BB39 to determine which tiles are animated
 * and what graphics data to use for each of the 4 animation frames.
 *
 * @param rom        - ROM file to read from
 * @param tilesetId  - object tileset index (0–15) from the level header
 * @returns AnimationData with frame replacements, or null if GFX33 can't be loaded
 */
export function loadAnimationData(rom: RomFile, tilesetId: number): AnimationData | null {
  const buffer = loadAnimatedTileBuffer(rom)
  if (!buffer) return null

  // Read the behavior and tileset offset tables.
  // The behavior table (DATA_05B96B) has 18 explicit entries, but the SNES reads it
  // for all 24 tile indices (TILE_GROUP_COUNT * 3). Indices 18-23 overflow into
  // DATA_05B97D territory; DATA_05B97D[0] = $02 (tileset-dependent), so tileIdx 18
  // must be treated as behavior 2. Reading 24 bytes replicates the SNES memory layout.
  const behaviorBuf = rom.readAt(TILE_BEHAVIOR_TABLE, TILE_GROUP_COUNT * 3)
  const tilesetOffsetBuf = rom.readAt(TILESET_OFFSET_TABLE, 16)
  // PSWITCH_SELECTOR_TABLE has 14 bytes in vanilla; only indices where the
  // behavior byte is 1 matter (slots 6..13), but reading 24 bytes matches
  // the SNES memory layout in case of out-of-range reads.
  const pSwitchSelectorBuf = rom.readAt(PSWITCH_SELECTOR_TABLE, TILE_GROUP_COUNT * 3)
  if (!behaviorBuf || !tilesetOffsetBuf || !pSwitchSelectorBuf) return null

  const frames: AnimFrameSlot[][] = []

  for (let frame = 0; frame < ANIM_FRAME_COUNT; frame++) {
    const frameSlots: AnimFrameSlot[] = []
    // TILE_DATA_INDEX_PART = frame << 1 (values 0, 2, 4, 6)
    const tileDataIndexPart = frame << 1

    for (let group = 0; group < TILE_GROUP_COUNT; group++) {
      // GFX_TILE_IDX = group * 3 (each group has 3 sub-slots)
      const baseTileIdx = group * 3
      // X register in the disassembly: GFX_TILE_IDX * 2 (byte offset for 16-bit reads)
      const xOffset = baseTileIdx * 2

      // Read VRAM destination addresses for this group.
      // DATA_05B93B/3D/3F are overlapping views into one contiguous block:
      //   C = DATA_05B93B[X], B = DATA_05B93D[X], A = DATA_05B93F[X]
      const vramDestC = readVramDest(rom, VRAM_DEST_TABLE_C, xOffset)
      const vramDestB = readVramDest(rom, VRAM_DEST_TABLE_B, xOffset)
      const vramDestA = readVramDest(rom, VRAM_DEST_TABLE_A, xOffset)
      const vramDests = [vramDestC, vramDestB, vramDestA]

      for (let sub = 0; sub < 3; sub++) {
        const tileIdx = baseTileIdx + sub
        const vramDest = vramDests[sub]

        // Skip if VRAM dest is 0 (no DMA for this slot)
        if (vramDest === 0) continue

        // Determine which AnimatedTileData entry to use based on behavior type
        let adjustedIdx = tileIdx
        const behavior = behaviorBuf[tileIdx] ?? 0

        if (behavior === 1) {
          // P-switch/ON-OFF dependent - use default state (no P-switch active)
        } else if (behavior === 2) {
          // Tileset-dependent - add tileset offset
          const offset = tilesetId < 16 ? tilesetOffsetBuf[tilesetId] : 0
          adjustedIdx = tileIdx + offset
        }

        // Compute AnimatedTileData table index:
        // index = ((adjustedIdx & 0xFF) << 3) | tileDataIndexPart
        const dataTableIdx = ((adjustedIdx & 0xff) << 3) | tileDataIndexPart
        const bufferOffset = readAnimatedTileDataEntry(rom, dataTableIdx)

        if (bufferOffset < 0 || bufferOffset + TILES_PER_TRANSFER * 32 > buffer.length) {
          continue
        }

        const tiles = decodeTilesAt(buffer, bufferOffset)

        // Blue-P-switch alt pixel data: for behavior=1 slots whose
        // selector is 0 (blue), load the +0x26 shifted slot too. Same
        // VRAM chars, different pixels. Silver and ON/OFF variants use
        // different timers and are ignored for now -- the editor
        // currently only toggles blue.
        let altTiles: Uint8Array[] | undefined
        if (behavior === 1 && pSwitchSelectorBuf[tileIdx] === PSWITCH_SELECTOR_BLUE) {
          const altIdx = (tileIdx + PSWITCH_SLOT_SHIFT) & 0xff
          const altDataTableIdx = (altIdx << 3) | tileDataIndexPart
          const altBufferOffset = readAnimatedTileDataEntry(rom, altDataTableIdx)
          if (altBufferOffset >= 0 && altBufferOffset + TILES_PER_TRANSFER * 32 <= buffer.length) {
            altTiles = decodeTilesAt(buffer, altBufferOffset)
          }
        }

        frameSlots.push(...destSlots(vramDest, tiles, altTiles))
      }
    }

    frames.push(frameSlots)
  }

  return {
    frameCount: ANIM_FRAME_COUNT,
    frames,
    intervalMs: ANIM_INTERVAL_MS,
  }
}

/**
 * The slots one transfer fills. The DMA at CODE_00A3F0 (bank_00.asm ~4649) splits
 * the berry's $0800 transfer: 2 tiles to $0800 and 2 to $0900, a 2x2 in the grid.
 * Berry slots are behavior 2, never P-switch, so they carry no altTiles.
 */
function destSlots(
  vramDest: number,
  tiles: Uint8Array[],
  altTiles?: Uint8Array[],
): AnimFrameSlot[] {
  const charBase = vramAddrToChar(vramDest)
  if (vramDest !== 0x0800) return [{ charBase, tiles, altTiles }]
  return [
    { charBase, tiles: tiles.slice(0, 2) },
    { charBase: vramAddrToChar(0x0900), tiles: tiles.slice(2, 4) },
  ]
}

/** Every character the stock routine writes, from its destination tables alone. */
export function stockAnimatedChars(rom: RomFile): Set<number> {
  const chars = new Set<number>()
  const tiles = Array.from({ length: TILES_PER_TRANSFER }, () => new Uint8Array(0))
  // DATA_05B93B/3D/3F overlap, so slot t's destination is the word at $05B93B + 2t.
  for (let t = 0; t < TILE_GROUP_COUNT * 3; t++) {
    const dest = readVramDest(rom, VRAM_DEST_TABLE_C, t * 2)
    if (dest === 0) continue
    for (const slot of destSlots(dest, tiles))
      slot.tiles.forEach((_, i) => chars.add(slot.charBase + i))
  }
  return chars
}

/**
 * Determine which VRAM character numbers are affected by animation.
 * Returns a Set of char numbers that will be replaced during animation.
 * Useful for quickly checking if a Map16 subtile references an animated char.
 */
export function getAnimatedChars(animData: AnimationData): Set<number> {
  const chars = new Set<number>()
  for (const frameSlots of animData.frames) {
    for (const slot of frameSlots) {
      for (let i = 0; i < TILES_PER_TRANSFER; i++) {
        chars.add(slot.charBase + i)
      }
    }
  }
  return chars
}

/**
 * Serialize animation data for transfer to the webview.
 *
 * Converts Uint8Array tile data to plain number arrays for JSON serialization
 * via postMessage. The webview will use this to update its tile atlas on each
 * animation frame.
 *
 * Returns a structure matching AnimationData but with tiles as number[][].
 */
export function serializeAnimationData(animData: AnimationData): {
  frameCount: number
  intervalMs: number
  frames: Array<
    Array<{
      charBase: number
      tiles: number[][] // 4 tiles, each PIXELS_PER_TILE palette indices
    }>
  >
} {
  return {
    frameCount: animData.frameCount,
    intervalMs: animData.intervalMs,
    frames: animData.frames.map(frameSlots =>
      frameSlots.map(slot => ({
        charBase: slot.charBase,
        tiles: slot.tiles.map(t => Array.from(t)),
      })),
    ),
  }
}
