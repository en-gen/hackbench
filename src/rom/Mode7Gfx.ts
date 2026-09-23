/**
 * The GFX file the game unpacks into Mode 7 VRAM instead of uploading as
 * bitplanes (vanilla GFX27, "Iggy Platform, Reznor Background" per
 * SMWDisX bank_08-0B.asm:193-194).
 *
 * CODE_00AB42 (SMWDisX bank_00.asm:5515-5573) reads the file three bytes at
 * a time and, through CODE_00ABC4 (:5575-5583), shifts out eight 3-bit
 * fields per group, high bits first, writing each as one Mode 7 pixel byte.
 * No 2/3/4bpp planar decode can show it. Its caller is SetallFGBG80
 * (:5391-5393).
 *
 * The routine's opening (LDY #file / JSL / REP / LDY / LDX / LDA [_0],Y /
 * STA _F) identifies it and names the file. Everything after must then be
 * matched whole, because those shifts ARE the packing decodeMode7Tiles
 * implements, and the call site must JSR it. When the opening is found and
 * anything after it is not, the file is claimed with no readable packing:
 * the GFX view then reports it unavailable rather than guessing planar.
 * A hack that rewrites the opening itself is not recognised at all.
 */
import { BytePattern, WILD, findPattern } from './BytePattern'
import { LOROM_BANK_SIZE } from './addressing'
import { GFX_FILE_COUNT } from './GfxLoader'
import { PIXELS_PER_TILE } from './GraphicsDecoder'
import { RomFile } from './RomFile'

const pattern = (s: string): BytePattern =>
  s
    .trim()
    .split(/\s+/)
    .map(b => (b === '??' ? WILD : parseInt(b, 16)))

const OPENING_PATTERN = pattern('a0 ?? 22 ?? ?? ?? c2 10 a0 00 00 a2 ?? ?? b7 00 85 0f')

// The rest of CODE_00AB42 up to its BPL, with its six JSR CODE_00ABC4.
const UNPACK_PATTERN = [
  ...OPENING_PATTERN,
  ...pattern(`
  20 ?? ?? a5 04 8d 19 21 20 ?? ?? a5 04 8d 19 21 64 04 26 0f 26 04 26 0f 26 04 c8
  b7 00 85 0f 26 0f 26 04 a5 04 8d 19 21 20 ?? ?? a5 04 8d 19 21 20 ?? ?? a5 04 8d 19 21
  64 04 26 0f 26 04 c8 b7 00 85 0f 26 0f 26 04 26 0f 26 04 a5 04 8d 19 21
  20 ?? ?? a5 04 8d 19 21 20 ?? ?? a5 04 8d 19 21 c8 ca 10 98`),
]
const FILE_INDEX_OFF = 1
const LOOP_COUNT_OFF = 12
const JSR_OPERAND_OFFS = UNPACK_PATTERN.flatMap((b, i) =>
  b === 0x20 && UNPACK_PATTERN[i + 1] === WILD ? [i + 1] : [],
)

// CODE_00ABC4: STZ _4, then three ROL _F / ROL _4 pairs, RTS.
const HELPER_PATTERN = pattern('64 04 26 0f 26 04 26 0f 26 04 26 0f 26 04 60')

// SetallFGBG80: BEQ + / JSR CODE_00AB42 / + LDX #$03 / LDA #$80 / STA abs,X
const CALL_SITE_PATTERN = pattern('f0 03 20 ?? ?? a2 03 a9 80 9d ?? ??')
const CALL_OPERAND_OFF = 3

const BYTES_PER_GROUP = 3
const PIXELS_PER_GROUP = 8
const BITS_PER_PIXEL = 3 // the helper's three ROL pairs, pinned by HELPER_PATTERN
export const BYTES_PER_MODE7_TILE = (PIXELS_PER_TILE / PIXELS_PER_GROUP) * BYTES_PER_GROUP // 24

export interface Mode7GfxFile {
  fileIndex: number
  /** Bytes the unpack loop consumes, or null when the routine names this
   *  file but its packing, helper or call site could not be read. */
  byteLength: number | null
}

