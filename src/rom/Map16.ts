/**
 * Map16.ts -- Map16 pointer table construction and tile decoding for Super Mario World.
 *
 * Derived from SMWDisX disassembly:
 *   - CODE_0581FB (bank_05.asm lines 253-358): bitmap-driven pointer table setup
 *   - DATA_0581BB (bank_05.asm lines 243-251): 64-byte bitmap
 *   - TilesetMAP16Loc (bank_05.asm lines 2-17): 15 word entries (tileset addresses)
 *   - Map16Common ($0D8000, bank_0D.asm line 2): common tiles
 *   - Map16BGTiles ($0D9100, bank_0D.asm line 551): L2 preset background tiles
 *   - Map16Tileset0-4 (bank_0D.asm): tileset-specific tiles
 *   - UploadOneMap16Strip (bank_00.asm line 958): DMA order confirms column-major
 *     subtile order: TL, BL, TR, BR
 *
 * Each Map16 tile = 8 bytes = 4 little-endian words (SNES BG tile attributes).
 * Word order (column-major, verified via UploadOneMap16Strip DMA at bank_00 lines 969-1025):
 *   word 0 = TL (top-left)
 *   word 1 = BL (bottom-left)
 *   word 2 = TR (top-right)
 *   word 3 = BR (bottom-right)
 */

import { RomFile } from './RomFile'
import { BytePattern, WILD, findPattern, findUnique, matchesAt } from './BytePattern'
import { loromFromOffset, loromToOffset } from './addressing'
import { decodeWord } from './render/TileResolver'

// ── ROM addresses (from SMW_U.sym) ────────────────────────────────────────────
/** Map16Common on a stock ROM; `readMap16Table` reads the operand. */
export const MAP16_COMMON = 0x0d8000 // bank_0D.asm line 2

/** Map16BGTiles on a stock ROM, a cross-check only: `readL2Map16Table` reads the operand. */
export const MAP16_BG_TILES = 0x0d9100 // bank_0D.asm line 551

/** TilesetMAP16Loc on a stock ROM, a cross-check only. */
export const TILESET_MAP16_LOC = 0x058000 // bank_05.asm line 2

/** DATA_0581BB on a stock ROM, a cross-check only. */
export const MAP16_BITMAP_ADDR = 0x0581bb // bank_05.asm line 243

/** Number of tileset entries in TilesetMAP16Loc */
export const TILESET_COUNT = 15 // bank_05.asm lines 3-17

/** Tile IDs `$133..$13A` are the 8 consecutive pipe tiles the app-table redirects. */
export const PIPE_VARIANT_TILE_START = 0x133
export const PIPE_VARIANT_TILE_COUNT = 8

/**
 * Compute the MAP16AppTable index (0-3) for a given scroll-ish counter, matching
 * the ASM's `(Layer1TileDown >> 3) & 6` then divided by 2.
 *
 * bank_05.asm:119-124 uses Layer1TileDown (level-load loop, increments per strip).
 * bank_05.asm:910-915 uses Layer1TileUp (scroll-triggered, derived from Layer1YPos).
 */
export function pipeVariantIndex(scrollCounter: number): number {
  return ((scrollCounter >>> 3) & 0x06) >>> 1
}

/** Tileset-specific Map16 addresses from SMW_U.sym */
export const MAP16_TILESET_ADDRS: number[] = [
  0x0d8b70, // Map16Tileset0
  0x0dbc00, // Map16Tileset1
  0x0dc800, // Map16Tileset2
  0x0dd400, // Map16Tileset3
  0x0de300, // Map16Tileset4
]

export const MAP16_TILE_BYTES = 8
export const MAP16_TOTAL_TILES = 512 // 64 bytes * 8 bits = 512 tile entries

/**
 * What a STOCK cartridge holds, kept as a documented cross-check.
 *
 * Never read this as a default. `readMap16TileCount` reads the real count
 * off the cart; a cart that does not say is unavailable, not vanilla.
 */
export const VANILLA_MAP16_TILE_COUNT = 512

