/**
 * #975: the synthetic ROMs this branch adds share no 8-byte run with the
 * vanilla ROM (BA safety rule, 2026-10-17). Evidence scope: the fixtures below
 * come from support/syntheticRegistryRom.ts, shared with the tests that use them; the scan covers every 8-byte window of
 * each. The scanner is proven able to fail by a planted copy.
 */
import * as fs from 'fs'
import { describe, it, expect } from 'vitest'
import { hasRom, romPath, VANILLA } from '../support/corpus'
import { fakeRom, rampRom } from '../support/syntheticRegistryRom'

const RUN = 8

/** Every RUN-byte window of `b`, as a hex-string Set. */
function windows(b: Uint8Array): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + RUN <= b.length; i++)
    out.add(Buffer.from(b.subarray(i, i + RUN)).toString('hex'))
  return out
}

/** How many distinct windows of `b` also occur in `haystack`. */
function sharedWindows(b: Uint8Array, haystack: Set<string>): number {
  let n = 0
  for (const w of windows(b)) if (haystack.has(w)) n++
  return n
}

describe('scanner (synthetic, runs in CI)', () => {
  const hay = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7 + (i >> 3)) & 0xff)
  const haySet = windows(hay)

  it('reports a planted 8-byte run', () => {
    const probe = Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + 5) & 0xff)
    probe.set(hay.subarray(1000, 1000 + RUN), 20)
    expect(sharedWindows(probe, haySet)).toBeGreaterThanOrEqual(1)
  })

  it('does not report a 7-byte overlap', () => {
    const probe = Uint8Array.from({ length: 64 }, () => 0xee)
    probe.set(hay.subarray(1000, 1000 + RUN - 1), 20)
    expect(sharedWindows(probe, haySet)).toBe(0)
  })
})

describe.skipIf(!hasRom(VANILLA))('branch fixtures vs the vanilla ROM', () => {
  const vanilla = (): Set<string> => windows(fs.readFileSync(romPath(VANILLA)))

  it('fakeRom, its flipped variant and the ramp share no 8-byte run', () => {
    const v = vanilla()
    const flipped = fakeRom()
    flipped[0x100] ^= 0xff
    expect(sharedWindows(fakeRom(), v)).toBe(0)
    expect(sharedWindows(flipped, v)).toBe(0)
    expect(sharedWindows(rampRom(), v)).toBe(0)
  })

  it('goes red on a planted vanilla slice', () => {
    const v = vanilla()
    const planted = fakeRom()
    planted.set(fs.readFileSync(romPath(VANILLA)).subarray(0x8000, 0x8000 + RUN), 0x1234)
    expect(sharedWindows(planted, v)).toBeGreaterThanOrEqual(1)
  })
})
