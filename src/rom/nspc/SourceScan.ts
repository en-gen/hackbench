/**
 * From a foreign ROM's bytes to sound-RAM images, each with its driver
 * located and its songs enumerated.
 *
 * 1. Find the driver's code in the ROM by its byte pattern, and the upload
 *    chain whose first block holds it.
 * 2. From the located driver, read where it expects its song table and its
 *    sample directory.
 * 3. Any chain whose first block writes those addresses is a candidate song
 *    bank or sample set, kept only if its contents parse as songs (or
 *    samples). A bank of random bytes does not survive the song parser.
 *
 * Each song bank becomes its own image. Which bank a game loads when is game
 * flow, not something a static read can know, so every bank is listed.
 */
import { detectHeader, HeaderResult, stripCopierHeader } from './RomHeader'
import {
  applyChain,
  chainsHolding,
  chainsWriting,
  indexChainStarts,
  parseChain,
  UploadChain,
} from './UploadChains'
import { findAll, locateEngine, NspcEngine, SECTION_POINTER_PATTERN } from './NspcEngine'
import { parseSong, NspcSong } from './NspcSong'
import { readSample } from './Brr'

export interface SoundImage {
  aram: Uint8Array
  /** 1 where an upload wrote the byte. Reading anything else is reading RAM the game never filled. */
  written: Uint8Array
  engine: NspcEngine
  /** The driver chain's terminator dest: where the boot upload jumps. */
  entry: number
  /** Human label: which chains built this image. */
  label: string
}

export interface ScannedSong {
  command: number
  image: SoundImage
  song: NspcSong
}

export interface UnavailableSong {
  command: number
  image: SoundImage
  reason: string
}

export interface ScanResult {
  header: HeaderResult
  /** The chains the images were built from: driver, samples, banks. */
  chains: UploadChain[]
  images: SoundImage[]
  songs: ScannedSong[]
  /** Table entries whose song data could not be read in full, with why. */
  unavailable: UnavailableSong[]
  /** Why nothing (or less than everything) could be read. */
  problems: string[]
}

const ARAM_SIZE = 0x10000

const hex = (n: number, w = 4) => '$' + n.toString(16).toUpperCase().padStart(w, '0')

function buildImage(
  rom: Uint8Array,
  chains: UploadChain[],
): { aram: Uint8Array; written: Uint8Array } {
  const aram = new Uint8Array(ARAM_SIZE)
  const written = new Uint8Array(ARAM_SIZE)
  for (const c of chains) {
    applyChain(rom, c, aram)
    for (const b of c.blocks) written.fill(1, b.dest, b.dest + b.size)
  }
  return { aram, written }
}

function makeImage(
  rom: Uint8Array,
  chains: UploadChain[],
  entry: number,
  label: string,
): SoundImage | null {
  const { aram, written } = buildImage(rom, chains)
  const located = locateEngine(aram, written)
  return located.ok ? { aram, written, engine: located.engine, entry, label } : null
}

/**
 * The table has no stored length. It is a contiguous array, so the first
 * entry whose bytes are not a song at all is past its end; later entries
 * that happen to parse are other data read as pointers. A song that is well
 * formed but runs into memory this image never filled is unavailable, not
 * the end: another upload the game makes first may supply it (SMW's credits
 * bank does this).
 */
function enumerate(image: SoundImage): { songs: ScannedSong[]; unavailable: UnavailableSong[] } {
  const { aram, written, engine } = image
  const songs: ScannedSong[] = []
  const unavailable: UnavailableSong[] = []
  const pointers = new Set<number>()
  for (let command = 1; command < 0x80; command++) {
    const at = engine.songTable + command * 2
    if (!written[at] || !written[at + 1]) break
    const ptr = aram[at] | (aram[at + 1] << 8)
    if (pointers.has(ptr)) continue
    pointers.add(ptr)
    const song = parseSong(image, ptr)
    if (song.ok) songs.push({ command, image, song: song.song })
    else if (song.kind === 'unwritten') unavailable.push({ command, image, reason: song.reason })
    else break
  }
  return { songs, unavailable }
}

/**
 * The base image plus more uploads, keeping the base's located driver.
 * Candidates are data, not code; re-locating the driver for each of the
 * thousands a large ROM yields made a full sweep take minutes.
 */