/**
 * The Map16 pointer-fill loop, `bank_05.asm:229-237`:
 *
 *     ADC.W #$0008 / STA.B _0 / INX / INX / CPX.W #imm / BNE -
 *
 * The `CPX` immediate is the loop's bound in BYTES of `Map16Pointers`, two
 * per tile, so it divided by two is the tile count.
 *
 * Anchored on the `ADC.W #$0008` stride, not on the `INX/INX/CPX/BNE` tail
 * alone: that tail is a generic 16-bit loop ending and matches 5 to 7 times
 * per cartridge, measured across the 6-cart corpus. With the stride
 * included it matches 3 times, at identical offsets on all 6, and all three
 * sites carry the same bound.
 */
const MAP16_COUNT_PATTERN: BytePattern = [
  0x69,
  0x08,
  0x00,
  0x85,
  WILD,
  0xe8,
  0xe8,
  0xe0,
  WILD,
  WILD,
  0xd0,
]
const MAP16_COUNT_OPERAND_OFFSET = 8

/**
 * How many Map16 tiles this cartridge's engine indexes, or null when it
 * does not say.
 *
 * Read rather than assumed: Lunar Magic's expanded-Map16 patch
 * (en-gen/hackbench#41) raises this past the stock 512, and a hardcoded
 * constant would present the first two pages as though they were the whole
 * table. That is the failure CLAUDE.md's "never fall back to the vanilla
 * value" rule exists to prevent, so a cartridge whose loop cannot be
 * resolved returns null and the caller refuses.
 *
 * EVERY matching site is read, not just the first, and they must agree -
 * the same rule `GfxLoader.readBg3CharBase` follows for its `$210C` writes.
 * A cart that patched one fill loop and not another cannot be said to have
 * a single count.
 *
 * Null when: no site matches, the sites disagree, the bound is not a whole
 * number of two-byte pointers, or it is zero.
 */
export function readMap16TileCount(rom: RomFile): number | null {
  const hits = findPattern(rom, MAP16_COUNT_PATTERN)
  if (hits.length === 0) return null

  let agreed: number | null = null
  for (const at of hits) {
    const operand = rom.readAtFileOffset(at + MAP16_COUNT_OPERAND_OFFSET, 2)
    if (!operand) return null
    // Byte-indexed, not readUInt16LE: readAtFileOffset hands back a plain
    // Uint8Array when the RomFile was built from bytes rather than a file,
    // as RomFile's own `buffer` comment warns.
    const pointerBytes = operand[0]! | (operand[1]! << 8)
    if (pointerBytes === 0 || pointerBytes % 2 !== 0) return null
    if (agreed === null) agreed = pointerBytes
    else if (agreed !== pointerBytes) return null
  }
  return agreed === null ? null : agreed / 2
}

// ── Subtile / tile types ─────────────────────────────────────────────────────

export interface SubTile {
  charNum: number // 10-bit GFX character index (bits 0-9)
  palette: number // 3-bit palette row (bits 10-12)
  priority: boolean // bit 13
  flipX: boolean // bit 14
  flipY: boolean // bit 15
}

/** A decoded 16x16 Map16 tile with its four 8x8 subtiles. */
export interface Map16Tile {
  id: number
  tl: SubTile // top-left     (word 0, column-major)
  tr: SubTile // top-right    (word 2, column-major)
  bl: SubTile // bottom-left  (word 1, column-major)
  br: SubTile // bottom-right (word 3, column-major)
}

/**
 * Unpacks one 16-bit SNES BG tile-attribute word into its five fields.
 * Delegates the bit arithmetic to the core resolver (`render/TileResolver.ts`,
 * #421 step 2) - the same decode Mesen-checked capture drawing uses - and
 * only renames/retypes its fields to this module's own `SubTile` shape.
 */
export function decodeSubTileWord(word: number): SubTile {
  const w = decodeWord(word)
  return {
    charNum: w.char,
    palette: w.pal,
    priority: w.prio === 1,
    flipX: w.flipX === 1,
    flipY: w.flipY === 1,
  }
}

/**
 * Inverse of `decodeSubTileWord`. Every input field is masked to its own bit
 * width rather than trusted as already-clamped, so an editor UI passing a
 * stray out-of-range value (a char number above 1023, say) cannot corrupt a
 * bit outside its own field.
 */
export function encodeSubTileWord(sub: SubTile): number {
  return (
    (sub.charNum & 0x3ff) |
    ((sub.palette & 0x7) << 10) |
    ((sub.priority ? 1 : 0) << 13) |
    ((sub.flipX ? 1 : 0) << 14) |
    ((sub.flipY ? 1 : 0) << 15)
  )
}

