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
 * Tile behavior table: $05B96B (0=static, 1=switched, any other=tileset-dependent)
 * Tileset offset table:$05B98B (per-tileset offset into AnimatedTileData)
 * P-switch index table:$05B97D
 *
 * References: bank_05.asm lines 4145–4447, bank_00.asm lines 4891–4900, 6247–6290
 */

import { RomFile } from './RomFile'
import { tryDecompress, type BackRefOrder } from './LcLz2'
import { formatAddr, loromToOffset, mirror } from './addressing'
import { matchesAt, WILD, type BytePattern } from './BytePattern'
import { PIXELS_PER_TILE } from './GraphicsDecoder'
import { framesToMs } from './timing'
import {
  FAST_LCLZ2,
  type DecompressorKind,
  type FastRoutine,
  commandRefusal,
  readDecompressor,
} from './GfxDecompressor'

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
// GFX33's JSR CODE_00B8DE (bank_00.asm:6260), and CODE_00B8DE itself, which the GFX32
// load's SEP #$20 falls into (bank_00.asm:6292-6294): both loads run the one entry.
const GFX33_CALL_OFFSET = 0x14
const DECOMPRESSOR_OFFSET = GFX32_LOAD_OFFSET + GFX32_LOAD.length

// The level-play `JSL CODE_05BB39` (bank_00.asm:4508), four JSLs past CODE_00A28A's `+`.
const LEVEL_ANIM_CALL = 0x00a2a5
const STOCK_ANIM_ROUTINE = 0x05bb39 // CODE_05BB39, bank_05.asm:4383

/** Maximum compressed size to read for GFX33 decompression. */
const GFX33_MAX_COMPRESSED = 0x4000

/** The tables CODE_05BB39 reads, as SNES addresses. */
interface AnimTables {
  /** DATA_05B93B/3D/3F, the C/B/A destinations of each group's three slots. */
  vramDest: number[]
  behaviorTable: number
  tilesetOffsetTable: number
  animatedTileData: number
}

// Vanilla addresses (#576), used only when CODE_05BB39 cannot be read: the frames they give
// carry `unverified`, so the Map16 view shows them still, with the error, and never plays
// them. Switch alternates never come from here.
const LEGACY_TABLES: AnimTables = {
  vramDest: [0x05b93b, 0x05b93d, 0x05b93f],
  behaviorTable: 0x05b96b,
  tilesetOffsetTable: 0x05b98b,
  animatedTileData: 0x05b999,
}

// CODE_05BB39 is checked from its entry, at fixed offsets, so a JML over any part refuses.
// Set-up (bank_05.asm:4384-4400): straight-line code, nothing read from it.
// prettier-ignore
const ROUTINE_SETUP: BytePattern = [
  0x8b, 0x4b, 0xab, 0xa5, 0x14, 0x29, 0x07, 0x85, 0x00, 0x0a, 0x65, 0x00, 0xa8,
  0x0a, 0xaa, 0xc2, 0x20, 0xa5, 0x14, 0x29, 0x18, 0x00, 0x4a, 0x4a, 0x85, 0x00,
]
// LDA.W DATA_05B93B/3D/3F,X into Gfx33DestAddrC/B/A, then LDX #$04 (bank_05.asm:4401-4407).
const DEST_LOADS_OFFSET = 0x1a
// prettier-ignore
const DEST_LOADS: BytePattern = [
  0xbd, WILD, WILD, 0x8d, 0x80, 0x0d, 0xbd, WILD, WILD, 0x8d, 0x7e, 0x0d,
  0xbd, WILD, WILD, 0x8d, 0x7c, 0x0d, 0xa2, 0x04,
]
// CODE_05BB67's slot loop to the tileset add (bank_05.asm:4408-4427). Both BEQs and the
// BRA must land on the tail at +$21, the BNE on the tileset add at +$1A.
const SLOT_LOOP_OFFSET = 0x2e
// prettier-ignore
const SLOT_LOOP: BytePattern = [
  0x5a, 0xda, 0xe2, 0x20, 0x98, 0xbe, WILD, WILD, 0xf0, 0x17, 0xca, 0xd0, 0x0d,
  0xbe, WILD, WILD, 0xbc, WILD, WILD, 0xf0, 0x0c, 0x18, 0x69, WILD, 0x80, 0x07,
  0xac, 0x31, 0x19, 0x18, 0x79, WILD, WILD,
]
// CODE_05BB88 through LDA.W AnimatedTileData,Y (bank_05.asm:4429-4436).
const SLOT_TAIL_OFFSET = 0x4f
// prettier-ignore
const SLOT_TAIL: BytePattern = [0xc2, 0x30, 0x29, 0xff, 0x00, 0x0a, 0x0a, 0x0a, 0x05, 0x00, 0xa8, 0xb9, WILD, WILD]
// SEP #$10 / PLX / STA Gfx33SrcAddrA,X / PLY / INY / DEX / DEX / BPL CODE_05BB67 / SEP #$20
// / PLB / RTL (bank_05.asm:4437-4447): the loaded address reaches the upload and the loop.
const SLOT_CLOSE_OFFSET = 0x5d
// prettier-ignore
const SLOT_CLOSE: BytePattern = [
  0xe2, 0x10, 0xfa, 0x9d, 0x76, 0x0d, 0x7a, 0xc8, 0xca, 0xca, 0x10, 0xc5, 0xe2, 0x20, 0xab, 0x6b,
]
const ROUTINE_PARTS: [number, BytePattern, string][] = [
  [0, ROUTINE_SETUP, 'set-up (bank_05.asm:4384-4400)'],
  [DEST_LOADS_OFFSET, DEST_LOADS, 'destination loads (bank_05.asm:4401-4407)'],
  [SLOT_LOOP_OFFSET, SLOT_LOOP, 'slot loop (bank_05.asm:4408-4427)'],
  [SLOT_TAIL_OFFSET, SLOT_TAIL, 'AnimatedTileData read (bank_05.asm:4429-4436)'],
  [SLOT_CLOSE_OFFSET, SLOT_CLOSE, 'upload and loop close (bank_05.asm:4437-4447)'],
]
// Bytes each table is read over: X up to 21*2 for the destinations, the 8-bit slot << 3
// with the frame bits for AnimatedTileData, 16 tilesets.
const TABLE_SPAN = {
  vramDest: 44,
  behavior: 24,
  selector: 24,
  tileset: 16,
  animatedTileData: 0x800,
}

