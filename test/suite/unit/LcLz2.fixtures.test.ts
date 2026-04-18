/**
 * LC_LZ2 decompressor fixture tests.
 *
 * Runs in CI without needing a ROM: fixtures at test/fixtures/gfx/ ship both
 * the raw compressed input (GFX<HH>.lz2.bin) and the expected decompressed
 * output (GFX<HH>.bin). Expected outputs come from the vendored snesrev/smw
 * Python LC_LZ2 decompressor — an independent implementation. Any regression
 * in src/rom/LcLz2.ts will surface as a byte-for-byte mismatch below.
 *
 * See tools/dump-vanilla-gfx.py + test/fixtures/gfx/README.md to regenerate.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { decompress } from '../../../src/rom/LcLz2'

const FIXTURES_DIR = resolve(__dirname, '../../fixtures/gfx')

function fixturePairs(): Array<{ index: number; hex: string; lz2: string; dec: string }> {
  if (!existsSync(FIXTURES_DIR)) return []
  const pairs: Array<{ index: number; hex: string; lz2: string; dec: string }> = []
  const names = readdirSync(FIXTURES_DIR)
  for (const name of names) {
    const m = /^GFX([0-9A-F]{2})\.lz2\.bin$/.exec(name)
    if (!m) continue
    const hex = m[1]
    const index = parseInt(hex, 16)
    const dec = `GFX${hex}.bin`
    if (!names.includes(dec)) continue
    pairs.push({ index, hex, lz2: name, dec })
  }
  return pairs.sort((a, b) => a.index - b.index)
}

const PAIRS = fixturePairs()

describe('LcLz2 decompress — snesrev/smw reference fixtures', () => {
  it('fixtures directory is populated', () => {
    // Guard against silent "0 tests ran because fixtures went missing".
    expect(PAIRS.length).toBe(50)
  })

  it.each(PAIRS)(
    'GFX$hex decompresses byte-for-byte against reference',
    ({ hex, lz2, dec }) => {
      const input    = readFileSync(resolve(FIXTURES_DIR, lz2))
      const expected = readFileSync(resolve(FIXTURES_DIR, dec))
      const actual   = decompress(input)

      // Length check first for a clearer failure.
      expect(actual.length, `GFX${hex} length`).toBe(expected.length)

      // Only build a fat diff report if bytes differ.
      let firstMismatch = -1
      for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== expected[i]) { firstMismatch = i; break }
      }
      if (firstMismatch >= 0) {
        const start = Math.max(0, firstMismatch - 4)
        const end   = Math.min(actual.length, firstMismatch + 8)
        const ours  = Array.from(actual.slice(start, end)).map(b => b.toString(16).padStart(2, '0')).join(' ')
        const theirs = Array.from(expected.slice(start, end)).map(b => b.toString(16).padStart(2, '0')).join(' ')
        throw new Error(
          `GFX${hex}: first mismatch at byte ${firstMismatch}\n` +
          `  ours:      ${ours}\n  expected:  ${theirs}`,
        )
      }
    },
  )
})
