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
import { BytePattern, WILD, findPattern, matchesBytes } from './BytePattern'
import { LOROM_BANK_SIZE, formatAddr, loromFromOffset, loromToOffset } from './addressing'
import { parseStream } from './LcLz2'
import {
  FAST_LCLZ2,
  type DecompressorKind,
  type FastRoutine,
  jslTarget,
  preludeKey,
  readDecompressor,
  replacedReason,
} from './GfxDecompressor'
import { fingerprint } from './Fingerprint'
import { branchTarget } from './dispatch/DispatchChain'

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

export interface GfxPointerSites {
  /** SNES addresses of the three split pointer tables. */
  lo: number
  hi: number
  bank: number
  /** SNES address the routine calls to decompress. */
  decompressorEntry: number
  /** What that entry's prelude XORs into each pointer's low word; 0 without one. */
  key: number
  /** True when the level loader reaches the tables through the ExGFX hook,
   *  which also chooses each level's files from a list this tool does not read. */
  hooked: boolean
}

export type CompressionCheck =
  { ok: true; sites: GfxPointerSites; kind: DecompressorKind } | { ok: false; reason: string }
type SitesCheck = { ok: true; sites: GfxPointerSites } | { ok: false; reason: string }

/** JSL PrepareGraphicsFile in UploadGFXFile: the level FG/BG loader
 *  (bank_00.asm:5402) and its post-special-world variant (bank_00.asm:5408).
 *  Only the first drives acceptance below. */
export const LEVEL_GFX_CALLERS = [0x00aa6b, 0x00aa7a]

/**
 * Lunar Magic's ExGFX hook. Its entry branches on the caller's JSR return
 * byte: $0A, the sprite GFX loop (bank_00.asm:5349), and $4B, the FG/BG loop
 * (5381), each pick files per level. Any other caller takes the default BRA
 * straight to the loader, which is the path walked here: it proves which
 * tables a file NUMBER resolves through, not which file a level loads.
 */
// prettier-ignore
const HOOK_ENTRY: BytePattern = [
  0xa3, 0x04, 0xc9, 0x0a, 0xf0, WILD, 0xc9, 0x4b, 0xf0, 0x03, 0x98, 0x80, WILD,
]
const HOOK_BRA = 11
/** Where the entry's BRA lands: JSR to the build's loader, then RTL. */
const HOOK_CALL: BytePattern = [0x20, WILD, WILD, 0x6b]
/** Newer builds' loader: the $7EAD00 output buffer, the file number widened
 *  to 16 bits, and a JSL to the dispatcher. */
// prettier-ignore
const HOOK_STUB: BytePattern = [
  0xeb, 0x64, 0x00, 0xa9, 0xad, 0x85, 0x01, 0xa9, 0x7e, 0x85, 0x02,
  0xa9, 0x00, 0xeb, 0x22, WILD, WILD, WILD, 0x60,
]
const HOOK_STUB_JSL = 15
/** The older build's loader: a file below $7F goes to PrepareGraphicsFile by
 *  JSL, then a BRA to its PLP/PLY/PLX/RTS exit. */
// prettier-ignore
const HOOK_DIRECT: BytePattern = [
  0xda, 0x5a, 0x08, 0xc2, 0x30, 0x29, 0xff, 0x00, 0xc9, 0x7f, 0x00, 0xf0, WILD,
  0xc9, 0x80, 0x00, 0xb0, WILD, 0xa8, 0xe2, 0x30, 0x22, WILD, WILD, WILD, 0x80, WILD,
]
const HOOK_DIRECT_JSL = 22
const HOOK_DIRECT_BRA = 25
const HOOK_DIRECT_EXIT: BytePattern = [0x28, 0x7a, 0xfa, 0x60]

/**
 * The newer builds' dispatcher, fingerprinted from its entry through its
 * return: a file below $7F reads the three GFX tables by long address and
 * JMLs onto PrepareGraphicsFile's JSR to the decompressor. Masked: the table
 * operands, the extended-GFX pointers (files $100 and up, which vary per
 * ROM) and the JML, all read or checked separately. Bank bit 7 of the other
 * long operands is folded, so the FastROM form hashes the same.
 */