// Hack-fragility point: switches are named by RAM identity (rammap.asm:1665-1667), not from
// CODE_00F545, which reads only blue and silver (bank_00.asm:13416,13453) and never ON/OFF.
const SWITCH_RAM: Record<number, SwitchKind> = { 0x14ad: 'blue', 0x14ae: 'silver', 0x14af: 'onOff' }

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
  /** Pixels loaded into the same chars while `switch`'s RAM byte is nonzero (bank_05.asm:4417-4421). */
  alt?: { switch: SwitchKind; tiles: Uint8Array[] }
  /** The behavior table marks this slot switched (1), whether or not `alt` could be read. */
  switched?: true
}

export type SwitchKind = 'blue' | 'silver' | 'onOff'
/** Per-caller input to char resolution, never to the Map16 grid. */
export type SwitchState = Record<SwitchKind, boolean>

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
  /** Why the frames are unverified: the routine read failed and the vanilla tables served. */
  unverified?: string
  /** Why some or all switch alternates are missing; absent when every one was read. */
  switchUnavailable?: string
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
  | { ok: true; gfx33: number; gfx32Offset: number; kind: DecompressorKind; order: BackRefOrder }
  | { ok: false; reason: string }

/** GFX33's address and GFX32's in-bank offset, from CODE_00B888's own immediates, each
 *  XORed with the decompressor's pointer key as its prelude would. */
export function readAnimGfxSources(
  rom: RomFile,
  fast: readonly FastRoutine[] = FAST_LCLZ2,
): AnimGfxSources {
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
  const entry = (call[1]! | (call[2]! << 8)) + DECOMPRESSOR_OFFSET
  if (!matchesAt(rom, routineAt! + GFX33_CALL_OFFSET, [0x20, entry & 0xff, entry >> 8]))
    return { ok: false, reason: 'GFX33 is not decompressed by the routine GFX32 falls into' }
  const d = readDecompressor(rom, entry, fast)
  if (!d.ok) return d
  const key = d.key
  const bank = (head[8]! & 0x7f) << 16
  return {
    ok: true,
    gfx33: bank | ((head[3]! | (head[4]! << 8)) ^ key),
    gfx32Offset: (tail[1]! | (tail[2]! << 8)) ^ key,
    kind: d.kind,
    order: d.order,
  }
}