const EMPTY_SUBTILE: SubTile = {
  charNum: 0,
  palette: 0,
  priority: false,
  flipX: false,
  flipY: false,
}

function readTileAt(rom: RomFile, addr: number, id: number): Map16Tile {
  const buf = rom.readAt(addr, MAP16_TILE_BYTES)
  if (!buf) {
    return { id, tl: EMPTY_SUBTILE, tr: EMPTY_SUBTILE, bl: EMPTY_SUBTILE, br: EMPTY_SUBTILE }
  }
  // Column-major word order: TL(0), BL(2), TR(4), BR(6)
  const w0 = le16(buf, 0) // TL
  const w1 = le16(buf, 2) // BL
  const w2 = le16(buf, 4) // TR
  const w3 = le16(buf, 6) // BR
  return {
    id,
    tl: decodeSubTileWord(w0),
    bl: decodeSubTileWord(w1),
    tr: decodeSubTileWord(w2),
    br: decodeSubTileWord(w3),
  }
}

/** A value read from the ROM, or why this ROM does not say. */
export type Map16Read<T> = { ok: true; value: T } | { ok: false; reason: string }

const le16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8)
const le24 = (b: Uint8Array, at: number): number => le16(b, at) | (b[at + 2]! << 16)
const s8 = (v: number): number => (v << 24) >> 24
const s16 = (v: number): number => (v << 16) >> 16
const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
const snesHex = (at: number): string => `$${(loromFromOffset(at) ?? at).toString(16).toUpperCase()}`

// Code scans cost ~10 ms on a 512 KB ROM and MapBuilder asks per level.
const _scans = new WeakMap<RomFile, { version: number; values: Map<string, unknown> }>()
function scanOnce<T>(rom: RomFile, key: string, scan: () => T): T {
  let entry = _scans.get(rom)
  if (!entry || entry.version !== rom.version) {
    entry = { version: rom.version, values: new Map() }
    _scans.set(rom, entry)
  }
  if (!entry.values.has(key)) entry.values.set(key, scan())
  return entry.values.get(key) as T
}

/** The bank Map16 pointers are dereferenced in; with `extent`, tile ids from it up bypass the table. */
export interface Map16Bank {
  bank: number
  extent?: number
}

const byteAt = (rom: RomFile, at: number): number => rom.readAtFileOffset(at, 1)![0]!

interface ReadSite {
  setter: BytePattern
  bankAt: number
  window: number
  stock: BytePattern
  hooked?: BytePattern
  viaWrapper?: boolean
  /** How many setters a stock ROM holds; fewer means one was diverted. */
  count?: number
}

/**
 * Level `Map16Pointers` read sites: a bank setter, then the stock read or a JSL
 * to the hook. bank_00.asm:7515-7520 and :7625-7630 (bank into _6, via a
 * wrapper when hooked); bank_05.asm:1196-1216 and siblings :1339, :1460, :1593.
 */
// prettier-ignore
const LEVEL_SITES: ReadSite[] = [
  { setter: [0xa9, 0xff, 0x9f, WILD, WILD, 0x7f, 0xa9, WILD, 0x85, 0x06], bankAt: 7, window: 0,
    stock: [0xc2, 0x20, 0xb9, 0xbe, 0x0f, 0x85, 0x04], hooked: [0x22, WILD, WILD, WILD, 0xea, 0x85, 0x04],
    viaWrapper: true, count: 2 },
  { setter: [0xa0, WILD, 0xad, 0x31, 0x19, 0xc9, 0x10, 0x30, 0x02, 0xa0, WILD, 0x84, 0x0c], bankAt: 1,
    window: 0x30, stock: [0xb9, 0xbe, 0x0f, 0x85, 0x0a], hooked: [0x22, WILD, WILD, WILD, 0x85, 0x0a],
    viaWrapper: false, count: 4 },
]
/**
 * The credits reader, bank_0C.asm:816-838: it must agree, but is not a level
 * path. Its read sits $25 bytes past the setter, the widest stock span.
 */
const CREDITS: ReadSite = {
  setter: [0xa9, WILD, 0x85, 0x6a],
  bankAt: 1,
  window: 0x30,
  stock: [0xbd, 0xbe, 0x0f, 0x85, 0x68],
}

