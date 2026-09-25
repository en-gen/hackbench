/**
 * A cartridge with a GFX arena on it, built from nothing.
 *
 * **No bytes here come from any Super Mario World ROM or derived resource.**
 * The instruction sequence is written from the 65816 encoding so the arena
 * code has a `PrepareGraphicsFile` to resolve; the graphics are arithmetic.
 * That is what lets the GFX editor's gates and refusals be tested in CI,
 * where the corpus is absent by design.
 */
import { RomFile } from '../../../src/rom/RomFile'
import { encode } from '../../../src/rom/LcLz2'
import { COPIER_HEADER_SIZE, LOROM_BANK_SIZE, loromFromOffset } from '../../../src/rom/addressing'
import { WILD } from '../../../src/rom/BytePattern'
import {
  computeHookFingerprint,
  GFX_FILE_COUNT,
  LEVEL_GFX_CALLERS,
  PREPARE_GFX_PATTERN,
  STOCK_LCLZ2_ENTRY,
} from '../../../src/rom/GfxArena'

export const CART_SIZE = 0x18000 // three LoROM banks: tables, routine, arena
export const TABLE_LO = 0xb992
export const TABLE_HI = 0xb9c4
export const TABLE_BANK = 0xb9f6
export const DECOMP_ENTRY = 0xb8de
export const ROUTINE_AT = 0x3a46 // bank 0, clear of both tables
export const ARENA_AT = 0x10000

/** JSL to `target`, 4 bytes, the encoding a hijacked call site overwrites. */
export function jsl(target: number): number[] {
  return [0x22, target & 0xff, (target >> 8) & 0xff, (target >> 16) & 0xff]
}

/**
 * The recognized ExGFX hook (src/rom/GfxArena.ts HOOK_RANGE_*), as a
 * synthetic signature: both ranges filled with NOP, which never jumps
 * anywhere, so the fixture is coherent rather than landing on whatever a
 * sparse fixture leaves at $00 $00 (BRK). The operands the resolver reads
 * are planted in place; everything else is deliberately arithmetic, not
 * copied from a ROM. Returns this exact signature's own fingerprint, for a
 * test to pass back in rather than needing the real corpus hash.
 */
export const HOOK_RANGE_A_OFFSET = 0x000
export const HOOK_RANGE_A_LENGTH = 0x07f
export const HOOK_RANGE_B_OFFSET = 0x6e0
export const HOOK_RANGE_B_LENGTH = 0x12f
export const HOOK_TABLE_OFFSET = 0x7b4
export const HOOK_TAIL_OFFSET = 0x7fa
export const HOOK_EXGFX_OPERANDS = [0x713, 0x7d7, 0x7dd]

export function plantHookSignature(
  rom: RomFile,
  primary: number,
  lo: number,
  hi: number,
  bank: number,
  jml: number,
): string {
  rom.writeAt(primary + HOOK_RANGE_A_OFFSET, new Array<number>(HOOK_RANGE_A_LENGTH).fill(0xea))
  rom.writeAt(primary + HOOK_RANGE_B_OFFSET, new Array<number>(HOOK_RANGE_B_LENGTH).fill(0xea))
  const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff]
  rom.writeAt(primary + HOOK_TABLE_OFFSET + 4, long(lo))
  rom.writeAt(primary + HOOK_TABLE_OFFSET + 10, long(hi))
  rom.writeAt(primary + HOOK_TABLE_OFFSET + 16, long(bank))
  rom.writeAt(primary + HOOK_TAIL_OFFSET + 9, long(jml))
  for (const off of HOOK_EXGFX_OPERANDS) rom.writeAt(primary + off, long(0))
  return computeHookFingerprint(rom, primary)!
}

/** The tile-count loop's `LDY.B #$7F` and the two bytes either side of it
 *  (bank_00.asm:5431-5433), which is what `readTilesPerFile` matches on. */
export function uploadGfxFileSite(tilesMinusOne = 0x7f): number[] {
  return [0x8d, 0x0b, 0x0f, 0xa0, tilesMinusOne, 0xad, 0x0b, 0x0f, 0xf0]
}
export const UPLOAD_GFX_AT = 0x2a00