/** The level animation call's other target, or why it cannot be read; null while it reaches CODE_05BB39. */
export function stockAnimationUnreached(
  rom: RomFile,
): { target: number } | { reason: string } | null {
  const callAt = loromToOffset(LEVEL_ANIM_CALL, rom.romSize)
  const jsl = callAt === null ? null : matchesAt(rom, callAt, [0x22, WILD, WILD, WILD])
  if (!jsl) return { reason: 'the level animation call at $00A2A5 is no longer a JSL' }
  // The compare folds (key); the reported target keeps its bank as written.
  const target = jsl[1]! | (jsl[2]! << 8) | (jsl[3]! << 16)
  return mirror(target) === STOCK_ANIM_ROUTINE ? null : { target }
}

/** CODE_05BB39's tables, timer base and shift, from its own operands. */
export function readAnimRoutine(
  rom: RomFile,
):
  | ({ ok: true; selectorTable: number; timerBase: number; shift: number } & AnimTables)
  | { ok: false; reason: string } {
  const unreached = stockAnimationUnreached(rom)
  if (unreached)
    return {
      ok: false,
      reason:
        'reason' in unreached
          ? unreached.reason
          : `the level animation call reaches ${formatAddr(unreached.target)}, not CODE_05BB39`,
    }
  const entry = loromToOffset(STOCK_ANIM_ROUTINE, rom.romSize)
  const parts = ROUTINE_PARTS.map(([o, p]) =>
    entry === null ? null : matchesAt(rom, entry + o, p),
  )
  const broken = parts.findIndex(b => !b)
  if (broken >= 0)
    return { ok: false, reason: `CODE_05BB39's ${ROUTINE_PARTS[broken]![2]} is replaced` }
  const [, dest, loop, tail] = parts as Buffer[]
  // PHK/PLB (bank_05.asm:4385-4386): absolute operands are in the routine's own bank.
  const abs = (b: Buffer, i: number): number =>
    (STOCK_ANIM_ROUTINE & 0xff0000) | b[i]! | (b[i + 1]! << 8)
  const read = {
    vramDest: [abs(dest!, 1), abs(dest!, 7), abs(dest!, 13)],
    behaviorTable: abs(loop!, 6),
    selectorTable: abs(loop!, 0xe),
    timerBase: loop![0x11]! | (loop![0x12]! << 8),
    shift: loop![0x17]!,
    tilesetOffsetTable: abs(loop!, 0x1f),
    animatedTileData: abs(tail!, 12),
  }
  const fault = [
    ...read.vramDest.map(a => tableFault('VRAM destination', a, TABLE_SPAN.vramDest)),
    tableFault('behavior', read.behaviorTable, TABLE_SPAN.behavior),
    tableFault('tileset offset', read.tilesetOffsetTable, TABLE_SPAN.tileset),
    tableFault('AnimatedTileData', read.animatedTileData, TABLE_SPAN.animatedTileData),
  ].find(f => f)
  return fault ? { ok: false, reason: fault } : { ok: true, ...read }
}

/**
 * Why an abs,Y table cannot be read as ROM: below $8000 is the WRAM mirror, and a read
 * past $xxFFFF wraps within the data bank into WRAM, where a file read would run on.
 */
function tableFault(name: string, addr: number, span: number): string | null {
  if ((addr & 0xffff) < 0x8000) return `the ${name} table ${formatAddr(addr)} is in WRAM`
  if ((addr & 0xffff) + span > 0x10000)
    return `the ${name} table ${formatAddr(addr)} crosses its bank end`
  return null
}

const ramAddr = (a: number): string => '$' + a.toString(16).toUpperCase().padStart(4, '0')

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
function loadAnimatedTileBuffer(
  rom: RomFile,
  fast: readonly FastRoutine[],
): { ok: true; buffer: Uint8Array } | { ok: false; reason: string } {
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

  const sources = readAnimGfxSources(rom, fast)
  if (!sources.ok) return sources
  const gfx33Compressed = rom.readAt(sources.gfx33, GFX33_MAX_COMPRESSED)
  if (!gfx33Compressed) return { ok: false, reason: 'GFX33 points outside the ROM' }
  const refused = commandRefusal(sources.kind, gfx33Compressed)
  if (refused) return { ok: false, reason: `GFX33: ${refused}` }
  const meter = { consumed: 0, terminated: false }
  const gfx33 = tryDecompress(gfx33Compressed, { meter, order: sources.order })
  if (!gfx33.ok) return gfx33
  if (gfx33.bytes.length === 0) return { ok: false, reason: 'GFX33 decompressed to no bytes' }

  // Expand ALL decompressed bytes from 3bpp → 4bpp.
  // CODE_00B888 starts LDX at #$23FF and processes source bytes from X down to 0.
  // The destination starts at $ACFE and writes downward. Mesen confirms the expansion
  // writes well below $7D00 (e.g., $6D80 for berry data), meaning the full expanded
  // output is larger than just the AnimatedTiles region.
  const gfx33Expanded = expand3bppTo4bpp(gfx33.bytes)

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
  if (!gfx32Compressed) return { ok: false, reason: 'GFX32 points outside the ROM' }
  const refused32 = commandRefusal(sources.kind, gfx32Compressed)
  if (refused32) return { ok: false, reason: `GFX32: ${refused32}` }
  const gfx32 = tryDecompress(gfx32Compressed, {
    initialBuffer: preFilled,
    order: sources.order,
  })
  if (!gfx32.ok) return gfx32
  const buffer = gfx32.bytes

  // buffer[0..$5CFF]: GFX32 4bpp data (from decompression)
  // buffer[$5D00+]: GFX33 expanded 4bpp data (from pre-fill, preserved by GFX32 decompression)
  return { ok: true, buffer }
}