/**
 * Lunar Magic's hook: `CMP #bound / BCC` to the low-tile path, which is the
 * whole path a tile below `bound` runs, so matching it byte for byte is enough.
 */
const HOOK_ENTRY: BytePattern = [0xc9, WILD, WILD, 0x90, WILD]
// prettier-ignore
const HOOK_LOW: BytePattern = [
  0xa8, 0xad, 0x30, 0x19, 0xc9, 0x00, 0x10, 0x90, 0x05, 0xa9, 0x00, WILD, 0x80, 0x03,
  0xa9, 0x00, WILD, 0x85, 0x0b, 0xb9, 0xbe, 0x0f, 0x6b,
]
/** Wrappers that call the hook and return its bank in _6; PER lands the RTL on `LDY $0B`. */
// prettier-ignore
const WRAPPERS: { p: BytePattern; to: (b: Uint8Array) => number }[] = [
  { p: [0xc2, 0x20, 0x98, 0xd4, 0x0b, 0x4b, 0x62, 0x02, 0x00, 0x82, WILD, WILD, 0xa4, 0x0b, 0x84, 0x05,
    0x7a, 0x84, 0x0b, 0x6b], to: b => 12 + s16(le16(b, 10)) },
  { p: [0xc2, 0x20, 0x98, 0xd4, 0x0b, 0x4b, 0x62, 0x01, 0x00, 0x80, WILD, 0xa4, 0x0b, 0x84, 0x05, 0x7a,
    0x84, 0x0b, 0x6b], to: b => 11 + s8(b[10]!) },
]

function readHook(rom: RomFile, snes: number, viaWrapper: boolean): Map16Bank | null {
  let at = loromToOffset(snes, rom.romSize)
  if (at === null) return null
  if (viaWrapper) {
    const wrap = WRAPPERS.map(w => ({ w, b: matchesAt(rom, at!, w.p) })).find(m => m.b)
    if (!wrap) return null
    at += wrap.w.to(wrap.b!)
  }
  const entry = matchesAt(rom, at, HOOK_ENTRY)
  const low = entry && matchesAt(rom, at + 5 + s8(entry[4]!), HOOK_LOW)
  if (!entry || !low) return null
  const extent = Math.min(le16(entry, 1) >> 1, MAP16_TOTAL_TILES)
  return extent > 0 ? { bank: low[16]!, extent } : null
}

export function readMap16Bank(rom: RomFile): Map16Read<Map16Bank> {
  return scanOnce(rom, 'bank', () => scanMap16Bank(rom))
}

function resolveSite(rom: RomFile, site: ReadSite, at: number): Map16Bank | null {
  const from = at + site.setter.length
  for (let k = from; k <= from + site.window; k++) {
    if (matchesAt(rom, k, site.stock)) {
      return { bank: byteAt(rom, at + site.bankAt) }
    }
    const jsl = site.hooked && matchesAt(rom, k, site.hooked)
    if (jsl) return readHook(rom, le24(jsl, 1), site.viaWrapper === true)
  }
  return null
}

/** Every level site must resolve, stock or hooked, and every bank must agree. */
function scanMap16Bank(rom: RomFile): Map16Read<Map16Bank> {
  const found: Map16Bank[] = []
  for (const site of LEVEL_SITES) {
    const setters = findPattern(rom, site.setter)
    if (setters.length !== site.count) {
      return refuse(
        `${setters.length} of the ${site.count} stock Map16Pointers bank setters of one shape remain`,
      )
    }
    for (const at of setters) {
      const resolved = resolveSite(rom, site, at)
      if (!resolved) {
        return refuse(
          `the Map16Pointers read after ${snesHex(at)} is neither stock nor the recognized hook`,
        )
      }
      found.push(resolved)
    }
  }
  for (const at of findPattern(rom, CREDITS.setter)) {
    const resolved = resolveSite(rom, CREDITS, at)
    if (resolved) found.push(resolved)
  }
  const banks = new Set(found.map(f => f.bank))
  if (banks.size > 1) {
    const list = [...banks].map(b => `$${b.toString(16).toUpperCase()}`).join(', ')
    return refuse(`the Map16Pointers readers disagree on the data bank (${list})`)
  }
  const bounds = found.flatMap(f => (f.extent === undefined ? [] : [f.extent]))
  const bank = [...banks][0]! << 16
  return { ok: true, value: bounds.length ? { bank, extent: Math.min(...bounds) } : { bank } }
}