const DISPATCHER_LENGTH = 0x6f
const DISPATCHER_TABLES = [0x18, 0x1e, 0x24]
const DISPATCHER_JML = 0x63
const DISPATCHER_MASKED = [...DISPATCHER_TABLES, 0x37, 0x3d, DISPATCHER_JML]
/** Bank bytes of the two reads for files $80-$FF. */
const DISPATCHER_FOLDED = [0x51, 0x57]
/** The hook's JML lands on PrepareGraphicsFile's JSR to the decompressor. */
const HOOK_JSR_INSTRUCTION_OFFSET = OFF_JSR_TARGET - 1

export function dispatcherFingerprint(rom: RomFile, at: number): string | null {
  const bytes = rom.readAt(at, DISPATCHER_LENGTH)
  if (!bytes) return null
  const masked = Buffer.from(bytes)
  for (const off of DISPATCHER_MASKED) masked.fill(0, off, off + 3)
  for (const off of DISPATCHER_FOLDED) masked[off]! &= 0x7f
  return fingerprint(masked)
}

/** Dispatcher builds this tool recognizes, measured on the hack store. A
 *  parameter below so a synthetic plant's own fingerprint can stand in. */
export const DISPATCHER_FINGERPRINTS: readonly string[] = [
  '6a68ae67d6ee8b6978acfe37f81eb7e89a047c0033c97324bba347e8e63f340c',
]

const long = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) & 0x7fffff

export interface GfxTables {
  lo: number
  hi: number
  bank: number
}

/**
 * Walk the hook at `entry` to the table reads a stock file number reaches,
 * given the matched PrepareGraphicsFile at `prepareGfx` and the tables it
 * names. A dispatcher naming other tables is refused: the stock callers that
 * JSL PrepareGraphicsFile directly would read different files, and a save
 * could keep only one set current.
 */
export function readLevelGfxHook(
  rom: RomFile,
  entry: number,
  prepareGfx: number,
  tables: GfxTables,
  fingerprints: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
  const head = rom.readAt(entry, HOOK_ENTRY.length)
  if (!head || !matchesBytes(head, HOOK_ENTRY)) {
    return refuse('its entry is not the recognized ExGFX hook')
  }
  const landing = branchTarget(head[HOOK_BRA + 1]!, entry + HOOK_BRA)
  const call = rom.readAt(landing, HOOK_CALL.length)
  if (!call || !matchesBytes(call, HOOK_CALL)) {
    return refuse(`its default path at ${formatAddr(landing)} is not a JSR and RTL`)
  }
  const loader = (entry & 0xff0000) | call[1]! | (call[2]! << 8)
  const code = rom.readAt(loader, HOOK_DIRECT.length)
  if (code && matchesBytes(code, HOOK_DIRECT)) {
    const exitAt = branchTarget(code[HOOK_DIRECT_BRA + 1]!, loader + HOOK_DIRECT_BRA)
    const exit = rom.readAt(exitAt, HOOK_DIRECT_EXIT.length)
    if (long(code, HOOK_DIRECT_JSL) !== prepareGfx || !matchesBytes(exit, HOOK_DIRECT_EXIT)) {
      return refuse(`its loader at ${formatAddr(loader)} does not call PrepareGraphicsFile`)
    }
    return { ok: true }
  }
  if (!code || !matchesBytes(code, HOOK_STUB)) {
    return refuse(`its loader at ${formatAddr(loader)} is not a recognized build`)
  }
  const dispatcher = long(code, HOOK_STUB_JSL)
  const d = rom.readAt(dispatcher, DISPATCHER_LENGTH)
  const fp = dispatcherFingerprint(rom, dispatcher)
  if (!d || fp === null || !fingerprints.includes(fp)) {
    return refuse(`its dispatcher at ${formatAddr(dispatcher)} is not a recognized build`)
  }
  if (long(d, DISPATCHER_JML) !== prepareGfx + HOOK_JSR_INSTRUCTION_OFFSET) {
    return refuse("its dispatcher does not reach PrepareGraphicsFile's decompression call")
  }
  const read = DISPATCHER_TABLES.map(o => long(d, o))
  if (read[0] !== tables.lo || read[1] !== tables.hi || read[2] !== tables.bank) {
    return refuse(
      `its dispatcher reads GFX tables at ${read.map(formatAddr).join(', ')}, ` +
        "not PrepareGraphicsFile's own",
    )
  }
  return { ok: true }
}