/** CODE_00A993 from its entry through the JSL (bank_00.asm:5287-5297), and
 *  the two JSRs that reach it (bank_00.asm:2243, 2493). */
export const L3_ROUTINE = 0x00a993
export const L3_CALLERS = [0x009397, 0x0095a1]
export const L3_CALL = [0x20, 0x93, 0xa9]
export function layer3Routine(countMinus1 = 3, start = 0x28): number[] {
  // prettier-ignore
  return [
    0x9c, 0x16, 0x21, 0xa9, 0x40, 0x8d, 0x17, 0x21,
    0xa9, countMinus1, 0x85, 0x0f, 0xa9, start, 0x85, 0x0e,
    0xa5, 0x0e, 0xa8, 0x22,
  ]
}

/** PrepareGraphicsFile as the 65816 encodes it: three table loads, the
 *  decompression call, and the frame around them (bank_00.asm:6571-6591). */
export function prepareGraphicsFile(
  lo = TABLE_LO,
  hi = TABLE_HI,
  bank = TABLE_BANK,
  jsr = DECOMP_ENTRY,
): number[] {
  const abs = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff]
  return [
    0x8b,
    0x5a,
    0x4b,
    0xab,
    0xb9,
    ...abs(lo),
    0x85,
    0x00,
    0xb9,
    ...abs(hi),
    0x85,
    0x01,
    0xb9,
    ...abs(bank),
    0x85,
    0x02,
    0xa9,
    0x00,
    0x85,
    0x03,
    0xa9,
    0xad,
    0x85,
    0x04,
    0xa9,
    0x7e,
    0x85,
    0x05,
    0x20,
    ...abs(jsr),
    0x7a,
    0xab,
    0x6b,
  ]
}

/**
 * Byte positions in `prepareGraphicsFile` that the resolver wildcards, so a
 * planted-defect sweep can exclude exactly those and no more.
 *
 * DERIVED from the pattern rather than listed, because the hand-written list
 * had drifted: it held 17 positions against the pattern's 14 wildcards. The
 * extra three were 20, 24 and 28, the `#$00` / `#$AD` / `#$7E` immediates
 * that build the $7EAD00 output-buffer pointer. The pattern matches those
 * literally, so a defect in them IS refused, but the sweep skipped them and
 * so never proved it. A sweep whose own comment says "a resolver that only
 * notices a defect in byte 0 is not a resolver" should not carry a
 * hand-maintained blind spot.
 */
export const OPERAND_POSITIONS = new Set(
  PREPARE_GFX_PATTERN.flatMap((b, i) => (b === WILD ? [i] : [])),
)

export interface CartOptions {
  /** Exactly GFX_FILE_COUNT compressed streams. */
  streams?: Uint8Array[]
  arenaAt?: number
  /** Bytes at the decompressor entry. Defaults to the stock prologue. */
  entryBytes?: readonly number[]
  /** Files placed away from the packed cluster: index to file offset. */
  outliers?: Record<number, number>
  /** Bytes of $FF filler after the cluster. */
  filler?: number
  routine?: number[]
  /** LoROM bank the routine and its tables sit in; 0 is vanilla. */
  bank?: number
  /** The tile-count site, or null to leave it out entirely. */
  uploadSite?: number[] | null
  /** The L3 (overlay) upload routine, or null to leave it and its callers out. */
  l3Routine?: number[] | null
  /**
   * Prepend a 512-byte copier header, making this the headered twin of the
   * same cartridge. CART_SIZE is a whole number of KB, so adding the header
   * is exactly what `hasCopierHeader` detects.
   */
  headered?: boolean
}

export interface SyntheticCart {
  rom: RomFile
  offsets: number[]
}

/** Distinct payloads per file, so a file laid out in the wrong place shows. */
export function gfxPayloads(size = 96): Uint8Array[] {
  return Array.from({ length: GFX_FILE_COUNT }, (_, i) =>
    Uint8Array.from({ length: size }, (_, k) => (i * 31 + k * 7) & 0xff),
  )
}