const _cache = new WeakMap<RomFile, { version: number; result: Mode7GfxFile[] }>()

/** Every file a Mode 7 unpack routine names; empty when there is none. */
export function findMode7GfxFiles(rom: RomFile): Mode7GfxFile[] {
  const cached = _cache.get(rom) // keyed on version, as GfxLoader's _creditsCache
  if (cached && cached.version === rom.version) return cached.result
  const result = _findMode7GfxFiles(rom)
  _cache.set(rom, { version: rom.version, result })
  return result
}

/** Cart offset a same-bank JSR from `from` lands on, LoROM only. */
function jsrTarget(from: number, operand: number): number | null {
  if (operand < LOROM_BANK_SIZE) return null
  return from - (from % LOROM_BANK_SIZE) + (operand - LOROM_BANK_SIZE)
}

function matchesAt(rom: RomFile, at: number, p: BytePattern): Buffer | null {
  const bytes = rom.readAtFileOffset(at, p.length)
  return bytes && p.every((b, i) => b === WILD || bytes[i] === b) ? bytes : null
}

function _findMode7GfxFiles(rom: RomFile): Mode7GfxFile[] {
  const hits = findPattern(rom, OPENING_PATTERN)
  const files: Mode7GfxFile[] = []
  for (const at of hits) {
    const fileIndex = rom.readAtFileOffset(at + FILE_INDEX_OFF, 1)![0]!
    if (fileIndex >= GFX_FILE_COUNT) continue
    // More than one opening: which one runs cannot be said, so none is read.
    files.push({ fileIndex, byteLength: hits.length === 1 ? readByteLength(rom, at) : null })
  }
  return files
}

function readByteLength(rom: RomFile, at: number): number | null {
  // Bank arithmetic below is LoROM's.
  if (rom.mapMode === 'hirom') return null
  const site = matchesAt(rom, at, UNPACK_PATTERN)
  if (!site) return null
  const read16 = (off: number): number => site[off]! | (site[off + 1]! << 8)

  const helperOperand = read16(JSR_OPERAND_OFFS[0]!)
  if (JSR_OPERAND_OFFS.some(off => read16(off) !== helperOperand)) return null
  const helperAt = jsrTarget(at, helperOperand)
  if (helperAt === null || !matchesAt(rom, helperAt, HELPER_PATTERN)) return null

  const callers = findPattern(rom, CALL_SITE_PATTERN, 2)
  if (callers.length !== 1) return null
  const call = rom.readAtFileOffset(callers[0]! + CALL_OPERAND_OFF, 2)!
  if (jsrTarget(callers[0]!, call[0]! | (call[1]! << 8)) !== at) return null

  // 16-bit LDX / DEX / BPL: an operand with bit 15 set runs the body once.
  const count = read16(LOOP_COUNT_OFF)
  return (count & 0x8000 ? 1 : count + 1) * BYTES_PER_GROUP
}

/** Unpack Mode 7 GFX bytes into 8x8 tiles of 64 row-major pixels (0-7). */
export function decodeMode7Tiles(data: ArrayLike<number>): Uint8Array[] {
  const count = Math.floor(data.length / BYTES_PER_MODE7_TILE)
  const mask = (1 << BITS_PER_PIXEL) - 1
  return Array.from({ length: count }, (_, t) => {
    const px = new Uint8Array(PIXELS_PER_TILE)
    const base = t * BYTES_PER_MODE7_TILE
    for (let g = 0; g < PIXELS_PER_TILE / PIXELS_PER_GROUP; g++) {
      const o = base + g * BYTES_PER_GROUP
      const bits = (data[o]! << 16) | (data[o + 1]! << 8) | data[o + 2]!
      for (let k = 0; k < PIXELS_PER_GROUP; k++) {
        px[g * PIXELS_PER_GROUP + k] =
          (bits >> ((PIXELS_PER_GROUP - 1 - k) * BITS_PER_PIXEL)) & mask
      }
    }
    return px
  })
}
