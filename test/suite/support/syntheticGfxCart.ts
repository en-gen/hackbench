/**
 * A cartridge with a GFX arena on it, built from nothing.
 *
 * **No bytes here come from any Super Mario World ROM or derived resource.**
 * The instruction sequence is written from the 65816 encoding so the arena
 * code has a `PrepareGraphicsFile` to resolve; the graphics are arithmetic.
 * That is what lets the GFX editor's gates and refusals be tested in CI,
 * where the corpus is absent by design.
 */
import { createHash } from 'node:crypto'
import { RomFile } from '../../../src/rom/RomFile'
import { encode } from '../../../src/rom/LcLz2'
import { COPIER_HEADER_SIZE, LOROM_BANK_SIZE, loromFromOffset } from '../../../src/rom/addressing'
import { WILD } from '../../../src/rom/BytePattern'
import { GFX_FILE_COUNT, LEVEL_GFX_CALLERS, PREPARE_GFX_PATTERN } from '../../../src/rom/GfxArena'
import { STOCK_LCLZ2_ENTRY, type FastRoutine } from '../../../src/rom/GfxDecompressor'
import {
  PALETTE_COL1_PATH,
  ADDR_COL1_BG_LDA,
  ADDR_COL1_OBJ_LDA,
  plantStockPaletteCol1,
} from '../../../src/rom/PaletteStockTables'
import { STOCK_COL1 } from '../../../src/rom/PaletteLoader'
import {
  FILTER_BODY_LENGTH,
  UPLOAD_GFX_CALLERS,
  UPLOAD_GFX_DISPATCH,
  UPLOAD_GFX_OPERANDS,
} from '../../../src/rom/GfxLoader'

/** A StockCode entry's bytes with WILD positions filled, for planting rather than matching. */
const concreteBytes = (bytes: readonly number[]): number[] => bytes.map(b => (b === WILD ? 0 : b))
const ldaImm = (word: number): number[] => [0xa9, word & 0xff, (word >> 8) & 0xff]

export const CART_SIZE = 0x18000 // three LoROM banks: tables, routine, arena
export const TABLE_LO = 0xb992
export const TABLE_HI = 0xb9c4
export const TABLE_BANK = 0xb9f6
export const DECOMP_ENTRY = 0xb8de
export const ROUTINE_AT = 0x3a46 // bank 0, clear of both tables
/** PrepareGraphicsFile's SNES address on a bank-0 cart. */
export const PREPARE_GFX = 0x8000 + ROUTINE_AT
export const ARENA_AT = 0x10000

/** JSL to `target`, 4 bytes, the encoding a hijacked call site overwrites. */
export function jsl(target: number): number[] {
  return [0x22, target & 0xff, (target >> 8) & 0xff, (target >> 16) & 0xff]
}

/** PHP / REP #$30 / LDA $8A / EOR #key / STA $8A / PLP / REP #$10 / LDY #$0000 / RTL,
 *  restated rather than imported so a change to XOR_PRELUDE cannot move the tests. */
// prettier-ignore
export const xorPrelude = (key: number): number[] => [
  0x08, 0xc2, 0x30, 0xa5, 0x8a, 0x49, key & 0xff, key >> 8, 0x85, 0x8a, 0x28, 0xc2, 0x10, 0xa0,
  0x00, 0x00, 0x6b,
]
export const PRELUDE_KEY_BYTES = [6, 7]

/** The prelude holding `key` at `at`, and `JSL at / NOP` over the entry's first five bytes. */
export function plantPrelude(rom: RomFile, at: number, key: number, entry = DECOMP_ENTRY): void {
  rom.writeAt(at, xorPrelude(key))
  rom.writeAt(entry, [...jsl(at), 0xea])
}

/** Arithmetic bytes, hashed as a recognized routine would be. */
export function syntheticRoutine(length: number, seed = 11): { bytes: number[]; sha: string } {
  const bytes = Array.from({ length }, (_, i) => (i * 37 + seed) & 0xff)
  return { bytes, sha: createHash('sha256').update(Buffer.from(bytes)).digest('hex') }
}

/** A synthetic fast body of `length` at `at`, entered by `JSL at / RTS` at entry+5. */
export function plantFast(
  rom: RomFile,
  at: number,
  length: number,
  entry = DECOMP_ENTRY,
): FastRoutine {
  const { bytes, sha } = syntheticRoutine(length)
  rom.writeAt(at, bytes)
  rom.writeAt(entry + 5, [...jsl(at), 0x60])
  return { length, fingerprint: sha }
}

/** Header bytes above command 4, each followed by a zero offset or length byte. Stock
 *  reads every one as a copy; the fast routine reads several as another long header. */
export const FAST_DIVERGENT_COMMANDS: [string, number[]][] = [
  ['short 5', [0xa0, 0x00, 0x00]],
  ['short 6', [0xc0, 0x00, 0x00]],
  ['inner 5', [0xf4, 0x00, 0x00, 0x00]],
  ['inner 6', [0xf8, 0x00, 0x00, 0x00]],
  ['inner 7, $FC', [0xfc, 0x00, 0x00, 0x00]],
  ['inner 7, $FD', [0xfd, 0x00, 0x00, 0x00]],
  ['inner 7, $FE', [0xfe, 0x00, 0x00, 0x00]],
]

/** Where `plantGfxHook` puts the default path, the loader and the dispatcher,
 *  relative to the hook's entry. */
export const HOOK_LANDING = 0x20
export const HOOK_LOADER = 0x40
export const HOOK_DISPATCHER = 0x80

