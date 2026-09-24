/**
 * Where the cartridge keeps its 50 GFX files, and what it costs to put them
 * back somewhere else.
 *
 * The files are LC_LZ2 streams packed with no gaps, so editing one changes
 * how compressible it is, changes its length, and moves every file behind
 * it. There is nowhere for a longer stream to go, so a save relays the whole
 * region and rewrites the 150 pointer bytes. On vanilla that region runs
 * $0459F9..$05FD0D in file offsets (107,284 bytes) with 755 bytes of $FF
 * behind it, which SMWDisX freespace.txt:138-140 lists as free space
 * ($0BFD0D..$0BFFFF, $2F3 bytes, U cart). Headroom is 0.70%. Evidence scope
 * for the layout figures: 6 cartridges, one machine, throwaway probe.
 *
 * Nothing here is hardcoded that the cartridge can tell us. The three
 * pointer tables and the decompressor entry are READ out of
 * PrepareGraphicsFile's own operands (bank_00.asm:6571-6591), so a hack that
 * relocates them is still readable and a hack that replaced them is refused
 * rather than written over.
 *
 * OFFSET FRAME. Everything in this module, `ArenaWrite.offset` included, is
 * CART-RELATIVE: the copier header is excluded. That is the frame
 * `RomFile.readAtFileOffset` takes (it adds the header itself), the frame
 * `findPattern` returns, and the frame `loromFromOffset` inverts, so
 * `loromToOffset` is called here with TWO arguments and must stay that way.
 * Passing `hasHeader` as its third would add the header to a number that is
 * then handed to `readAtFileOffset`, which adds it again: every read a
 * header late, and every pointer-table write address a header high, which
 * is a silent write over whatever lives there. A caller that indexes the
 * raw file bytes directly works in the other frame, buffer-absolute, and
 * must add the header itself; the two are never mixed.
 * test/suite/unit/GfxArena.header.test.ts plants the mistake and proves the
 * headered and headerless twins diverge under it.
 */
import { RomFile } from './RomFile'
import { BytePattern, WILD, findPattern } from './BytePattern'
import { LOROM_BANK_SIZE, loromFromOffset, loromToOffset } from './addressing'
import { parseStream } from './LcLz2'

/**
 * $00B9C4 - $00B992 on a stock cart (bank_00.asm:6415,6467).
 *
 * The gap between the low and high tables IS the count, but this constant
 * does not compute it: it is the stock value, used as the loop bound. A
 * cart that relocated the tables to a different spacing would need
 * `readGfxPointerSites`'s resolved `hi - lo` instead. Measured on the
 * 6-ROM corpus, all 6 hold 50, so nothing here exercises the difference.
 */
export const GFX_FILE_COUNT = 50

/**
 * PrepareGraphicsFile, pinned by its instructions rather than its address
 * (bank_00.asm:6571-6591). The wildcards are the three table operands, the
 * direct-page slots and the JSR target, which is everything we are here to
 * read. Two matches would mean we cannot say which routine runs, so the
 * caller treats anything but one hit as unavailable.
 */
/**
 * Exported so a planted-defect sweep can derive its exclusion list from the
 * wildcards themselves. A hand-maintained list drifts: this one carried
 * three positions the pattern matches LITERALLY, so the sweep skipped three
 * load-bearing bytes it was meant to prove.
 */
export const PREPARE_GFX_PATTERN: BytePattern = [
  0x8b,
  0x5a,
  0x4b,
  0xab, // PHB PHY PHK PLB
  0xb9,
  WILD,
  WILD,
  0x85,
  WILD, // LDA GFXFilesLow,Y  / STA GraphicsCompPtr
  0xb9,
  WILD,
  WILD,
  0x85,
  WILD, // LDA GFXFilesHigh,Y / STA +1
  0xb9,
  WILD,
  WILD,
  0x85,
  WILD, // LDA GFXFilesBank,Y / STA +2
  0xa9,
  0x00,
  0x85,
  WILD, // LDA #$00 / STA _0
  0xa9,
  0xad,
  0x85,
  WILD, // LDA #$AD / STA _1
  0xa9,
  0x7e,
  0x85,
  WILD, // LDA #$7E / STA _2   -> output buffer $7EAD00
  0x20,
  WILD,
  WILD, // JSR the decompressor
  0x7a,
  0xab,
  0x6b, // PLY PLB RTL
]
const OFF_TABLE_LO = 5
const OFF_TABLE_HI = 10
const OFF_TABLE_BANK = 15
const OFF_JSR_TARGET = 32