function extend(
  rom: Uint8Array,
  base: SoundImage,
  chains: UploadChain[],
  label: string,
): SoundImage {
  const aram = base.aram.slice()
  const written = base.written.slice()
  for (const c of chains) {
    applyChain(rom, c, aram)
    for (const b of c.blocks) written.fill(1, b.dest, b.dest + b.size)
  }
  return { ...base, aram, written, label }
}

/** Whether any listed song's block list lives in the bank's own upload; otherwise it adds nothing. */
function contributes(image: SoundImage, bank: UploadChain): boolean {
  return enumerate(image).songs.some(s =>
    bank.blocks.some(b => s.song.addr >= b.dest && s.song.addr < b.dest + b.size),
  )
}

function overlaps(a: UploadChain, b: UploadChain): boolean {
  return a.blocks.some(x =>
    b.blocks.some(y => x.dest < y.dest + y.size && y.dest < x.dest + x.size),
  )
}

/** Consecutive directory entries, from 0, that are well-formed samples inside `own`. */
function sampleScore(image: SoundImage, own: UploadChain): number {
  const inOwn = (addr: number) => own.blocks.some(b => addr >= b.dest && addr < b.dest + b.size)
  let n = 0
  for (; n < 256; n++) {
    const sample = readSample(image, n)
    if (typeof sample === 'string' || !inOwn(sample.start)) break
    let ok = true
    for (let i = 0; i < sample.bytes.length; i += 9) if (sample.bytes[i] >> 4 > 12) ok = false
    if (!ok) break
  }
  return n
}

/**
 * Cheap prefilter, read straight from the ROM: the chain's first table entry
 * points into the chain's own blocks. Saves a 64 KB image per random candidate.
 */
function firstEntryInOwnBlocks(rom: Uint8Array, c: UploadChain, table: number): boolean {
  const b0 = c.blocks[0]
  const at = b0.fileOffset + (table - b0.dest)
  const ptr = rom[at] | (rom[at + 1] << 8)
  return c.blocks.some(b => ptr >= b.dest && ptr + 2 <= b.dest + b.size)
}

/** Cheap prefilter, read from the ROM: directory entry 0 starts inside the chain's own blocks. */
function firstSampleInOwnBlocks(rom: Uint8Array, c: UploadChain, dir: number): boolean {
  const b0 = c.blocks[0]
  const at = b0.fileOffset + (dir - b0.dest)
  const start = rom[at] | (rom[at + 1] << 8)
  return c.blocks.some(b => start >= b.dest && start < b.dest + b.size)
}

/** How far before the driver's block a single upload can start; ALTTP's spans $CD00 bytes. */
const UPLOAD_REACH = 0x40000

/**
 * The whole upload the driver's block belongs to. A game may send directory,
 * samples, driver and songs as one chain (ALTTP, file $C8000: directory
 * $3C00 first, the driver at $0800 fourth). A longer chain passing through
 * the driver's block is taken only when its first block starts exactly at
 * the driver's sample directory: a random header that happens to chain into
 * the real one does not also land on that address.
 */
function wholeUpload(
  rom: Uint8Array,
  starts: Uint8Array,
  block: UploadChain,
  dir: number,
): UploadChain {
  const target = block.fileOffset
  for (let at = Math.max(0, target - UPLOAD_REACH); at < target; at++) {
    if (starts[at] !== 2 || (rom[at + 2] | (rom[at + 3] << 8)) !== dir) continue
    let next = at
    while (next < target && starts[next] === 2) next += 4 + (rom[next] | (rom[next + 1] << 8))
    if (next === target) return parseChain(rom, at) ?? block
  }
  return block
}

function chainsAt(rom: Uint8Array, offsets: number[]): UploadChain[] {
  return offsets.map(o => parseChain(rom, o)).filter((c): c is UploadChain => c !== null)
}

interface Evaluation {
  chains: UploadChain[]
  images: SoundImage[]
  songs: ScannedSong[]
  unavailable: UnavailableSong[]
  problems: string[]
}