/**
 * CODE_0581FB's setup, bank_05.asm:254-274: the bitmap's bank, then
 * TilesetMAP16Loc, Map16Common and DATA_0581BB as operands.
 */
// prettier-ignore
const FG_SETUP: BytePattern = [
  0xe2, 0x30, 0xad, 0x31, 0x19, 0x0a, 0xaa, 0xa9, WILD, 0x85, 0x0f, 0xa9, WILD, 0x85, 0x84, 0xa9,
  WILD, 0x8d, 0x30, 0x14, 0xa9, WILD, 0x8d, 0x31, 0x14, 0xc2, 0x20, 0xa9, WILD, WILD, 0x85, 0x82,
  0xbf, WILD, WILD, WILD, 0x85, 0x00, 0xa9, WILD, WILD, 0x85, 0x02, 0xa9, WILD, WILD, 0x85, 0x0d,
]

/**
 * CODE_0581FB's tile override, bank_05.asm:315-355, from the bitmap loop's
 * closing CPY / BNE so the block is the one that loop falls into.
 */
// prettier-ignore
const RUN: BytePattern = [
  0xa2, WILD, WILD, 0xa5, 0x00, 0x99, 0xbe, 0x0f, 0x18, 0x69, WILD, WILD, 0x85, 0x00, 0xc8, 0xc8,
  0xca, 0x10, 0xf0,
]
// prettier-ignore
const SLOPE_OVERRIDE: BytePattern = [
  0xc0, 0x40, 0x00, 0xd0, WILD, 0xad, 0x31, 0x19, 0xf0, 0x04, 0xc9, WILD, 0xd0, WILD, 0xa9, 0xff,
  0x8d, 0x30, 0x14, 0x8d, 0x31, 0x14, 0xc2, 0x30, 0xa9, WILD, WILD, 0x85, 0x82, 0xa9, WILD, WILD,
  0x0a, 0xa8, 0xa9, WILD, WILD, 0x85, 0x00, ...RUN, 0xa9, WILD, WILD, 0x0a, 0xa8, ...RUN,
]
/** [tile start, LDX operand, ADC operand] offsets of the two runs. */
// prettier-ignore
const SLOPE_RUNS = [[30, 40, 49], [59, 64, 73]] as const

/**
 * The Map16 pointer table for an object tileset, as CODE_0581FB builds it
 * (bank_05.asm:253-355): the bitmap interleaves Map16Common with the
 * tileset's own run, then CODE_058281 overrides two short runs.
 */
export function readMap16Table(rom: RomFile, tileset: number): Map16Read<number[]> {
  const setupAt = scanOnce(rom, 'fgSetup', () => findUnique(rom, FG_SETUP))
  if (setupAt === null) return refuse('the CODE_0581FB setup is not found exactly once')
  const setup = rom.readAtFileOffset(setupAt, FG_SETUP.length)!
  // Level headers mask the tileset with AND #$0F (bank_05.asm:625); $10 and up is the overworld.
  const tilesetWord = rom.readWord(le24(setup, 33) + (tileset & 0x0f) * 2)
  if (tilesetWord === null) return refuse(`TilesetMAP16Loc has no entry for tileset ${tileset}`)
  const bitmap = rom.readAt((setup[8]! << 16) | le16(setup, 44), 64)
  if (!bitmap) return refuse('the DATA_0581BB bitmap cannot be read')
  const bank = readMap16Bank(rom)
  if (!bank.ok) return bank
  const at = scanOnce(rom, 'slopes', () => findUnique(rom, SLOPE_OVERRIDE))
  if (at === null) return refuse('the CODE_058281 tile override is not found exactly once')

  const pointers: number[] = new Array(MAP16_TOTAL_TILES)
  let own = tilesetWord
  let common = le16(setup, 39)
  for (let i = 0; i < MAP16_TOTAL_TILES; i++) {
    const isCommon = (bitmap[i >> 3]! << (i & 7)) & 0x80
    pointers[i] = bank.value.bank | (isCommon ? common : own)
    if (isCommon) common = (common + MAP16_TILE_BYTES) & 0xffff
    else own = (own + MAP16_TILE_BYTES) & 0xffff
  }

  const code = rom.readAtFileOffset(at, SLOPE_OVERRIDE.length)!
  // BEQ takes tileset 0 without a compare; the CMP immediate names the other.
  if ((tileset & 0x0f) === 0 || (tileset & 0x0f) === code[11]) {
    let src = le16(code, 35)
    for (const [startAt, countAt, strideAt] of SLOPE_RUNS) {
      const start = le16(code, startAt)
      const count = le16(code, countAt) + 1 // DEX / BPL runs X+1 times
      if (start + count > MAP16_TOTAL_TILES)
        return refuse('the CODE_058281 override runs past the table')
      for (let i = 0; i < count; i++) {
        pointers[start + i] = bank.value.bank | src
        src = (src + le16(code, strideAt)) & 0xffff
      }
    }
  }
  return { ok: true, value: pointers.slice(0, bank.value.extent ?? MAP16_TOTAL_TILES) }
}

