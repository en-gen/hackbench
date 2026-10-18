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
 * The routine is found by ONE SHA-256 fingerprint over its whole 118 bytes
 * (100 of them unmasked), checked at every `LDY #imm / JSL` candidate; the
 * file index and loop count are then read from its own operands. Nothing
 * shorter is hashed: a span under 24 unknown bytes is too easy to guess.
 * The helper is not hashed; it is RUN on the 65816 core and must shift the
 * routine's input byte left three bits into its output byte, for every
 * input byte. The call site is checked by structure: exactly one
 * branch-over-JSR in the routine's bank whose JSR lands on the routine.
 * When the routine is found and the helper or call is not, the file is
 * claimed with no readable packing: the GFX view then reports it
 * unavailable rather than guessing planar. A hack that edits the routine
 * itself is not recognized at all.
 */
import { BytePattern, WILD, findPattern } from './BytePattern'
import { LOROM_BANK_SIZE } from './addressing'
import { Refusal, callSubroutine } from './cpu/call'
import { GFX_FILE_COUNT } from './GfxLoader'
import { PIXELS_PER_TILE } from './GraphicsDecoder'
import { RomFile } from './RomFile'
import { smwMachine } from './sprites/interp/Machine'
import { spanFingerprint } from './SubmapFlagGate'

// Candidate routine start: LDY #file / JSL. A 3-byte shape locates; the hash decides.
const CANDIDATE_SHAPE: BytePattern = [0xa0, WILD, 0x22]
const FILE_INDEX_OFF = 1
const LOOP_COUNT_OFF = 12

/**
 * The stock bytes of the routine are kept as a SHA-256 fingerprint, not as a
 * literal (docs/testing.md "Legal position"; spanFingerprint as in
 * SubmapFlagGate). The span hashes with its operand bytes zeroed: the file
 * index, JSL target and loop count, and the six JSR operands. Those are read
 * from the cart, so a relocated or retargeted copy still matches.
 */
export interface Mode7Fingerprints {
  unpack: readonly string[]
}

// CODE_00AB42 up to its BPL (SMWDisX bank_00.asm:5515-5567): 118 bytes, six JSR CODE_00ABC4.
const UNPACK_LENGTH = 118
const JSR_OPERAND_OFFS = [19, 27, 59, 67, 99, 107]
const UNPACK_MASK = [1, 3, 4, 5, 12, 13, ...JSR_OPERAND_OFFS.flatMap(o => [o, o + 1])]
// The routine's input byte is the operand of its first STA direct, its output
// byte the operand of the LDA direct after the first helper call (:5515-5583).
const INPUT_STA_OFF = 16
const OUTPUT_LDA_OFF = 21
const STA_DIRECT = 0x85
const LDA_DIRECT = 0xa5
// The helper is run, not hashed; its budget is far above its length.
const HELPER_MAX_STEPS = 64
// SetallFGBG80 (:5391-5396): a BEQ over the JSR that calls the routine.
const JSR_LENGTH = 3
const BEQ = 0xf0
const JSR = 0x20

export const STOCK_MODE7_FINGERPRINTS: Mode7Fingerprints = {
  unpack: ['ea7f55d3066be1875355145f2428603285a991cb15675279eba4315b28baa8b9'],
}

const BYTES_PER_GROUP = 3
const PIXELS_PER_GROUP = 8
const BITS_PER_PIXEL = 3 // pinned by running the helper (helperShiftsPixelOut)
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

// callSubroutine's return frame and any push sit in the stack page.
const isStack = (off: number): boolean => off >= 0x100 && off < 0x200

/** SNES address of a LoROM cart offset (header already stripped). */
const loromAddress = (off: number): number =>
  ((off >> 15) << 16) | LOROM_BANK_SIZE | (off % LOROM_BANK_SIZE)