/** The pointer tables and decompression call this cartridge actually uses,
 *  or null when PrepareGraphicsFile cannot be resolved to exactly one site. */
export function readGfxPointerSites(
  rom: RomFile,
  fingerprints: readonly string[] = DISPATCHER_FINGERPRINTS,
): GfxPointerSites | null {
  const r = resolveGfxPointerSites(rom, fingerprints)
  return r.ok ? r.sites : null
}

/** As `readGfxPointerSites`, but keeps the reason a caller can surface. */
function resolveGfxPointerSites(rom: RomFile, fingerprints: readonly string[]): SitesCheck {
  const unresolved = 'PrepareGraphicsFile does not resolve to exactly one site on this ROM'
  const hits = findPattern(rom, PREPARE_GFX_PATTERN, 2)
  if (hits.length !== 1) return { ok: false, reason: unresolved }
  const site = rom.readAtFileOffset(hits[0]!, PREPARE_GFX_PATTERN.length)
  const matched = loromFromOffset(hits[0]!)
  if (!site || matched === null) return { ok: false, reason: unresolved }
  // PHK/PLB (bank_00.asm:6574-6575) sets the data bank for the three table
  // reads; the JSR target resolves in the program bank, the same bank here.
  const bank = matched & 0xff0000
  const word = (off: number): number => bank | site[off]! | (site[off + 1]! << 8)
  const tables = { lo: word(OFF_TABLE_LO), hi: word(OFF_TABLE_HI), bank: word(OFF_TABLE_BANK) }
  // The gap between the three tables IS the file count, and the cart states
  // it. Refuse when it disagrees with GFX_FILE_COUNT rather than writing 50
  // pointers into a table sized for something else: too few leaves the tail
  // pointing at data the repack overwrote, too many spills into the next
  // table. Both are silent, and both corrupt a cartridge that still loads.
  if (tables.hi - tables.lo !== GFX_FILE_COUNT || tables.bank - tables.hi !== GFX_FILE_COUNT)
    return { ok: false, reason: unresolved }
  const primary = LEVEL_GFX_CALLERS[0]!
  const target = jslTarget(rom, primary)
  const hook =
    target === null || target === matched
      ? null
      : readLevelGfxHook(rom, target, matched, tables, fingerprints)
  if (target === null || (hook && !hook.ok)) {
    return {
      ok: false,
      reason:
        `the level GFX loader's call at ${formatAddr(primary)} targets ` +
        `${target === null ? 'something that is not a JSL' : formatAddr(target)}, ` +
        'not PrepareGraphicsFile or its recognized hook' +
        (hook && !hook.ok ? `: ${hook.reason}` : ''),
    }
  }
  const decompressorEntry = word(OFF_JSR_TARGET)
  const key = preludeKey(rom, decompressorEntry)
  if (key === null)
    return { ok: false, reason: replacedReason(decompressorEntry, 'an unrecognized entry') }
  return { ok: true, sites: { ...tables, decompressorEntry, key, hooked: hook !== null } }
}

/** The SNES address the pointer tables give file `index`, key applied, or null. */
export function gfxFileAddress(rom: RomFile, sites: GfxPointerSites, index: number): number | null {
  const lo = rom.readByte(sites.lo + index)
  const hi = rom.readByte(sites.hi + index)
  const bank = rom.readByte(sites.bank + index)
  return lo === null || hi === null || bank === null
    ? null
    : ((bank << 16) | (hi << 8) | lo) ^ sites.key
}

/**
 * Is this cartridge still decompressing GFX the way we are about to encode
 * them?
 *
 * Verifies the PATH as well as the destination: a pristine decompressor that
 * nothing calls is not a decompressor that runs, and the caller is checked
 * first because that is where the entry address comes from.
 */
export function checkStockCompression(
  rom: RomFile,
  fast: readonly FastRoutine[] = FAST_LCLZ2,
): CompressionCheck {
  const resolved = resolveGfxPointerSites(rom, DISPATCHER_FINGERPRINTS)
  if (!resolved.ok) return resolved
  const d = readDecompressor(rom, resolved.sites.decompressorEntry, fast)
  return d.ok ? { ok: true, sites: resolved.sites, kind: d.kind } : d
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
    // Stored the way the prelude reads them, or the ROM loads the wrong file.
    const snes = loromFromOffset(placed.get(i)!)! ^ sites.key
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