/** Where the shared Map16Common run starts, as CODE_0581FB's operand names it. */
export function readMap16Common(rom: RomFile): Map16Read<number> {
  const setupAt = scanOnce(rom, 'fgSetup', () => findUnique(rom, FG_SETUP))
  if (setupAt === null) return refuse('the CODE_0581FB setup is not found exactly once')
  const bank = readMap16Bank(rom)
  if (!bank.ok) return bank
  return { ok: true, value: bank.value.bank | le16(rom.readAtFileOffset(setupAt + 39, 2)!, 0) }
}

function orThrow<T>(read: Map16Read<T>): T {
  if (!read.ok) throw new Error(`Map16 table unavailable: ${read.reason}`)
  return read.value
}

/** Reference-era adapter over `readMap16Table`: throws where it declines. */
export function buildMap16PointerTable(rom: RomFile, tileset: number): number[] {
  return orThrow(readMap16Table(rom, tileset))
}

/** CODE_0580BD's and CODE_05877E's pipe-variant loads, bank_05.asm:124-138 and :914-928. */
// prettier-ignore
const APP_READ: BytePattern = [
  0x29, 0x06, 0x00, 0xaa, 0xa9, 0x33, 0x01, 0x0a, 0xa8, 0xa9, 0x07, 0x00, 0x85, 0x00, 0xbf, WILD,
  WILD, WILD, 0x99, 0xbe, 0x0f, 0xc8, 0xc8, 0x18, 0x69, 0x08, 0x00, 0xc6, 0x00, 0x10, 0xf3,
]
/** The instructions that compute each reader's index, bank_05.asm:118-123 and :906-913. */
// prettier-ignore
const APP_LEADINS: BytePattern[] = [
  [0xe2, 0x30, 0xa5, 0x47, 0x4a, 0x4a, 0x4a, 0xc2, 0x30],
  [0xe2, 0x30, 0xa5, 0x55, 0xaa, 0xb5, 0x45, 0x4a, 0x4a, 0x4a, 0xc2, 0x30],
]

/** Skipped by a JMP to just past it, else reached through an intact lead-in, else neither. */
function appReaderPath(rom: RomFile, hit: number): 'reached' | 'skipped' | null {
  const here = loromFromOffset(hit)!
  for (let k = hit - 16; k <= hit - 3; k++) {
    const jmp = matchesAt(rom, k, [0x4c, WILD, WILD])
    const to = jmp ? (here & 0xff0000) | le16(jmp, 1) : -1
    if (to >= here + APP_READ.length && to <= here + APP_READ.length + 3) return 'skipped'
  }
  return APP_LEADINS.some(l => matchesAt(rom, hit - l.length, l)) ? 'reached' : null
}

/**
 * MAP16AppTable's four pipe-variant pointers, read where both loaders' LDA.L
 * points; `null` when both loaders jump over their reader, so pipes never cycle.
 */
export function readMap16AppTable(rom: RomFile): Map16Read<number[] | null> {
  const read = scanOnce(rom, 'app', () => scanMap16AppTable(rom))
  return read.ok && read.value ? { ok: true, value: [...read.value] } : read
}

