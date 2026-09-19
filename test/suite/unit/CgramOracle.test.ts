import { describe, it, expect } from 'vitest'
import {
  CGRAM_COLORS, CGRAM_CAPTURE_BYTES, EXCLUDED_INDICES, ROM_WRITTEN_INDICES,
  compareCgram, parseCgramCapture,
} from '../../../src/rom/CgramOracle'
import { bgr555ToRgba, RgbaColor } from '../../../src/rom/GraphicsDecoder'

/**
 * Every fixture here is synthetic. No ROM bytes and no captured CGRAM are
 * committed (docs/testing.md); what is under test is whether the comparison
 * turns red when the derivation is wrong, which needs no real palette data.
 */

/** A capture whose every index holds a distinct, non-trivial BGR555 word. */
function syntheticCapture(): Uint16Array {
  const w = new Uint16Array(CGRAM_COLORS)
  for (let i = 0; i < CGRAM_COLORS; i++) w[i] = (i * 0x0123 + 0x1111) & 0x7FFF
  return w
}

function derivationMatching(capture: Uint16Array): RgbaColor[] {
  return Array.from(capture, w => bgr555ToRgba(w))
}

function toBytes(words: Uint16Array): Uint8Array {
  const b = new Uint8Array(words.length * 2)
  for (let i = 0; i < words.length; i++) { b[i * 2] = words[i] & 0xFF; b[i * 2 + 1] = words[i] >> 8 }
  return b
}

const comparedIndices = Array.from({ length: CGRAM_COLORS }, (_, i) => i).filter(i => !EXCLUDED_INDICES.has(i))

describe('parseCgramCapture', () => {
  it('decodes little-endian words and masks the unused bit 15', () => {
    const b = new Uint8Array(CGRAM_CAPTURE_BYTES)
    b[0] = 0xDD; b[1] = 0xFF   // $FFDD -> $7FDD once bit 15 is masked
    expect(parseCgramCapture(b)[0]).toBe(0x7FDD)
  })

  it('rejects a capture of the wrong size rather than comparing a truncated one', () => {
    expect(() => parseCgramCapture(new Uint8Array(256))).toThrow(/512 bytes/)
  })
})

describe('bgr555ToRgba is injective, so RGBA equality == BGR555 equality', () => {
  it('maps all 32768 distinct words to 32768 distinct colours', () => {
    const seen = new Set<string>()
    for (let w = 0; w < 0x8000; w++) seen.add(bgr555ToRgba(w).join(','))
    expect(seen.size).toBe(0x8000)
  })
})

describe('CGRAM oracle bucket accounting', () => {
  it('splits the 256 indices into the documented buckets', () => {
    expect(EXCLUDED_INDICES.size).toBe(17)                                  // 16 col-0 + animated $64
    expect(ROM_WRITTEN_INDICES.size).toBe(178)
    expect(comparedIndices.length).toBe(239)
    for (let r = 0; r < 16; r++) expect(ROM_WRITTEN_INDICES.has(r * 16)).toBe(false)
  })

  it('passes, with the expected counts, when the derivation matches exactly', () => {
    const cap = syntheticCapture()
    const c = compareCgram(cap, derivationMatching(cap), bgr555ToRgba)
    expect(c.ok).toBe(true)
    expect(c.writtenCompared).toBe(177)      // 178 written minus animated $64
    expect(c.unwrittenCompared).toBe(62)
    expect(c.excluded).toBe(17)
  })
})

describe('planted palette defects turn the oracle red', () => {
  it('detects a wrong background-palette variant (rows 0-1 cols 2-7)', () => {
    const cap = syntheticCapture()
    const derived = derivationMatching(cap)
    const bgIndices = [0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17]
    for (const i of bgIndices) derived[i] = bgr555ToRgba((cap[i] + 0x0421) & 0x7FFF)
    const c = compareCgram(cap, derived, bgr555ToRgba)
    expect(c.ok).toBe(false)
    expect(c.mismatches.map(m => m.index)).toEqual(bgIndices)
    expect(c.mismatches.every(m => m.romWritten)).toBe(true)
    expect(c.writtenMismatched).toBe(12)
  })

  it('detects colours invented where the ROM writes none (rows 5-7 cols 9-15)', () => {
    // The real defect this bucket caught: level CGRAM filled from $00B552,
    // which is inside OWStdColors (SMW_U.sym:10998), an overworld table.
    const cap = syntheticCapture()
    for (let r = 5; r <= 7; r++) for (let c = 9; c <= 15; c++) cap[r * 16 + c] = 0
    const derived = derivationMatching(cap)
    for (let r = 5; r <= 7; r++) for (let c = 9; c <= 15; c++) derived[r * 16 + c] = bgr555ToRgba(0x2A5F)
    const c = compareCgram(cap, derived, bgr555ToRgba)
    expect(c.ok).toBe(false)
    expect(c.mismatches).toHaveLength(21)
    expect(c.mismatches.every(m => !m.romWritten)).toBe(true)
  })

  it('detects a one-step BGR555 error, with no rounding slack', () => {
    const cap = syntheticCapture()
    const derived = derivationMatching(cap)
    derived[0x42] = bgr555ToRgba(cap[0x42] ^ 0x0001)
    const c = compareCgram(cap, derived, bgr555ToRgba)
    expect(c.mismatches.map(m => m.index)).toEqual([0x42])
  })

  // Not a single-case acceptance test: a defect planted at ONE convenient
  // index proves nothing about the other 238.
  it('detects a planted defect at every one of the 239 compared indices', () => {
    const cap = syntheticCapture()
    const undetected: number[] = []
    for (const i of comparedIndices) {
      const derived = derivationMatching(cap)
      derived[i] = bgr555ToRgba(cap[i] ^ 0x7FFF)
      if (compareCgram(cap, derived, bgr555ToRgba).ok) undetected.push(i)
    }
    expect(undetected).toEqual([])
  })

  it('reports every index when the whole derivation is wrong', () => {
    const cap = syntheticCapture()
    const derived = Array.from({ length: CGRAM_COLORS }, () => [0, 0, 0, 255] as RgbaColor)
    const c = compareCgram(cap, derived, bgr555ToRgba)
    expect(c.mismatches.length).toBe(239)
  })
})

describe('the exclusions are exactly as wide as documented', () => {
  it('ignores a defect planted at any excluded index, and only those', () => {
    const cap = syntheticCapture()
    const wronglyDetected: number[] = []
    for (const i of EXCLUDED_INDICES.keys()) {
      const derived = derivationMatching(cap)
      derived[i] = bgr555ToRgba(cap[i] ^ 0x7FFF)
      if (!compareCgram(cap, derived, bgr555ToRgba).ok) wronglyDetected.push(i)
    }
    expect(wronglyDetected).toEqual([])
    expect([...EXCLUDED_INDICES.keys()].filter(i => i % 16 !== 0)).toEqual([0x64])
  })
})