/**
 * The first ten bytes of the stock LC_LZ2 entry (CODE_00B8DE,
 * bank_00.asm:6294-6300): REP #$10 / LDY #$0000 / JSR ReadByte / CMP #$FF.
 * Kept as a documented cross-check of what we read, never as a default to
 * fall back to. Invictus 1.0 holds two JSLs and an RTS here instead, so
 * control never reaches the stock loop and an LC_LZ2 stream written to that
 * cart would corrupt it while the editor reported success.
 */
export const STOCK_LCLZ2_ENTRY: readonly number[] = [
  0xc2, 0x10, 0xa0, 0x00, 0x00, 0x20, 0x83, 0xb9, 0xc9, 0xff,
]

export interface GfxPointerSites {
  /** SNES addresses of the three split pointer tables. */
  lo: number
  hi: number
  bank: number
  /** Bank-0 address the routine calls to decompress. */
  decompressorEntry: number
}

/** The pointer tables and decompression call this cartridge actually uses,
 *  or null when PrepareGraphicsFile cannot be resolved to exactly one site. */
export function readGfxPointerSites(rom: RomFile): GfxPointerSites | null {
  const hits = findPattern(rom, PREPARE_GFX_PATTERN, 2)
  if (hits.length !== 1) return null
  const site = rom.readAtFileOffset(hits[0]!, PREPARE_GFX_PATTERN.length)
  if (!site) return null
  const word = (off: number): number => site[off]! | (site[off + 1]! << 8)
  const lo = word(OFF_TABLE_LO)
  const hi = word(OFF_TABLE_HI)
  const bank = word(OFF_TABLE_BANK)
  // The gap between the three tables IS the file count, and the cart states
  // it. Refuse when it disagrees with GFX_FILE_COUNT rather than writing 50
  // pointers into a table sized for something else: too few leaves the tail
  // pointing at data the repack overwrote, too many spills into the next
  // table. Both are silent, and both corrupt a cartridge that still loads.
  if (hi - lo !== GFX_FILE_COUNT || bank - hi !== GFX_FILE_COUNT) return null
  return {
    lo,
    hi,
    bank,
    decompressorEntry: word(OFF_JSR_TARGET),
  }
}

export type CompressionCheck = { ok: true; sites: GfxPointerSites } | { ok: false; reason: string }

/** The SNES address the pointer tables give file `index`, or null. */
export function gfxFileAddress(rom: RomFile, sites: GfxPointerSites, index: number): number | null {
  const lo = rom.readByte(sites.lo + index)
  const hi = rom.readByte(sites.hi + index)
  const bank = rom.readByte(sites.bank + index)
  return lo === null || hi === null || bank === null ? null : (bank << 16) | (hi << 8) | lo
}

/**
 * Is this cartridge still decompressing GFX the way we are about to encode
 * them?
 *
 * Verifies the PATH as well as the destination: a pristine decompressor that
 * nothing calls is not a decompressor that runs, and the caller is checked
 * first because that is where the entry address comes from.
 */
export function checkStockCompression(rom: RomFile): CompressionCheck {
  const sites = readGfxPointerSites(rom)
  if (!sites) {
    return {
      ok: false,
      reason:
        'PrepareGraphicsFile does not resolve to exactly one site on this ROM, ' +
        'so there is no readable path to the decompressor',
    }
  }
  const entry = rom.readAt(sites.decompressorEntry, STOCK_LCLZ2_ENTRY.length)
  if (!entry) {
    return { ok: false, reason: `the decompressor entry does not resolve to ROM data` }
  }
  for (let i = 0; i < STOCK_LCLZ2_ENTRY.length; i++) {
    if (entry[i] !== STOCK_LCLZ2_ENTRY[i]) {
      return {
        ok: false,
        reason:
          'this ROM has replaced the LC_LZ2 decompressor, so its GFX are not ' +
          'LC_LZ2 streams this editor can read or write',
      }
    }
  }
  return { ok: true, sites }
}

export interface GfxFileExtent {
  index: number
  /** SNES address the pointer tables name. */
  snesAddr: number
  /** Cart-relative file offset, or null when the pointer resolves nowhere. */
  offset: number | null
  /** Compressed bytes, terminator included. Zero when unresolved. */
  byteLength: number
  /** Decompressed bytes this stream produces. */
  outputLength: number
  /** False when the stream ran off the cart or used a command SMW ignores. */
  terminated: boolean
}

