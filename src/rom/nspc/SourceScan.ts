/**
 * From a foreign ROM's bytes to a list of sound-RAM images, each with its
 * driver located and its songs enumerated.
 *
 * The one uploaded chain holding the driver is the base. Other chains either
 * overlap nothing (shared data such as samples, loaded alongside every bank)
 * or overlap each other (alternative song banks the game swaps between).
 * Each alternative becomes its own image. Nothing here assumes which bank a
 * game loads when; the user picks songs, and each song carries its image.
 */
import { detectHeader, HeaderResult, stripCopierHeader } from './RomHeader'
import { applyChain, chainsOverlap, findUploadChains, UploadChain } from './UploadChains'
import { locateEngine, NspcEngine } from './NspcEngine'
import { parseSong, NspcSong } from './NspcSong'

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
  chains: UploadChain[]
  images: SoundImage[]
  songs: ScannedSong[]
  /** Table entries whose song data could not be read in full, with why. */
  unavailable: UnavailableSong[]
  /** Why nothing (or less than everything) could be read. */
  problems: string[]
}

const ARAM_SIZE = 0x10000

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

const hex = (n: number, w = 4) => '$' + n.toString(16).toUpperCase().padStart(w, '0')

export function scanRom(file: Uint8Array): ScanResult {
  const header = detectHeader(file)
  const rom = stripCopierHeader(file)
  const problems: string[] = []
  if (!header.ok) {
    problems.push(`cannot tell how this ROM is laid out: ${header.reason}`)
    return { header, chains: [], images: [], songs: [], unavailable: [], problems }
  }
  const chains = findUploadChains(rom, header.best.layout)
  const result: ScanResult = { header, chains, images: [], songs: [], unavailable: [], problems }
  if (chains.length === 0) {
    problems.push(
      'no sound upload data found (the game may compress it, or use a different upload format)',
    )
    return result
  }

  // The driver chain is the one whose bytes alone contain a locatable engine.
  const drivers = chains.filter(c => locateEngine(buildImage(rom, [c]).aram).ok)
  if (drivers.length === 0) {
    // The driver may be split across chains; try everything together before giving up.
    const all = locateEngine(buildImage(rom, chains).aram)
    problems.push(
      all.ok
        ? 'driver spans several uploads; not supported yet'
        : `no N-SPC driver found: ${all.reason}`,
    )
    return result
  }
  if (drivers.length > 1)
    problems.push(`${drivers.length} driver uploads found; each is scanned separately`)

  for (const driver of drivers) {
    // Shared uploads overlap nothing; the rest overwrite the driver's region
    // or each other, so each is an alternative applied on top of the driver.
    const others = chains.filter(c => c !== driver)
    const shared = others.filter(c => !chains.some(o => o !== c && chainsOverlap(o, c)))
    const alternatives = others.filter(c => !shared.includes(c))
    const variants: UploadChain[][] = [[], ...alternatives.map(a => [a])]

    for (const extra of variants) {
      const { aram, written } = buildImage(rom, [driver, ...shared, ...extra])
      const located = locateEngine(aram)
      if (!located.ok) {
        problems.push(`driver at file ${hex(driver.fileOffset, 6)}: ${located.reason}`)
        continue
      }
      const label = extra.length ? `bank at file ${hex(extra[0].fileOffset, 6)}` : 'base'
      const image: SoundImage = {
        aram,
        written,
        engine: located.engine,
        entry: driver.entry,
        label,
      }
      result.images.push(image)

      // The table has no stored length. It is a contiguous array, so the
      // first entry whose bytes are not a song at all is past its end;
      // later entries that happen to parse are other data read as pointers.
      // A song that is well formed but runs into memory this image never
      // filled is listed as unavailable, not as the end: another upload the
      // game makes first may supply it (SMW's credits bank does this).
      const pointers = new Set<number>()
      for (let command = 1; command < 0x80; command++) {
        const at = located.engine.songTable + command * 2
        if (!written[at] || !written[at + 1]) break
        const ptr = aram[at] | (aram[at + 1] << 8)
        if (pointers.has(ptr)) continue
        pointers.add(ptr)
        const song = parseSong(image, ptr)
        if (song.ok) result.songs.push({ command, image, song: song.song })
        else if (song.kind === 'unwritten')
          result.unavailable.push({ command, image, reason: song.reason })
        else break
      }
    }
  }

  // The same song reached from several images (shared data) is listed once.
  const seen = new Set<string>()
  result.songs = result.songs.filter(s => {
    const key = `${s.command}:${s.song.fingerprint}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return result
}