function scanMap16AppTable(rom: RomFile): Map16Read<number[] | null> {
  const hits = findPattern(rom, APP_READ, 3)
  const named = new Set(hits.map(at => le24(rom.readAtFileOffset(at + 15, 3)!, 0)))
  if (hits.length !== 2 || named.size !== 1) {
    return refuse('the two MAP16AppTable readers are not both present and in agreement')
  }
  const paths = new Set(hits.map(at => appReaderPath(rom, at)))
  if (paths.size === 1 && paths.has('skipped')) return { ok: true, value: null }
  if (paths.size !== 1 || !paths.has('reached')) {
    return refuse('the MAP16AppTable readers are neither both reached nor both jumped over')
  }
  const bank = readMap16Bank(rom)
  if (!bank.ok) return bank
  if (
    (bank.value.extent ?? MAP16_TOTAL_TILES) <
    PIPE_VARIANT_TILE_START + PIPE_VARIANT_TILE_COUNT
  ) {
    return refuse('the pipe tiles lie past the Map16 table extent')
  }
  const table = rom.readAt([...named][0]!, 8)
  if (!table) return refuse('MAP16AppTable cannot be read')
  return { ok: true, value: [0, 2, 4, 6].map(i => bank.value.bank | le16(table, i)) }
}

/**
 * Redirect tiles `$133..$13A` through `appTable[variantIdx]`, as CODE_0580BD /
 * CODE_05877E do per screen.
 */
export function applyPipePaletteVariant(
  pointers: number[],
  appTable: readonly number[],
  variantIdx: number,
): void {
  const base = appTable[variantIdx & 0x03]!
  for (let i = 0; i < PIPE_VARIANT_TILE_COUNT; i++) {
    pointers[PIPE_VARIANT_TILE_START + i] = base + i * MAP16_TILE_BYTES
  }
}

/** The tiles a pointer table names, in id order. */
export function loadMap16Tiles(rom: RomFile, pointers: readonly number[]): Map16Tile[] {
  return pointers.map((addr, i) => readTileAt(rom, addr, i))
}

/**
 * All Map16 tiles for a tileset. With `pipeVariantIdx`, tiles `$133..$13A`
 * take that MAP16AppTable variant when the ROM cycles pipes at all.
 */
export function loadAllMap16(rom: RomFile, tileset = 0, pipeVariantIdx?: number): Map16Tile[] {
  const pointers = buildMap16PointerTable(rom, tileset)
  if (pipeVariantIdx !== undefined) {
    const appTable = orThrow(readMap16AppTable(rom))
    if (appTable) applyPipePaletteVariant(pointers, appTable, pipeVariantIdx)
  }
  return loadMap16Tiles(rom, pointers)
}

/** The tileset's table plus the pipe-variant blocks, none when the ROM does not cycle pipes. */
export function loadMap16WithPipeVariants(
  rom: RomFile,
  tileset: number,
): {
  tiles: Map16Tile[]
  pipeVariants: Map16Tile[][]
} {
  const tiles = loadMap16Tiles(rom, buildMap16PointerTable(rom, tileset))
  const pipeVariants = (orThrow(readMap16AppTable(rom)) ?? []).map(base =>
    Array.from({ length: PIPE_VARIANT_TILE_COUNT }, (_, i) =>
      readTileAt(rom, base + i * MAP16_TILE_BYTES, PIPE_VARIANT_TILE_START + i),
    ),
  )
  return { tiles, pipeVariants }
}

/**
 * Load a single Map16 tile by ID, using the pointer table for the given tileset.
 */
export function loadMap16Tile(rom: RomFile, tileId: number, tileset = 0): Map16Tile {
  const pointers = buildMap16PointerTable(rom, tileset)
  if (tileId < 0 || tileId >= pointers.length) {
    return {
      id: tileId,
      tl: EMPTY_SUBTILE,
      tr: EMPTY_SUBTILE,
      bl: EMPTY_SUBTILE,
      br: EMPTY_SUBTILE,
    }
  }
  return readTileAt(rom, pointers[tileId]!, tileId)
}

/** CODE_058126's closing fill loop, bank_05.asm:225-240, through its PLP / RTS. */
// prettier-ignore
const BG_FILL: BytePattern = [
  0xc2, 0x20, 0xa9, WILD, WILD, 0x85, 0x00, 0xa2, 0x00, 0x00, 0xa5, 0x00, 0x9d, 0xbe, 0x0f, 0xa5,
  0x00, 0x18, 0x69, WILD, WILD, 0x85, 0x00, 0xe8, 0xe8, 0xe0, WILD, WILD, 0xd0, 0xec, 0x28, 0x60,
]
/**
 * The level loader's `JSR CODE_058126`, bank_05.asm:52-55. Hack-fragility point:
 * a Lunar Magic `JML` at $05803B decides whether it runs, and is not traced.
 */
