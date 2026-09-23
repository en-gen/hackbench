/**
 * CgramOracle.ts -- compare a captured PPU CGRAM image against our own
 * palette derivation.
 *
 * The capture is 512 bytes of hardware CGRAM read out of Mesen
 * (tools/mesen/headless_capture.lua). It is not derived from our ROM tables
 * and not read back out of MainPalette ($7E0703, rammap.asm:1175, the game's
 * own WRAM staging buffer), so comparing buildLevelCgram against it is not
 * circular.
 *
 * Index buckets and the ROM citations behind them: docs/spikes/cgram-oracle.md.
 */

import { RgbaColor } from './GraphicsDecoder'

export const CGRAM_COLORS = 256
export const CGRAM_CAPTURE_BYTES = CGRAM_COLORS * 2

/** Inclusive CGRAM index spans LoadPalette + MarioGFXDMA write on a level load. */
const WRITTEN_SPANS: ReadonlyArray<readonly [number, number, string]> = [
  [0x08, 0x0f, 'StatusBarColors row 0 (bank_00.asm:5605-5613)'],
  [0x18, 0x1f, 'StatusBarColors row 1 (bank_00.asm:5605-5613)'],
  [0x02, 0x07, 'BackgroundPalettes row 0 (bank_00.asm:5663-5679)'],
  [0x12, 0x17, 'BackgroundPalettes row 1 (bank_00.asm:5663-5679)'],
  [0x22, 0x27, 'ForegroundPalettes row 2 (bank_00.asm:5629-5645)'],
  [0x32, 0x37, 'ForegroundPalettes row 3 (bank_00.asm:5629-5645)'],
  [0xe2, 0xe7, 'SpriteColors row 14 (bank_00.asm:5646-5662)'],
  [0xf2, 0xf7, 'SpriteColors row 15 (bank_00.asm:5646-5662)'],
  [0x86, 0x8f, 'PlayerColors via MarioGFXDMA, CGADD $86 (bank_00.asm:4551-4566)'],
]

/** Column-strided writes: rows [lo,hi] get cols [colLo,colHi]. */
const WRITTEN_GRIDS: ReadonlyArray<readonly [number, number, number, number, string]> = [
  [0, 7, 1, 1, 'col 1 = $7FDD, rows 0-7 (bank_00.asm:5597-5601)'],
  [8, 15, 1, 1, 'col 1 = $7FFF, rows 8-15 (bank_00.asm:5602-5604)'],
  [4, 13, 2, 7, 'StandardColors rows 4-13 (bank_00.asm:5614-5622)'],
  [2, 4, 9, 15, 'BerryColors rows 2-4 (bank_00.asm:5680-5688)'],
  [9, 11, 9, 15, 'BerryColors rows 9-11 (bank_00.asm:5689-5697)'],
]

function buildWrittenSet(): Set<number> {
  const s = new Set<number>()
  for (const [lo, hi] of WRITTEN_SPANS) for (let i = lo; i <= hi; i++) s.add(i)
  for (const [rLo, rHi, cLo, cHi] of WRITTEN_GRIDS) {
    for (let r = rLo; r <= rHi; r++) for (let c = cLo; c <= cHi; c++) s.add(r * 16 + c)
  }
  return s
}

/** CGRAM indices the ROM provably writes during a level load. */
export const ROM_WRITTEN_INDICES: ReadonlySet<number> = buildWrittenSet()

/**
 * Indices excluded from the verdict, each for a reason that would otherwise
 * make the comparison meaningless rather than merely inconvenient.
 */
export const EXCLUDED_INDICES: ReadonlyMap<number, string> = new Map<number, string>([
  // Col 0 of every row: index $00 is the PPU backdrop and cols 0 of the other
  // rows are never sampled by BG or OBJ rendering. buildLevelCgram represents
  // them as alpha-0 on purpose, so an RGBA comparison there tests nothing.
  ...Array.from(
    { length: 16 },
    (_, r) => [r * 16, 'col 0: backdrop / unsampled, derived as transparent'] as [number, string],
  ),
  // Animated by the level NMI rather than written once at load, so no static
  // derivation can agree with it at an arbitrary frame.
  [0x64, 'row 6 col 4: animated per-frame during a level'],
])

export interface CgramMismatch {
  index: number
  expected: RgbaColor
  actual: RgbaColor
  romWritten: boolean
}

export interface CgramComparison {
  mismatches: CgramMismatch[]
  /** Compared and agreeing, split by bucket. */
  writtenCompared: number
  writtenMismatched: number
  unwrittenCompared: number
  unwrittenMismatched: number
  excluded: number
  ok: boolean
}

/** Decode a 512-byte CGRAM capture into 256 BGR555 words (bit 15 masked off). */
export function parseCgramCapture(bytes: Uint8Array): Uint16Array {
  if (bytes.length !== CGRAM_CAPTURE_BYTES) {
    throw new Error(`CGRAM capture must be ${CGRAM_CAPTURE_BYTES} bytes, got ${bytes.length}`)
  }
  const out = new Uint16Array(CGRAM_COLORS)
  for (let i = 0; i < CGRAM_COLORS; i++) out[i] = (bytes[i * 2] | (bytes[i * 2 + 1] << 8)) & 0x7fff
  return out
}

/**
 * Compare our derived CGRAM (RGBA, from buildLevelCgram) against a capture.
 *
 * `toRgba` is injected rather than imported so the comparison does not quietly
 * become a test of the BGR555 decoder: pass the same decoder the renderer uses
 * and a mismatch can only mean the derivation put a different colour at that
 * index. That decoder is injective on the low 15 bits, so RGBA equality here
 * is equivalent to BGR555 word equality (asserted in CgramOracle.test.ts).
 */
export function compareCgram(
  captured: Uint16Array,
  derived: readonly RgbaColor[],
  toRgba: (word: number) => RgbaColor,
): CgramComparison {
  const r: CgramComparison = {
    mismatches: [],
    writtenCompared: 0,
    writtenMismatched: 0,
    unwrittenCompared: 0,
    unwrittenMismatched: 0,
    excluded: 0,
    ok: true,
  }
  for (let i = 0; i < CGRAM_COLORS; i++) {
    if (EXCLUDED_INDICES.has(i)) {
      r.excluded++
      continue
    }
    const romWritten = ROM_WRITTEN_INDICES.has(i)
    if (romWritten) r.writtenCompared++
    else r.unwrittenCompared++
    const expected = toRgba(captured[i])
    const actual = derived[i] ?? [0, 0, 0, 0]
    if (
      actual[0] === expected[0] &&
      actual[1] === expected[1] &&
      actual[2] === expected[2] &&
      actual[3] === expected[3]
    )
      continue
    r.mismatches.push({ index: i, expected, actual, romWritten })
    if (romWritten) r.writtenMismatched++
    else r.unwrittenMismatched++
  }
  r.ok = r.mismatches.length === 0
  return r
}