/** Where each of the 50 files sits and how big it is, as the cartridge says. */
export function readGfxFileTable(rom: RomFile): GfxFileExtent[] {
  const sites = readGfxPointerSites(rom)
  const files: GfxFileExtent[] = []
  for (let index = 0; index < GFX_FILE_COUNT; index++) {
    if (!sites) {
      files.push({
        index,
        snesAddr: 0,
        offset: null,
        byteLength: 0,
        outputLength: 0,
        terminated: false,
      })
      continue
    }
    const snesAddr = gfxFileAddress(rom, sites, index) ?? 0
    const offset = loromToOffset(snesAddr, rom.romSize) // cart-relative; see OFFSET FRAME
    if (offset === null) {
      files.push({
        index,
        snesAddr,
        offset: null,
        byteLength: 0,
        outputLength: 0,
        terminated: false,
      })
      continue
    }
    const tail = rom.readAtFileOffset(offset, rom.romSize - offset)!
    const s = parseStream(tail)
    files.push({
      index,
      snesAddr,
      offset,
      byteLength: s.byteLength,
      outputLength: s.outputLength,
      terminated: s.terminated,
    })
  }
  return files
}

export interface GfxRegion {
  /** File indices stored here, in cart order. */
  files: number[]
  start: number
  /** Bytes the files occupy today. */
  used: number
  /** `used` plus the trailing $FF run, stopped at the bank boundary. */
  capacity: number
}

/**
 * Group the files into the blocks they are actually packed in.
 *
 * A region is a maximal chain of streams that abut exactly. Vanilla has one
 * of 50; Grand Poo World has one of 47 plus three files the hack placed
 * elsewhere, and those keep their own locations rather than being gathered
 * in. Files sharing an offset are aliases of one block and move together.
 *
 * Capacity stops at the LoROM bank boundary. A longer run of $FF is not
 * evidence that nothing else owns it, and claiming it would be a guess
 * dressed as a measurement; #446 is the sanctioned way to get more room.
 */
export function planRegions(rom: RomFile, table: readonly GfxFileExtent[]): GfxRegion[] {
  const blocks = new Map<number, number[]>()
  for (const f of table) {
    if (f.offset === null || !f.terminated) continue
    const at = blocks.get(f.offset)
    if (at) at.push(f.index)
    else blocks.set(f.offset, [f.index])
  }
  const byOffset = [...blocks.keys()].sort((a, b) => a - b)
  const lengthAt = new Map(table.filter(f => f.offset !== null).map(f => [f.offset!, f.byteLength]))

  const regions: GfxRegion[] = []
  let current: GfxRegion | null = null
  for (const offset of byOffset) {
    const len = lengthAt.get(offset)!
    if (current && current.start + current.used === offset) {
      current.files.push(...blocks.get(offset)!)
      current.used += len
    } else {
      current = { files: [...blocks.get(offset)!], start: offset, used: len, capacity: 0 }
      regions.push(current)
    }
  }
  for (const r of regions) r.capacity = r.used + fillerAfter(rom, r.start + r.used)
  return regions
}

function fillerAfter(rom: RomFile, end: number): number {
  const boundary = Math.min(Math.ceil(end / LOROM_BANK_SIZE) * LOROM_BANK_SIZE, rom.romSize)
  const run = rom.readAtFileOffset(end, Math.max(0, boundary - end))
  if (!run) return 0
  let n = 0
  while (n < run.length && run[n] === 0xff) n++
  return n
}

export interface ArenaWrite {
  /** Cart-relative file offset. */
  offset: number
  bytes: Uint8Array
}

export interface ArenaPlan {
  writes: ArenaWrite[]
  regions: { start: number; needed: number; capacity: number }[]
}

export type ArenaResult =
  | { status: 'ok'; plan: ArenaPlan }
  | { status: 'overflow'; overage: number; needed: number; capacity: number; reason: string }
  | { status: 'unavailable'; reason: string }

/**
 * Lay 50 encoded streams back into the regions they came from.
 *
 * Every file is laid out, edited or not, so the result depends only on the
 * streams and not on which of them changed. The reclaimed tail of a region
 * is filled with $FF rather than left holding the old stream's bytes.
 */
