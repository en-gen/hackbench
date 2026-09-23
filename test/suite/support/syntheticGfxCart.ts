/**
 * A cartridge with a GFX arena on it, built from nothing.
 *
 * **No bytes here come from any Super Mario World ROM or derived resource.**
 * The instruction sequence is written from the 65816 encoding so the arena
 * code has a `PrepareGraphicsFile` to resolve; the graphics are arithmetic.
 * That is what lets the GFX editor's gates and refusals be tested in CI,
 * where test/roms/ is absent by design.
 */
import { RomFile } from '../../../src/rom/RomFile'
import { encode } from '../../../src/rom/LcLz2'
import { COPIER_HEADER_SIZE, loromFromOffset } from '../../../src/rom/addressing'
import { WILD } from '../../../src/rom/BytePattern'
import { GFX_FILE_COUNT, PREPARE_GFX_PATTERN, STOCK_LCLZ2_ENTRY } from '../../../src/rom/GfxArena'

export const CART_SIZE = 0x18000 // three LoROM banks: tables, routine, arena
export const TABLE_LO = 0xb992
export const TABLE_HI = 0xb9c4
export const TABLE_BANK = 0xb9f6
export const DECOMP_ENTRY = 0xb8de
export const ROUTINE_AT = 0x3a46 // bank 0, clear of both tables
export const ARENA_AT = 0x10000

/** The tile-count loop's `LDY.B #$7F` and the two bytes either side of it
 *  (bank_00.asm:5431-5433), which is what `readTilesPerFile` matches on. */
export function uploadGfxFileSite(tilesMinusOne = 0x7f): number[] {
  return [0x8d, 0x0b, 0x0f, 0xa0, tilesMinusOne, 0xad, 0x0b, 0x0f, 0xf0]
}
export const UPLOAD_GFX_AT = 0x2a00

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
  /** The tile-count site, or null to leave it out entirely. */
  uploadSite?: number[] | null
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
  buf.set(opts.routine ?? prepareGraphicsFile(), ROUTINE_AT)
  buf.set(opts.entryBytes ?? STOCK_LCLZ2_ENTRY, DECOMP_ENTRY - 0x8000)
  const uploadSite = opts.uploadSite === undefined ? uploadGfxFileSite() : opts.uploadSite
  if (uploadSite) buf.set(uploadSite, UPLOAD_GFX_AT)

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
    buf[TABLE_LO - 0x8000 + i] = snes & 0xff
    buf[TABLE_HI - 0x8000 + i] = (snes >> 8) & 0xff
    buf[TABLE_BANK - 0x8000 + i] = (snes >> 16) & 0xff
  }
  if (!opts.headered) return { rom: new RomFile('synthetic.sfc', buf), offsets }
  // Junk in the header, not zeroes: a header full of $00 would let an
  // off-by-512 read look plausible instead of obviously wrong.
  const header = Buffer.alloc(COPIER_HEADER_SIZE, 0x5a)
  return { rom: new RomFile('synthetic.smc', Buffer.concat([header, buf])), offsets }
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