/**
 * Read a 16-bit LE word from the AnimatedTileData table at $05B999.
 * @param byteOffset - byte offset into the table (already accounts for 2-byte entries)
 * The table stores WRAM addresses; we subtract AnimatedTiles base to get buffer offsets.
 */
function readAnimatedTileDataEntry(rom: RomFile, table: number, byteOffset: number): number {
  const addr = table + byteOffset
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

export type LoadAnimationResult = { ok: true; data: AnimationData } | { ok: false; reason: string }

/**
 * Load animation data for a given tileset, or the reason nothing could be
 * built: GFX33/GFX32 unreadable (same cause `loadAnimatedTileBuffer`
 * reports), or the behavior or tileset-offset table runs past the end of the ROM.
 *
 * Replicates the logic of CODE_05BB39 to determine which tiles are animated
 * and what graphics data to use for each of the 4 animation frames.
 *
 * @param rom        - ROM file to read from
 * @param tilesetId  - object tileset index (0–15) from the level header
 */
export function loadAnimationDataOrReason(
  rom: RomFile,
  tilesetId: number,
  fast: readonly FastRoutine[] = FAST_LCLZ2,
): LoadAnimationResult {
  const result = loadAnimatedTileBuffer(rom, fast)
  if (!result.ok) return result
  const buffer = result.buffer

  const routine = readAnimRoutine(rom)
  const t = routine.ok ? routine : LEGACY_TABLES
  // The SNES reads the behavior table for all 24 slots; 18-23 overflow into the selector table.
  const behaviorBuf = rom.readAt(t.behaviorTable, TABLE_SPAN.behavior)
  const tilesetOffsetBuf = rom.readAt(t.tilesetOffsetTable, TABLE_SPAN.tileset)
  const unread = (name: string, addr: number): LoadAnimationResult => ({
    ok: false,
    reason: `the animation ${name} table at ${formatAddr(addr)} runs past the end of the ROM`,
  })
  if (!behaviorBuf) return unread('behavior', t.behaviorTable)
  if (!tilesetOffsetBuf) return unread('tileset offset', t.tilesetOffsetTable)

  const reasons = new Set<string>()
  let sw: { selector: Uint8Array; timerBase: number; shift: number } | null = null
  if (!routine.ok) reasons.add(routine.reason)
  else {
    const fault = tableFault('switch selector', routine.selectorTable, TABLE_SPAN.selector)
    const selector = fault ? null : rom.readAt(routine.selectorTable, TABLE_SPAN.selector)
    if (selector) sw = { selector, timerBase: routine.timerBase, shift: routine.shift }
    else
      reasons.add(
        fault ?? `the switch selector table ${formatAddr(routine.selectorTable)} is unreadable`,
      )
  }
  const fits = (at: number): boolean => at >= 0 && at + TILES_PER_TRANSFER * 32 <= buffer.length

  const frames: AnimFrameSlot[][] = []
  for (let frame = 0; frame < ANIM_FRAME_COUNT; frame++) {
    const frameSlots: AnimFrameSlot[] = []
    // TILE_DATA_INDEX_PART = frame << 1 (values 0, 2, 4, 6)
    const tileDataIndexPart = frame << 1

    for (let group = 0; group < TILE_GROUP_COUNT; group++) {
      const baseTileIdx = group * 3
      for (let sub = 0; sub < 3; sub++) {
        const tileIdx = baseTileIdx + sub
        // X = GFX_TILE_IDX * 2 into each of the C/B/A tables (bank_05.asm:4393-4406).
        const vramDest = readVramDest(rom, t.vramDest[sub]!, baseTileIdx * 2)
        if (vramDest === 0) continue

        // LDX / BEQ / DEX / BNE (bank_05.asm:4413-4416): 0 static, 1 switched, any other tileset.
        const behavior = behaviorBuf[tileIdx]!
        const adjustedIdx = behavior >= 2 ? tileIdx + (tilesetOffsetBuf[tilesetId] ?? 0) : tileIdx
        const dataTableIdx = ((adjustedIdx & 0xff) << 3) | tileDataIndexPart
        const bufferOffset = readAnimatedTileDataEntry(rom, t.animatedTileData, dataTableIdx)
        if (!fits(bufferOffset)) continue
        const tiles = decodeTilesAt(buffer, bufferOffset)

        let alt: AnimFrameSlot['alt']
        if (sw && behavior === 1) {
          const timer = sw.timerBase + sw.selector[tileIdx]!
          const kind = SWITCH_RAM[timer]
          const altIdx = (((tileIdx + sw.shift) & 0xff) << 3) | tileDataIndexPart
          const altOffset = readAnimatedTileDataEntry(rom, t.animatedTileData, altIdx)
          if (!kind) reasons.add(`slot ${tileIdx} follows RAM ${ramAddr(timer)}, no known switch`)
          else if (vramDest === 0x0800)
            reasons.add(`switched slot ${tileIdx} writes the $0800 split`)
          else if (!fits(altOffset)) reasons.add(`slot ${tileIdx}'s switched frame is out of range`)
          else alt = { switch: kind, tiles: decodeTilesAt(buffer, altOffset) }
        }
        frameSlots.push(...destSlots(vramDest, tiles, alt, behavior === 1))
      }
    }
    frames.push(frameSlots)
  }

  return {
    ok: true,
    data: {
      frameCount: ANIM_FRAME_COUNT,
      frames,
      intervalMs: ANIM_INTERVAL_MS,
      ...(routine.ok ? {} : { unverified: routine.reason }),
      ...(reasons.size ? { switchUnavailable: [...reasons].join('; ') } : {}),
    },
  }
}

/** Thin wrapper over `loadAnimationDataOrReason` that discards the reason. */
export function loadAnimationData(rom: RomFile, tilesetId: number): AnimationData | null {
  const result = loadAnimationDataOrReason(rom, tilesetId)
  return result.ok ? result.data : null
}

/**
 * The slots one transfer fills. The DMA at CODE_00A3F0 (bank_00.asm ~4649) splits
 * the berry's $0800 transfer: 2 tiles to $0800 and 2 to $0900, a 2x2 in the grid.
 * A switched slot there is refused by the caller, so the split never carries an alternate.
 */
function destSlots(
  vramDest: number,
  tiles: Uint8Array[],
  alt?: AnimFrameSlot['alt'],
  switched = false,
): AnimFrameSlot[] {
  const charBase = vramAddrToChar(vramDest)
  const flag = switched ? { switched: true as const } : {}
  if (vramDest !== 0x0800) return [{ charBase, tiles, ...(alt && { alt }), ...flag }]
  return [
    { charBase, tiles: tiles.slice(0, 2), ...flag },
    { charBase: vramAddrToChar(0x0900), tiles: tiles.slice(2, 4), ...flag },
  ]
}

/** The switches whose state changes any of `chars`, e.g. the chars a Map16 def cites. */
export function switchesForChars(
  animData: AnimationData,
  chars: Iterable<number>,
): Set<SwitchKind> {
  const wanted = new Set(chars)
  const out = new Set<SwitchKind>()
  for (const { alt, charBase, tiles } of animData.frames.flat())
    if (alt && tiles.some((_, i) => wanted.has(charBase + i))) out.add(alt.switch)
  return out
}

/** The pixels a slot loads under the caller's switch state. */
export function slotTiles(slot: AnimFrameSlot, state: SwitchState): Uint8Array[] {
  return slot.alt && state[slot.alt.switch] ? slot.alt.tiles : slot.tiles
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

/** Chars in slots the behavior table marks switched, alternate read or not. */
export function getSwitchedChars(animData: AnimationData): Set<number> {
  const chars = new Set<number>()
  for (const slot of animData.frames.flat())
    if (slot.switched) slot.tiles.forEach((_, i) => chars.add(slot.charBase + i))
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
