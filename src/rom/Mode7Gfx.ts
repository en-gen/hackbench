/**
 * The GFX file the game unpacks into Mode 7 VRAM instead of uploading as
 * bitplanes (vanilla GFX27, "Iggy Platform, Reznor Background" per
 * SMWDisX bank_08-0B.asm:193-194).
 *
 * CODE_00AB42 (SMWDisX bank_00.asm:5515-5567) reads the file three bytes at
 * a time and, through CODE_00ABC4 (:5575-5583), shifts out eight 3-bit
 * fields per group, high bits first, writing each as one Mode 7 pixel byte.
 * No 2/3/4bpp planar decode can show it. Its caller is SetallFGBG80
 * (:5391-5396).
 *
 * The routine's opening (LDY #file / JSL / REP / LDY / LDX / LDA [_0],Y /
 * STA _F) identifies it and names the file: an 18-byte span that hashes to
 * a stock fingerprint, found at every `LDY #imm / JSL` candidate. The whole
 * 118-byte routine, the helper and the call site must then each hash to a
 * stock fingerprint, because those shifts ARE the packing decodeMode7Tiles
 * implements, and the call site must JSR it. When the opening is found and
 * anything after it is not, the file is claimed with no readable packing:
 * the GFX view then reports it unavailable rather than guessing planar.
 * A hack that rewrites the opening itself is not recognized at all.
 */
import { BytePattern, WILD, findPattern } from './BytePattern'
import { LOROM_BANK_SIZE } from './addressing'
import { GFX_FILE_COUNT } from './GfxLoader'
import { PIXELS_PER_TILE } from './GraphicsDecoder'
import { RomFile } from './RomFile'
import { spanFingerprint } from './SubmapFlagGate'

// Candidate opening: LDY #file / JSL. A 3-byte shape locates; the hash decides.
const OPENING_SHAPE: BytePattern = [0xa0, WILD, 0x22]
// LDY #file / JSL / REP #$10 / LDY #0 / LDX #count / LDA [_0],Y / STA _F.
const OPENING_LENGTH = 18
const OPENING_MASK = [1, 3, 4, 5, 12, 13]
const FILE_INDEX_OFF = 1
const LOOP_COUNT_OFF = 12

/**
 * The stock bytes of the three pieces are kept as SHA-256 fingerprints, not
 * literals (docs/testing.md "Legal position"; spanFingerprint as in
 * SubmapFlagGate). Each span hashes with its operand bytes zeroed: the file
 * index, JSL target and loop count in the unpack routine, its six JSR
 * operands, and the call site's JSR and STA targets. Those are read from the
 * cart, so a relocated or retargeted copy still matches.
 */
export interface Mode7Fingerprints {
  opening: readonly string[]
  unpack: readonly string[]
  helper: readonly string[]
  call: readonly string[]
}

// CODE_00AB42 up to its BPL (SMWDisX bank_00.asm:5515-5567): 118 bytes, six JSR CODE_00ABC4.
const UNPACK_LENGTH = 118
const JSR_OPERAND_OFFS = [19, 27, 59, 67, 99, 107]
const UNPACK_MASK = [1, 3, 4, 5, 12, 13, ...JSR_OPERAND_OFFS.flatMap(o => [o, o + 1])]
// CODE_00ABC4 (:5575-5583): 15 bytes, no operand.
const HELPER_LENGTH = 15
// SetallFGBG80 (:5391-5396): a BEQ over the JSR, then the LDX/LDA/STA abs,X it skips to.
const CALL_LENGTH = 12
const CALL_OPERAND_OFF = 3
const CALL_MASK = [3, 4, 10, 11]
// All that is assumed of a call site before it is hashed: a branch over a JSR.
const CALL_SHAPE: BytePattern = [0xf0, WILD, 0x20]

export const STOCK_MODE7_FINGERPRINTS: Mode7Fingerprints = {
  opening: ['9817301df4e9f49d116ddee620f615cb8e3b8e003a9d61d873d2b989561eac6d'],
  unpack: ['ea7f55d3066be1875355145f2428603285a991cb15675279eba4315b28baa8b9'],
  helper: ['042c561290ac0e92dabd1142750ad86ae7537027386082ae1a87c9aa3e3da4c8'],
  call: ['f8d61eb7a93fcc71ad761e61310e38816388f89289f376d430203ad9a39a2db0'],
}

const BYTES_PER_GROUP = 3
const PIXELS_PER_GROUP = 8
const BITS_PER_PIXEL = 3 // the helper's three ROL pairs, pinned by the helper fingerprint
export const BYTES_PER_MODE7_TILE = (PIXELS_PER_TILE / PIXELS_PER_GROUP) * BYTES_PER_GROUP // 24

export interface Mode7GfxFile {
  fileIndex: number
  /** Bytes the unpack loop consumes, or null when the routine names this
   *  file but its packing, helper or call site could not be read. */
  byteLength: number | null
  /** Plain-words cause when `byteLength` is null. */
  reason?: string
}