const BG_CALL: BytePattern = [0xa2, 0x00, 0xb9, 0x86, 0x0d, 0xc2, 0x20, 0x20, WILD, WILD]

/**
 * The L2 (background) table: base, stride and count from the fill loop's
 * operands, reached from the level loader. bank_0C holds a credits copy of
 * the loop that ends in a bare RTS, which the PLP here excludes.
 */
export function readL2Map16Table(rom: RomFile): Map16Read<number[]> {
  const table = scanOnce(rom, 'l2', () => scanL2Map16Table(rom))
  return table.ok ? { ok: true, value: [...table.value] } : table
}

function scanL2Map16Table(rom: RomFile): Map16Read<number[]> {
  const loop = findUnique(rom, BG_FILL)
  if (loop === null) return refuse('the L2 (background) Map16 fill loop is not found exactly once')
  const loopSnes = loromFromOffset(loop)!
  // A JSR stays in its own bank; its target opens with the PHP the loop's PLP closes.
  const calls = findPattern(rom, BG_CALL).filter(at => {
    const from = loromFromOffset(at)
    if (from === null || from >> 16 !== loopSnes >> 16) return false
    const target = (from & 0xff0000) | le16(rom.readAtFileOffset(at + 8, 2)!, 0)
    const entry = loromToOffset(target, rom.romSize)
    return entry !== null && entry < loop && matchesAt(rom, entry, [0x08]) !== null
  })
  if (calls.length !== 1) {
    return refuse(
      'no single level-load JSR reaches the routine holding the L2 (background) fill loop',
    )
  }
  const bank = readMap16Bank(rom)
  if (!bank.ok) return bank
  const code = rom.readAtFileOffset(loop, BG_FILL.length)!
  const bound = le16(code, 26)
  if (bound === 0 || bound % 2 !== 0)
    return refuse('the L2 (background) fill loop bound is not a pointer count')
  // The loop fills Map16Pointers, a 1024-byte WRAM array (SMWDisX rammap.asm:1443).
  if (bound / 2 > MAP16_TOTAL_TILES) {
    return refuse(
      `the L2 (background) fill loop bound ${bound / 2} exceeds the ${MAP16_TOTAL_TILES} entries Map16Pointers holds`,
    )
  }
  const [base, stride] = [le16(code, 3), le16(code, 19)]
  const pointers = Array.from(
    { length: Math.min(bound / 2, bank.value.extent ?? bound / 2) },
    (_, i) => bank.value.bank | ((base + i * stride) & 0xffff),
  )
  return { ok: true, value: pointers }
}

/** Reference-era adapter over `readL2Map16Table`: throws where it declines. */
export function loadAllMap16BG(rom: RomFile): Map16Tile[] {
  return loadMap16Tiles(rom, orThrow(readL2Map16Table(rom)))
}

/**
 * How many tiles this ROM's FOREGROUND Map16 holds, or the reason it
 * cannot be said.
 *
 * The count is READ (`readMap16TileCount` walks the fill loop's `CPX`
 * immediate, bank_05.asm:229-237), never assumed. A ROM that does not say
 * is unavailable, not vanilla. A ROM that says MORE than the loader here
 * can walk is also unavailable: `readMap16Table` builds at most 512 entries,
 * so showing those for a 2048-tile table would be the silent truncation
 * en-gen/hackbench#41 exists to prevent. L1 (foreground) only.
 */
export function map16TileCapacity(rom: RomFile): { count: number } | { reason: string } {
  const count = readMap16TileCount(rom)
  if (count === null) {
    return {
      reason:
        "This ROM's Map16 pointer-fill loop could not be resolved, so how many tiles it holds is unknown. The view will not guess at 512.",
    }
  }
  if (count > MAP16_TOTAL_TILES) {
    return {
      reason: `This ROM's Map16 holds ${count} tiles, more than the ${MAP16_TOTAL_TILES} this view can read. Showing the first ${MAP16_TOTAL_TILES} would hide the rest, so nothing is shown. Expanded Map16 is tracked as en-gen/hackbench#41.`,
    }
  }
  return { count }
}
