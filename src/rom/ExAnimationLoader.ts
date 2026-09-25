/**
 * ExAnimationLoader.ts - Lunar Magic ExAnimation data loader.
 *
 * ExAnimation is LM's extension to SMW's vanilla animation system.
 * It adds per-level animated tile overrides driven by ExGFX files.
 *
 * Data layout (bank $0F LM free space, $FF in vanilla):
 *   $0FF7FF - 3-byte ptr → per-level ExGFX file list
 *             (16 × 2-byte file nums per level, 32 bytes/level)
 *   $0FF600 - ExGFX pointer table, files $80–$FF (3 bytes per entry)
 *   $0FF937 - ExGFX pointer table, files $100+  (3 bytes per entry)
 *   $0583AE - 3-byte ptr → per-level ExAnim block pointer table
 *             (3 bytes per level; ptr[1]==0 means no data)
 *
 * ── Block format at per-level block address ───────────────────────────────
 *
 *   SS EE CCcc IIii MMmm [FF×popcount(MMmm)] [DDdd×SS] [slots...]
 *
 *   SS       (1) - slot count (highest used slot + 1)
 *   EE       (1) - ExGFX source slot, 0–15, indexes per-level ExGFX list
 *   CCcc     (2) - custom trigger uninit bitflags
 *   IIii     (2) - custom trigger initial states
 *   MMmm     (2) - manual trigger init bits
 *   FF×…     (variable) - frame numbers, one per set bit in MMmm
 *   DDdd×SS  (variable) - 2-byte offsets from DDdd array start to slot data
 *
 * ── Slot format ───────────────────────────────────────────────────────────
 *
 *   AA TT FF DDdd [MMmm×frameCount]
 *
 *   AA       (1) - type: bit 7=1 is palette (skip), bit 7=0 is GFX
 *   TT       (1) - trigger
 *   FF       (1) - frame count − 1
 *   DDdd     (2) - bit 15=1 uses alt ExGFX; bits 14:0 = VRAM word addr
 *   MMmm×N   (N×2) - per-frame source RAM address ($7E:xxxx, 16-bit LE)
 *                     buffer offset = ramAddr − $AD00
 *
 * References: Lunar Magic source docs, SMWDisX bank_05.asm
 */

import type { AnimationData, AnimFrameSlot } from './AnimationLoader'
import { ANIM_INTERVAL_MS } from './AnimationLoader'
import { tryDecompress } from './LcLz2'
import { decode4bpp, PIXELS_PER_TILE } from './GraphicsDecoder'
import type { RomFile } from './RomFile'

// ── ROM constants ─────────────────────────────────────────────────────────────

/** Animation settings table: 1 byte per level, patched by LM. */
const ANIM_SETTINGS_TABLE = 0x03fe00
/** Bit set in the settings byte when level ExAnim is disabled (bit 5). */
const ANIM_SETTINGS_DISABLE_LEVEL_EXANIM = 0x20

/** 3-byte LE ptr to per-level ExAnim block table (3 bytes per level). */
const EXANIM_LEVEL_TABLE_PTR = 0x0583ae

/** ExGFX pointer table for file numbers $80–$FF (3 bytes per entry). */
const EXGFX_LO_TABLE_ADDR = 0x0ff600
/** ExGFX pointer table for file numbers $100+ (3 bytes per entry). */
const EXGFX_HI_TABLE_ADDR = 0x0ff937
/** 3-byte LE ptr to the per-level ExGFX file list. */
const EXGFX_LEVEL_LIST_PTR = 0x0ff7ff
/** Bytes per level in the per-level ExGFX file list (16 × 2-byte entries). */
const EXGFX_BYTES_PER_LEVEL = 32

/** First RAM address of the ExAnim GFX buffer ($7E:AD00). */
const EXANIM_BUFFER_RAM_BASE = 0xad00
/** Tiles per DMA transfer (ExAnim always writes 4 consecutive tiles). */
const EXANIM_TILES_PER_SLOT = 4
/** Bit 7 of the slot AA byte: set means palette animation (skip). */
const EXANIM_TYPE_PALETTE_BIT = 0x80