type Cached = { version: number; result: Mode7GfxFile[] }
// Per ROM, then per fingerprint set, so an injected set and the default both
// re-read after a write; keyed on version, as GfxLoader's _creditsCache.
const _cache = new WeakMap<RomFile, Map<Mode7Fingerprints, Cached>>()

let defaultFingerprints: Mode7Fingerprints = STOCK_MODE7_FINGERPRINTS

/**
 * Test seam: the set `findMode7GfxFiles` uses when none is passed, so a
 * caller that cannot pass one (gfx-decode) can be driven on a synthetic ROM.
 * Pass null to restore the stock set. Not for production code.
 */
export function overrideDefaultMode7Fingerprints(fps: Mode7Fingerprints | null): void {
  defaultFingerprints = fps ?? STOCK_MODE7_FINGERPRINTS
}

/**
 * Every file a Mode 7 unpack routine names; empty when there is none.
 *
 * @param fingerprints Replaces the stock ones; for a synthetic ROM.
 */
export function findMode7GfxFiles(
  rom: RomFile,
  fingerprints: Mode7Fingerprints = defaultFingerprints,
): Mode7GfxFile[] {
  let perRom = _cache.get(rom)
  if (!perRom) _cache.set(rom, (perRom = new Map()))
  const cached = perRom.get(fingerprints)
  if (cached && cached.version === rom.version) return cached.result
  const result = _findMode7GfxFiles(rom, fingerprints)
  perRom.set(fingerprints, { version: rom.version, result })
  return result
}

/** Cart offset a same-bank JSR from `from` lands on, LoROM only. */
function jsrTarget(from: number, operand: number): number | null {
  if (operand < LOROM_BANK_SIZE) return null
  return from - (from % LOROM_BANK_SIZE) + (operand - LOROM_BANK_SIZE)
}

function _findMode7GfxFiles(rom: RomFile, fps: Mode7Fingerprints): Mode7GfxFile[] {
  const hits = findPattern(rom, OPENING_SHAPE).filter(at =>
    isStock(rom, at, OPENING_LENGTH, OPENING_MASK, fps.opening),
  )
  const files: Mode7GfxFile[] = []
  for (const at of hits) {
    const fileIndex = rom.readAtFileOffset(at + FILE_INDEX_OFF, 1)![0]!
    if (fileIndex >= GFX_FILE_COUNT) continue
    // More than one opening: which one runs cannot be said, so none is read.
    files.push({
      fileIndex,
      ...(hits.length === 1
        ? readByteLength(rom, at, fps)
        : unreadable('The ROM holds more than one Mode 7 unpack routine')),
    })
  }
  return files
}

type Length = { byteLength: number } | { byteLength: null; reason: string }
const unreadable = (why: string): Length => ({
  byteLength: null,
  reason: `${why}, so its Mode 7 graphics cannot be unpacked`,
})

function isStock(
  rom: RomFile,
  at: number,
  length: number,
  mask: readonly number[],
  stock: readonly string[],
): Buffer | null {
  const bytes = rom.readAtFileOffset(at, length)
  const fp = spanFingerprint(bytes, mask)
  return fp !== null && stock.includes(fp) ? bytes : null
}

function readByteLength(rom: RomFile, at: number, fps: Mode7Fingerprints): Length {
  // Bank arithmetic below is LoROM's.
  if (rom.mapMode === 'hirom') return unreadable('The ROM is HiROM')
  const site = isStock(rom, at, UNPACK_LENGTH, UNPACK_MASK, fps.unpack)
  if (!site) return unreadable('The unpack routine is not a recognized build of the stock code')
  const read16 = (off: number): number => site[off]! | (site[off + 1]! << 8)

  const helperOperand = read16(JSR_OPERAND_OFFS[0]!)
  if (JSR_OPERAND_OFFS.some(off => read16(off) !== helperOperand)) {
    return unreadable('The unpack routine calls more than one helper')
  }
  const helperAt = jsrTarget(at, helperOperand)
  if (helperAt === null || !isStock(rom, helperAt, HELPER_LENGTH, [], fps.helper)) {
    return unreadable('The bit-shifting helper is not a recognized build of the stock code')
  }

  // Candidates are hashed, not pattern-matched. Exactly one stock call site
  // may exist, and it must call this routine.
  const callers: number[] = []
  for (const c of findPattern(rom, CALL_SHAPE)) {
    if (isStock(rom, c, CALL_LENGTH, CALL_MASK, fps.call)) callers.push(c)
    if (callers.length > 1) break
  }
  if (callers.length !== 1) {
    return unreadable('The call to the unpack routine is not found exactly once in stock form')
  }
  const call = rom.readAtFileOffset(callers[0]! + CALL_OPERAND_OFF, 2)!
  if (jsrTarget(callers[0]!, call[0]! | (call[1]! << 8)) !== at) {
    return unreadable('The stock call site jumps somewhere other than the unpack routine')
  }

  // 16-bit LDX / DEX / BPL: an operand with bit 15 set runs the body once.
  const count = read16(LOOP_COUNT_OFF)
  return { byteLength: (count & 0x8000 ? 1 : count + 1) * BYTES_PER_GROUP }
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