export function layoutArena(rom: RomFile, streams: readonly Uint8Array[]): ArenaResult {
  const gate = checkStockCompression(rom)
  if (!gate.ok) return { status: 'unavailable', reason: gate.reason }

  for (let i = 0; i < GFX_FILE_COUNT; i++) {
    if (!streams[i]) {
      return { status: 'unavailable', reason: `no encoded stream for GFX file ${i}` }
    }
  }

  const table = readGfxFileTable(rom)
  const unreadable = table.filter(f => f.offset === null || !f.terminated).map(f => f.index)
  if (unreadable.length > 0) {
    return {
      status: 'unavailable',
      reason: `GFX ${unreadable.join(', ')} cannot be read back from this ROM, so the arena extent is unknown`,
    }
  }

  const sites = readGfxPointerSites(rom)!
  const regions = planRegions(rom, table)
  const placed = new Map<number, number>() // file index to new offset
  const writes: ArenaWrite[] = []
  const summary: ArenaPlan['regions'] = []

  for (const region of regions) {
    const blocks = distinctBlocks(region, table)
    const needed = blocks.reduce((n, b) => n + streams[b[0]!]!.length, 0)
    summary.push({ start: region.start, needed, capacity: region.capacity })
    if (needed > region.capacity) {
      return {
        status: 'overflow',
        overage: needed - region.capacity,
        needed,
        capacity: region.capacity,
        reason:
          `the repacked graphics need ${needed} bytes where the ROM has ${region.capacity}, ` +
          `${needed - region.capacity} too many. Making room needs ROM expansion, ` +
          'en-gen/hackbench#446, which this build does not do.',
      }
    }

    const bytes = new Uint8Array(Math.max(needed, region.used)).fill(0xff)
    let at = 0
    for (const block of blocks) {
      const stream = streams[block[0]!]!
      // Aliases share one block, so only the first stream is written and the
      // rest are repointed at it. If an edit reached one alias and not its
      // twins, writing the first silently discards that edit and reports
      // success. Refuse instead: the caller has to decide whether the change
      // was meant for every file sharing the block.
      const diverged = block.filter(i => !sameBytes(streams[i]!, stream))
      if (diverged.length > 0) {
        return {
          status: 'unavailable',
          reason:
            `GFX ${block.join(', ')} share one block on this ROM, so they cannot hold ` +
            `different graphics, but ${diverged.join(', ')} differ from ${block[0]} after this ` +
            'edit. Editing one would change all of them, so this save is refused rather than ' +
            'dropping the change.',
        }
      }
      bytes.set(stream, at)
      for (const index of block) placed.set(index, region.start + at)
      at += stream.length
    }
    writes.push({ offset: region.start, bytes })
  }

  writes.push(...pointerWrites(rom, sites, placed))
  return { status: 'ok', plan: { writes, regions: summary } }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** File indices grouped by the block they share, in cart order. Aliases of
 *  one block are written once and repointed together. */
function distinctBlocks(region: GfxRegion, table: readonly GfxFileExtent[]): number[][] {
  const byOffset = new Map<number, number[]>()
  for (const index of region.files) {
    const offset = table[index]!.offset!
    const at = byOffset.get(offset)
    if (at) at.push(index)
    else byOffset.set(offset, [index])
  }
  return [...byOffset.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1])
}

/** The 150 pointer bytes, one write per table. */
function pointerWrites(
  rom: RomFile,
  sites: GfxPointerSites,
  placed: ReadonlyMap<number, number>,
): ArenaWrite[] {
  const lo = new Uint8Array(GFX_FILE_COUNT)
  const hi = new Uint8Array(GFX_FILE_COUNT)
  const bank = new Uint8Array(GFX_FILE_COUNT)
  for (let i = 0; i < GFX_FILE_COUNT; i++) {
    const snes = loromFromOffset(placed.get(i)!)!
    lo[i] = snes & 0xff
    hi[i] = (snes >> 8) & 0xff
    bank[i] = (snes >> 16) & 0xff
  }
  // Cart-relative, per OFFSET FRAME. These three are addresses to WRITE to,
  // so a frame error here is not a bad read, it is 150 bytes over whatever
  // sits a copier header away, with no refusal to notice it.
  return [
    { offset: loromToOffset(sites.lo, rom.romSize)!, bytes: lo },
    { offset: loromToOffset(sites.hi, rom.romSize)!, bytes: hi },
    { offset: loromToOffset(sites.bank, rom.romSize)!, bytes: bank },
  ]
}