const EXGFX_MAX_COMPRESSED = 0x10000

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Whether the $00A2A5 JSL reaches a handler that reads the tables below. None
 * is known: the corpus handler reads only $7F:C0xx, and $0583AE and $0FF7FF
 * are operands of LM code, not table pointers, so this reports not installed (#491).
 */
export function isLmExAnimInstalled(_rom: RomFile): boolean {
  return false
}

/**
 * Load ExAnimation data for one level.
 *
 * Returns null when:
 *   - LM ExAnimation is not installed (vanilla ROM)
 *   - This level has no ExAnimation block
 *   - The ExGFX source file cannot be loaded
 *   - The animation settings byte disables level ExAnim for this level
 *
 * The returned `AnimationData` has `frameCount` = max of all slot frame
 * counts; shorter slots are tiled to fill the full cycle so no char frame
 * arrays have holes when processed by `collectAnimFrames`.
 */
export function loadExAnimData(rom: RomFile, levelIndex: number): AnimationData | null {
  return isLmExAnimInstalled(rom) ? readExAnimLevel(rom, levelIndex) : null
}

/** loadExAnimData without the install check. #528 decides whether it is deleted or re-anchored. */
export function readExAnimLevel(rom: RomFile, levelIndex: number): AnimationData | null {
  const settings = rom.readByte(ANIM_SETTINGS_TABLE + levelIndex)
  if (settings !== null && settings & ANIM_SETTINGS_DISABLE_LEVEL_EXANIM) return null

  const levelTableBase = read3(rom, EXANIM_LEVEL_TABLE_PTR)
  if (levelTableBase === null) return null

  const blockPtrBuf = rom.readAt(levelTableBase + levelIndex * 3, 3)
  if (!blockPtrBuf) return null
  if (blockPtrBuf[1] === 0) return null // second byte 0 → no ExAnim for level
  const blockAddr = blockPtrBuf[0] | (blockPtrBuf[1] << 8) | (blockPtrBuf[2] << 16)
  if (blockAddr === 0xffffff || blockAddr === 0) return null

  // Read block fixed header to get EE (ExGFX source slot index)
  const blockFixed = rom.readAt(blockAddr, 2)
  if (!blockFixed) return null
  const eeSlot = blockFixed[1]

  const fileNum = getExAnimSourceFileNum(rom, levelIndex, eeSlot)
  if (fileNum === null) return null

  const exGfxBuffer = loadExGfxFile(rom, fileNum)
  if (!exGfxBuffer) return null

  const parsedSlots = parseExAnimBlock(rom, blockAddr, exGfxBuffer)
  if (parsedSlots.length === 0) return null

  const maxFrameCount = parsedSlots.reduce((m, s) => Math.max(m, s.tilesPerFrame.length), 0)
  if (maxFrameCount === 0) return null

  // Build frame-major AnimationData; tile short slots to maxFrameCount
  const frames: AnimFrameSlot[][] = Array.from({ length: maxFrameCount }, () => [])
  for (const slot of parsedSlots) {
    const n = slot.tilesPerFrame.length
    for (let f = 0; f < maxFrameCount; f++) {
      frames[f].push({ charBase: slot.charBase, tiles: slot.tilesPerFrame[f % n] })
    }
  }

  return { frameCount: maxFrameCount, frames, intervalMs: ANIM_INTERVAL_MS }
}

/**
 * Merge two AnimationData objects.
 * Frames from `b` override `a` for the same charBase (ExAnim overrides vanilla).
 * The merged frameCount is the LCM of both; both sources tile to fill it.
 */
export function mergeAnimationData(a: AnimationData, b: AnimationData): AnimationData {
  const count = lcm(a.frameCount, b.frameCount)
  const frames: AnimFrameSlot[][] = []
  for (let f = 0; f < count; f++) {
    // Vanilla slots first so ExAnim slots (b) overwrite them in collectAnimFrames
    frames.push([...a.frames[f % a.frameCount], ...b.frames[f % b.frameCount]])
  }
  return { frameCount: count, frames, intervalMs: Math.min(a.intervalMs, b.intervalMs) }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface ParsedSlot {
  charBase: number
  tilesPerFrame: Uint8Array[][] // [frameIdx][tileOffset 0..TILES_PER_SLOT-1]
}

/** Read a 3-byte LE SNES address; null if unreadable or all-$FF. */
function read3(rom: RomFile, addr: number): number | null {
  const buf = rom.readAt(addr, 3)
  if (!buf) return null
  if (buf[0] === 0xff && buf[1] === 0xff && buf[2] === 0xff) return null
  return buf[0] | (buf[1] << 8) | (buf[2] << 16)
}

/** Count set bits in a 16-bit integer. */
function popcount16(n: number): number {
  let c = 0
  n = n & 0xffff
  while (n) {
    c += n & 1
    n >>>= 1
  }
  return c
}

function gcd(a: number, b: number): number {
  while (b) {
    const t = b
    b = a % b
    a = t
  }
  return a
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b
}

/**
 * Get the ExGFX file number for the given level's EE slot.
 * Returns null if the slot is unset ($0000 / $FFFF) or the list pointer is absent.
 */
function getExAnimSourceFileNum(rom: RomFile, levelIndex: number, eeSlot: number): number | null {
  const listBase = read3(rom, EXGFX_LEVEL_LIST_PTR)
  if (listBase === null) return null

  const entryAddr = listBase + levelIndex * EXGFX_BYTES_PER_LEVEL + eeSlot * 2
  const buf = rom.readAt(entryAddr, 2)
  if (!buf) return null

  const fileNum = buf[0] | (buf[1] << 8)
  if (fileNum === 0xffff || fileNum === 0) return null
  return fileNum
}

/**
 * Load an ExGFX file from LM's pointer tables and decompress it.
 * Returns raw 4bpp bytes (32 bytes/tile) or null if missing.
 */
function loadExGfxFile(rom: RomFile, fileNum: number): Uint8Array | null {
  let tableAddr: number
  let offset: number

  if (fileNum >= 0x100) {
    tableAddr = EXGFX_HI_TABLE_ADDR
    offset = (fileNum - 0x100) * 3
  } else if (fileNum >= 0x80) {
    tableAddr = EXGFX_LO_TABLE_ADDR
    offset = (fileNum - 0x80) * 3
  } else {
    return null
  }

  const addr = read3(rom, tableAddr + offset)
  if (addr === null || addr === 0) return null

  const compressed = rom.readAt(addr, EXGFX_MAX_COMPRESSED)
  if (!compressed) return null
  const result = tryDecompress(compressed)
  return result.ok && result.bytes.length > 0 ? result.bytes : null
}

/**
 * Decode EXANIM_TILES_PER_SLOT consecutive 4bpp tiles from the buffer.
 * bufferOffset is the byte offset into the raw 4bpp ExGFX buffer.
 */
function decodeTilesAt(buffer: Uint8Array, bufferOffset: number): Uint8Array[] {
  const tiles: Uint8Array[] = []
  for (let t = 0; t < EXANIM_TILES_PER_SLOT; t++) {
    const off = bufferOffset + t * 32
    if (off + 32 > buffer.length) {
      tiles.push(new Uint8Array(PIXELS_PER_TILE))
      continue
    }
    tiles.push(decode4bpp(buffer, off))
  }
  return tiles
}

/**
 * Parse one ExAnimation slot at slotAddr in ROM.
 * Returns null for palette-type slots (AA bit 7 set) or unreadable data.
 */
function parseExAnimSlot(
  rom: RomFile,
  slotAddr: number,
  exGfxBuffer: Uint8Array,
): ParsedSlot | null {
  const header = rom.readAt(slotAddr, 5)
  if (!header) return null

  if (header[0] & EXANIM_TYPE_PALETTE_BIT) return null // skip palette slots

  const frameCount = (header[2] & 0xff) + 1
  const dddd = header[3] | (header[4] << 8)
  const vramWordAddr = dddd & 0x7fff
  const charBase = vramWordAddr >> 4 // 16 VRAM words per 4bpp tile

  const frameAddrs = rom.readAt(slotAddr + 5, frameCount * 2)
  if (!frameAddrs) return null

  const tilesPerFrame: Uint8Array[][] = []
  for (let f = 0; f < frameCount; f++) {
    const ramAddr = frameAddrs[f * 2] | (frameAddrs[f * 2 + 1] << 8)
    const bufferOffset = ramAddr - EXANIM_BUFFER_RAM_BASE
    if (bufferOffset < 0) {
      tilesPerFrame.push(
        Array.from({ length: EXANIM_TILES_PER_SLOT }, () => new Uint8Array(PIXELS_PER_TILE)),
      )
      continue
    }
    tilesPerFrame.push(decodeTilesAt(exGfxBuffer, bufferOffset))
  }

  return { charBase, tilesPerFrame }
}

/**
 * Parse the full ExAnimation block at blockAddr and return all GFX slots.
 */
function parseExAnimBlock(rom: RomFile, blockAddr: number, exGfxBuffer: Uint8Array): ParsedSlot[] {
  // Fixed header: SS EE CCcc IIii MMmm (8 bytes)
  const fixed = rom.readAt(blockAddr, 8)
  if (!fixed) return []

  const slotCount = fixed[0]
  if (slotCount === 0 || slotCount > 64) return []

  const mmmm = fixed[6] | (fixed[7] << 8)
  const manualFrameBytes = popcount16(mmmm)

  // After fixed header + manual frame bytes: DDdd array (slotCount × 2 bytes)
  const ddddArrayStart = blockAddr + 8 + manualFrameBytes
  const offsetTable = rom.readAt(ddddArrayStart, slotCount * 2)
  if (!offsetTable) return []

  const slots: ParsedSlot[] = []
  for (let i = 0; i < slotCount; i++) {
    const relOffset = offsetTable[i * 2] | (offsetTable[i * 2 + 1] << 8)
    const slotAddr = ddddArrayStart + relOffset
    const slot = parseExAnimSlot(rom, slotAddr, exGfxBuffer)
    if (slot) slots.push(slot)
  }
  return slots
}