function evaluateDriver(
  rom: Uint8Array,
  starts: Uint8Array,
  driverBlock: UploadChain,
): Evaluation | null {
  const first = makeImage(rom, [driverBlock], driverBlock.entry, 'base')
  if (!first) return null
  const driver = wholeUpload(rom, starts, driverBlock, first.engine.dir)
  const base = driver === driverBlock ? first : makeImage(rom, [driver], driver.entry, 'base')
  if (!base) return null
  const e = base.engine
  const problems: string[] = []

  // Samples: the driver's own upload may carry the directory; otherwise the
  // chain whose directory describes the most well-formed samples of its own.
  // A candidate may not overwrite the driver, and each sample must start in
  // the candidate's own blocks with valid BRR headers throughout; random
  // bytes pass a looser test (vanilla SMW: a false chain tied the real one).
  let shared: UploadChain[] = []
  if (!base.written[e.dir]) {
    let best: { chain: UploadChain; score: number } | null = null
    const dirChains = chainsAt(rom, chainsWriting(rom, starts, e.dir, e.dir + 4))
    const aligned = dirChains.filter(c => c.blocks[0].dest === e.dir)
    for (const c of aligned.length ? aligned : dirChains) {
      if (overlaps(c, driver) || !firstSampleInOwnBlocks(rom, c, e.dir)) continue
      // A block that starts exactly at the directory is how every real set seen
      // is laid out (SMW: $8000+$50, then the samples); it outranks any count.
      const aligned = c.blocks[0].dest === e.dir ? 1000 : 0
      const score = aligned + sampleScore(extend(rom, base, [c], ''), c)
      if (score > 0 && (!best || score > best.score)) best = { chain: c, score }
    }
    if (best) shared = [best.chain]
    else problems.push(`no upload writes the sample directory at ${hex(e.dir)}`)
  }

  // Song banks: the base itself, then every chain that writes the first table entry.
  const images: SoundImage[] = []
  const withSamples = extend(rom, base, shared, 'base')
  images.push(withSamples)
  const table = e.songTable + 2
  const bankChains: UploadChain[] = []
  for (const c of chainsAt(rom, chainsWriting(rom, starts, table, table + 2))) {
    if (c.fileOffset === driver.fileOffset || !firstEntryInOwnBlocks(rom, c, table)) continue
    const image = extend(rom, withSamples, [c], `bank at file ${hex(c.fileOffset, 6)}`)
    if (contributes(image, c)) {
      images.push(image)
      bankChains.push(c)
    }
  }

  const songs: ScannedSong[] = []
  const unavailable: UnavailableSong[] = []
  const seen = new Set<string>()
  for (const image of images) {
    const r = enumerate(image)
    for (const s of r.songs) {
      // The same song reached through several banks (shared data) is listed once.
      const key = `${s.command}:${s.song.fingerprint}`
      if (seen.has(key)) continue
      seen.add(key)
      songs.push(s)
    }
    unavailable.push(...r.unavailable)
  }
  return { chains: [driver, ...shared, ...bankChains], images, songs, unavailable, problems }
}

export function scanRom(file: Uint8Array): ScanResult {
  const header = detectHeader(file)
  const rom = stripCopierHeader(file)
  const result: ScanResult = {
    header,
    chains: [],
    images: [],
    songs: [],
    unavailable: [],
    problems: [],
  }

  const codeHits = findAll(rom, SECTION_POINTER_PATTERN)
  if (codeHits.length === 0) {
    result.problems.push('no N-SPC driver code in this ROM: another sound engine, or compressed')
    return result
  }

  const starts = indexChainStarts(rom)
  const candidates = codeHits.flatMap(hit => chainsAt(rom, chainsHolding(rom, starts, hit)))
  if (candidates.length === 0) {
    result.problems.push('driver code found, but not inside an upload block this reader recognises')
    return result
  }

  // A random earlier header whose "block" happens to span the driver can pass
  // the chain check too; the candidate whose contents yield songs wins.
  let best: Evaluation | null = null
  for (const c of candidates) {
    const ev = evaluateDriver(rom, starts, c)
    if (ev && (!best || ev.songs.length > best.songs.length)) best = ev
  }
  if (!best) {
    const reason = locateEngine(buildImage(rom, [candidates[0]]).aram)
    result.problems.push(
      `driver upload found, but its tables could not be read: ${reason.ok ? 'unknown' : reason.reason}`,
    )
    return result
  }
  return { header, ...best, problems: best.problems }
}
