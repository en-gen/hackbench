/**
 * Which memory layout a foreign SNES ROM uses, scored rather than assumed.
 *
 * RomFile._detectMapMode accepts four exact map bytes and falls back to
 * LoROM, which is fine for SMW and confidently wrong for anything else.
 * Here both header sites are scored on independent evidence and a tie or a
 * weak winner is reported as unknown, never defaulted.
 *
 * Plain bytes in, no Buffer, so it runs in a browser as well as the backend.
 */

export type RomLayout = 'lorom' | 'hirom' | 'exhirom'

export interface HeaderCandidate {
  layout: RomLayout
  /** File offset of the header's title at $xFC0 (copier header already stripped). */
  offset: number
  score: number
  title: string
  mapByte: number
  reasons: string[]
}

export type HeaderResult =
  | { ok: true; best: HeaderCandidate; candidates: HeaderCandidate[] }
  | { ok: false; reason: string; candidates: HeaderCandidate[] }

const COPIER_HEADER = 512

/** Header block starts ($xFC0 title) per layout, as file offsets. */
const SITES: { layout: RomLayout; offset: number }[] = [
  { layout: 'lorom', offset: 0x7fc0 },
  { layout: 'hirom', offset: 0xffc0 },
  { layout: 'exhirom', offset: 0x40ffc0 },
]

/** Low nibble of the map byte that each layout declares. SA-1 ($x3) and SDD-1 ($x2) are LoROM-shaped. */
const MAP_NIBBLES: Record<RomLayout, number[]> = {
  lorom: [0x0, 0x2, 0x3],
  hirom: [0x1],
  exhirom: [0x5],
}

/** Opcodes a reset handler plausibly starts with: SEI, CLC, SEP, REP, JML, JMP, STZ, LDA #. */
const RESET_OPCODES = new Set([0x78, 0x18, 0xe2, 0xc2, 0x5c, 0x4c, 0x9c, 0xa9])

/** Anything scoring below this is not a header, whatever else it wins against. */
const MIN_SCORE = 4

export function stripCopierHeader(file: Uint8Array): Uint8Array {
  return file.length % 1024 === COPIER_HEADER ? file.subarray(COPIER_HEADER) : file
}

function scoreSite(rom: Uint8Array, layout: RomLayout, offset: number): HeaderCandidate | null {
  if (offset + 0x40 > rom.length) return null
  const h = rom.subarray(offset, offset + 0x40)
  const reasons: string[] = []
  let score = 0

  const mapByte = h[0x15]
  if ((mapByte & 0xe0) === 0x20 && MAP_NIBBLES[layout].includes(mapByte & 0x0f)) {
    score += 3
    reasons.push('map byte matches site')
  }

  const complement = h[0x1c] | (h[0x1d] << 8)
  const checksum = h[0x1e] | (h[0x1f] << 8)
  if ((complement ^ checksum) === 0xffff) {
    score += 2
    reasons.push('checksum complement')
  }

  const reset = h[0x3c] | (h[0x3d] << 8)
  if (reset >= 0x8000) {
    score += 1
    // Reset vectors are bank 0 addresses; locate the byte for this layout.
    const bankOffset =
      layout === 'lorom' ? reset - 0x8000 : layout === 'hirom' ? reset : 0x400000 + reset
    if (bankOffset < rom.length && RESET_OPCODES.has(rom[bankOffset])) {
      score += 2
      reasons.push('reset vector lands on a plausible opcode')
    }
  }

  const titleBytes = h.subarray(0, 21)
  const printable = titleBytes.every(b => b >= 0x20 && b < 0x7f)
  if (printable) {
    score += 1
    reasons.push('printable title')
  }

  const sizeByte = h[0x17]
  if (sizeByte >= 0x08 && sizeByte <= 0x0d && 0x400 << sizeByte >= rom.length / 2) {
    score += 1
    reasons.push('size byte consistent')
  }

  const title = printable ? String.fromCharCode(...titleBytes).trim() : ''
  return { layout, offset, score, title, mapByte, reasons }
}

export function detectHeader(file: Uint8Array): HeaderResult {
  const rom = stripCopierHeader(file)
  const candidates = SITES.map(s => scoreSite(rom, s.layout, s.offset))
    .filter((c): c is HeaderCandidate => c !== null)
    .sort((a, b) => b.score - a.score)

  if (candidates.length === 0)
    return { ok: false, reason: 'file is too small to hold a header', candidates }
  const [best, second] = candidates
  if (best.score < MIN_SCORE) {
    return { ok: false, reason: `no header site scored above ${MIN_SCORE - 1}`, candidates }
  }
  if (second && second.score === best.score) {
    return {
      ok: false,
      reason: `${best.layout} and ${second.layout} both scored ${best.score}`,
      candidates,
    }
  }
  return { ok: true, best, candidates }
}