/**
 * The ExGFX hook's shape (src/rom/GfxArena.ts HOOK_*), written from the 65816
 * encoding: entry, BRA to a JSR/RTL, and either the older build's JSL to
 * PrepareGraphicsFile or the newer stub's JSL to a dispatcher. The dispatcher
 * is NOP-filled but for the operands the resolver reads; pass its own
 * `dispatcherFingerprint` to recognize it.
 */
export function plantGfxHook(
  rom: RomFile,
  entry: number,
  prepareGfx: number,
  loader: 'direct' | 'stub',
  tables: readonly number[] = [TABLE_LO, TABLE_HI, TABLE_BANK],
): void {
  const bra = HOOK_LANDING - 13
  rom.writeAt(entry, [0xa3, 0x04, 0xc9, 0x0a, 0xf0, 0x10, 0xc9, 0x4b, 0xf0, 0x03, 0x98, 0x80, bra])
  const at = entry + HOOK_LOADER
  rom.writeAt(entry + HOOK_LANDING, [0x20, at & 0xff, (at >> 8) & 0xff, 0x6b])
  if (loader === 'direct') {
    // PHX PHY PHP REP / AND #$FF / CMP #$7F BEQ / CMP #$80 BCS / TAY SEP JSL /
    // BRA over two NOPs to PLP PLY PLX RTS
    // prettier-ignore
    rom.writeAt(at, [0xda, 0x5a, 0x08, 0xc2, 0x30, 0x29, 0xff, 0x00, 0xc9, 0x7f, 0x00, 0xf0, 0x0a,
      0xc9, 0x80, 0x00, 0xb0, 0x05, 0xa8, 0xe2, 0x30, ...jsl(prepareGfx), 0x80, 0x02, 0xea, 0xea,
      0x28, 0x7a, 0xfa, 0x60])
    return
  }
  const d = entry + HOOK_DISPATCHER
  // XBA STZ / $7EAD00 into $00-$02 / LDA #0 XBA / JSL dispatcher / RTS
  // prettier-ignore
  rom.writeAt(at, [0xeb, 0x64, 0x00, 0xa9, 0xad, 0x85, 0x01, 0xa9, 0x7e, 0x85, 0x02, 0xa9, 0x00,
    0xeb, ...jsl(d), 0x60])
  rom.writeAt(d, new Array<number>(0x6f).fill(0xea))
  tables.forEach((t, i) => rom.writeAt(d + 0x17 + i * 6, [0xbf, ...jsl(t).slice(1)]))
  rom.writeAt(d + 0x62, [0x5c, ...jsl(prepareGfx + 0x1f).slice(1)])
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
  // Column 1's level-load reach and opcode gate (#492), stock-shaped so a
  // GFX-focused test does not have to know palette machinery exists.
  for (const c of PALETTE_COL1_PATH) buf.set(concreteBytes(c.bytes), c.addr & 0x7fff)
  buf.set(ldaImm(STOCK_COL1.bg), ADDR_COL1_BG_LDA & 0x7fff)
  buf.set(ldaImm(STOCK_COL1.obj), ADDR_COL1_OBJ_LDA & 0x7fff)

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
  const routineSnes = PREPARE_GFX
  for (const c of LEVEL_GFX_CALLERS) rom.writeAt(c, jsl(routineSnes))
  rom.writeAt(L3_ROUTINE, layer3Routine())
  for (const c of L3_CALLERS) rom.writeAt(c, L3_CALL)
  plantFilterSomeRam(rom)
}

/** An arithmetic FilterSomeRAM body, and the fingerprint to pass the gate as stock. */
export const FILTER_BODY = Array.from({ length: FILTER_BODY_LENGTH }, (_, i) => (i * 37 + 5) & 0xff)
export const FILTER_BODY_SHA = [createHash('sha256').update(Buffer.from(FILTER_BODY)).digest('hex')]
export const FILTER_BODY_AT = 0x00ab02
export const UPLOAD_GFX_ENTRY = LEVEL_GFX_CALLERS[0]!

export interface FilterOperands {
  tilesetMin: number
  tilesetFile: number
  anyFile: number
}
export const VANILLA_FILTER: FilterOperands = { tilesetMin: 0x11, tilesetFile: 0x08, anyFile: 0x1e }

/** UploadGFXFile's dispatch built from the gate's own pattern, operands filled in. */
export function filterDispatch(o = VANILLA_FILTER, bodyAt = FILTER_BODY_AT): number[] {
  const b = concreteBytes(UPLOAD_GFX_DISPATCH)
  for (const at of [0, 15]) b.splice(at, 4, ...jsl(PREPARE_GFX))
  const { tilesetMin, tilesetFile, anyFile, jmp } = UPLOAD_GFX_OPERANDS
  b[tilesetMin] = o.tilesetMin
  b[tilesetFile] = o.tilesetFile
  b[anyFile] = o.anyFile
  b.splice(jmp, 2, bodyAt & 0xff, (bodyAt >> 8) & 0xff)
  return b
}

/** The dispatch at `entry`, both upload loops' JSRs to it, and the synthetic body. */
export function plantFilterSomeRam(
  rom: RomFile,
  o = VANILLA_FILTER,
  entry = UPLOAD_GFX_ENTRY,
): void {
  rom.writeAt(entry, filterDispatch(o))
  for (const c of UPLOAD_GFX_CALLERS) rom.writeAt(c, [0x20, entry & 0xff, (entry >> 8) & 0xff])
  rom.writeAt(FILTER_BODY_AT, FILTER_BODY)
}

/** Give a ROM built for some other test column 1's level-load reach and
 *  opcode gate (#492), stock-shaped so a GFX/Map16-focused test does not
 *  have to know palette machinery exists. */
export const plantPaletteCol1ReachPath = plantStockPaletteCol1

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