function _findMode7GfxFiles(rom: RomFile, fps: Mode7Fingerprints): Mode7GfxFile[] {
  const hits = findPattern(rom, CANDIDATE_SHAPE).filter(at => isStockUnpack(rom, at, fps))
  const files: Mode7GfxFile[] = []
  for (const at of hits) {
    const fileIndex = rom.readAtFileOffset(at + FILE_INDEX_OFF, 1)![0]!
    if (fileIndex >= GFX_FILE_COUNT) continue
    // More than one routine: which one runs cannot be said, so none is read.
    files.push({
      fileIndex,
      ...(hits.length === 1
        ? readByteLength(rom, at)
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

function isStockUnpack(rom: RomFile, at: number, fps: Mode7Fingerprints): boolean {
  const fp = spanFingerprint(rom.readAtFileOffset(at, UNPACK_LENGTH), UNPACK_MASK)
  return fp !== null && fps.unpack.includes(fp)
}

/**
 * Runs the helper on the 65816 core for every input byte: it must return,
 * write only the input and output bytes (and the stack), leave the input shifted left by
 * BITS_PER_PIXEL and put the bits shifted out in the output. That is the
 * packing decodeMode7Tiles implements, read from behaviour not from bytes.
 */
function helperShiftsPixelOut(
  rom: RomFile,
  helperAt: number,
  input: number,
  output: number,
): boolean {
  try {
    const { bus, cpu } = smwMachine(rom)
    const touched = new Set<number>()
    bus.onWramWrite = off => touched.add(off)
    for (let v = 0; v < 0x100; v++) {
      touched.clear()
      bus.wram[input] = v
      bus.wram[output] = 0xff
      const r = callSubroutine(cpu, loromAddress(helperAt), {
        kind: 'jsr',
        maxSteps: HELPER_MAX_STEPS,
      })
      const onlyTwo = [...touched].every(off => off === input || off === output || isStack(off))
      const shifted = bus.wram[input] === (v << BITS_PER_PIXEL) % 0x100
      const out = bus.wram[output] === v >> (8 - BITS_PER_PIXEL)
      if (r.kind !== 'returned' || !onlyTwo || !shifted || !out) return false
    }
    return true
  } catch (e) {
    if (e instanceof Refusal) return false
    throw e
  }
}

function readByteLength(rom: RomFile, at: number): Length {
  // Bank arithmetic below is LoROM's.
  if (rom.mapMode === 'hirom') return unreadable('The ROM is HiROM')
  const site = rom.readAtFileOffset(at, UNPACK_LENGTH)!
  const read16 = (off: number): number => site[off]! | (site[off + 1]! << 8)

  const helperOperand = read16(JSR_OPERAND_OFFS[0]!)
  if (JSR_OPERAND_OFFS.some(off => read16(off) !== helperOperand)) {
    return unreadable('The unpack routine calls more than one helper')
  }
  const helperAt = jsrTarget(at, helperOperand)
  if (
    helperAt === null ||
    site[INPUT_STA_OFF] !== STA_DIRECT ||
    site[OUTPUT_LDA_OFF] !== LDA_DIRECT ||
    !helperShiftsPixelOut(rom, helperAt, site[INPUT_STA_OFF + 1]!, site[OUTPUT_LDA_OFF + 1]!)
  ) {
    return unreadable('The bit-shifting helper does not unpack three-bit pixels as expected')
  }

  // Exactly one branch-over-JSR in the routine's bank may call it.
  const operand = LOROM_BANK_SIZE + (at % LOROM_BANK_SIZE)
  const bank = Math.floor(at / LOROM_BANK_SIZE)
  const call: BytePattern = [BEQ, JSR_LENGTH, JSR, operand & 0xff, operand >> 8]
  const callers = findPattern(rom, call).filter(c => Math.floor(c / LOROM_BANK_SIZE) === bank)
  if (callers.length !== 1) {
    return unreadable('The call to the unpack routine is not found exactly once in stock form')
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