export function gfxStreams(size = 96): Uint8Array[] {
  return gfxPayloads(size).map(p => encode(p))
}

export function buildCart(opts: CartOptions = {}): SyntheticCart {
  const buf = Buffer.alloc(CART_SIZE, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode, so SmwRom accepts it
  const bankAt = (opts.bank ?? 0) * LOROM_BANK_SIZE
  buf.set(opts.routine ?? prepareGraphicsFile(), bankAt + ROUTINE_AT)
  buf.set(opts.entryBytes ?? STOCK_LCLZ2_ENTRY, bankAt + DECOMP_ENTRY - 0x8000)
  const routineSnes = loromFromOffset(bankAt + ROUTINE_AT)!
  for (const c of LEVEL_GFX_CALLERS) buf.set(jsl(routineSnes), c - 0x8000)
  const uploadSite = opts.uploadSite === undefined ? uploadGfxFileSite() : opts.uploadSite
  if (uploadSite) buf.set(uploadSite, UPLOAD_GFX_AT)
  const l3Routine = opts.l3Routine === undefined ? layer3Routine() : opts.l3Routine
  if (l3Routine) {
    buf.set(l3Routine, L3_ROUTINE - 0x8000)
    for (const c of L3_CALLERS) buf.set(L3_CALL, c - 0x8000)
  }

  const streams = opts.streams ?? gfxStreams()
  const offsets: number[] = []
  let at = opts.arenaAt ?? ARENA_AT
  for (let i = 0; i < streams.length; i++) {
    const outlier = opts.outliers?.[i]
    const dest = outlier ?? at
    buf.set(streams[i]!, dest)
    offsets.push(dest)
    if (outlier === undefined) at += streams[i]!.length
  }
  if (opts.filler) buf.fill(0xff, at, at + opts.filler)

  for (let i = 0; i < GFX_FILE_COUNT; i++) {
    const snes = loromFromOffset(offsets[i] ?? offsets[0]!)!
    buf[bankAt + TABLE_LO - 0x8000 + i] = snes & 0xff
    buf[bankAt + TABLE_HI - 0x8000 + i] = (snes >> 8) & 0xff
    buf[bankAt + TABLE_BANK - 0x8000 + i] = (snes >> 16) & 0xff
  }
  if (!opts.headered) return { rom: new RomFile('synthetic.sfc', buf), offsets }
  // Junk in the header, not zeroes: a header full of $00 would let an
  // off-by-512 read look plausible instead of obviously wrong.
  const header = Buffer.alloc(COPIER_HEADER_SIZE, 0x5a)
  return { rom: new RomFile('synthetic.smc', Buffer.concat([header, buf])), offsets }
}

/** Give a ROM built for some other test the GFX read path: PrepareGraphicsFile
 *  naming the tables at TABLE_*, a stock decompressor entry, and the L3 loads. */
export function plantGfxReadPath(rom: RomFile): void {
  rom.writeAt(0x8000 + ROUTINE_AT, prepareGraphicsFile())
  rom.writeAt(DECOMP_ENTRY, [...STOCK_LCLZ2_ENTRY])
  const routineSnes = 0x8000 + ROUTINE_AT
  for (const c of LEVEL_GFX_CALLERS) rom.writeAt(c, jsl(routineSnes))
  rom.writeAt(L3_ROUTINE, layer3Routine())
  for (const c of L3_CALLERS) rom.writeAt(c, L3_CALL)
}

/** Apply an arena plan to a copy of the cart, the way the working copy will. */
export function applyWrites(
  rom: RomFile,
  writes: readonly { offset: number; bytes: Uint8Array }[],
): RomFile {
  const buf = Buffer.from(rom.buffer)
  // `ArenaWrite.offset` is CART-relative, the same frame
  // `RomFile.readAtFileOffset` takes, so the copier header is added here and
  // exactly once. Writing at the bare offset on a headered cart would land
  // 512 bytes early, over whatever actually lives there.
  const base = rom.hasHeader ? COPIER_HEADER_SIZE : 0
  for (const w of writes) buf.set(w.bytes, base + w.offset)
  return new RomFile(rom.filePath, buf)
}
