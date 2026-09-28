/**
 * Heap difference rule (design section 4, point 4 and issue #413's
 * acceptance list): a planted slope regresses; a flat noisy series does not.
 * Heap ids compare differences, never ratios, because a slope near zero
 * makes a ratio meaningless.
 */
import { describe, it, expect } from 'vitest'
import { verdictForId, mulberry32, HEAP_MIN_ABS_BYTES } from '../../../tools/perf/compare.mjs'

function roundDoc(id: string, value: number) {
  return {
    schema: 1,
    sha: 'x',
    suite: 'heap',
    results: [{ id, unit: 'bytes/cycle', better: 'lower', samples: [value] }],
  }
}

function rounds(id: string, values: number[]) {
  return values.map(v => roundDoc(id, v))
}

describe('heap family compares differences, not ratios', () => {
  it('a planted slope well past the byte floor regresses', () => {
    const id = 'heap.views.slope'
    const baseVals = [1000, 1050, 980, 1020, 1010, 990, 1005, 1015]
    // Well past both the 64 KiB floor and the 25% relative threshold.
    const candVals = baseVals.map(v => v + 200_000)
    const v = verdictForId(id, rounds(id, baseVals), rounds(id, candVals), {
      rng: mulberry32(3),
      resamples: 500,
    })
    expect(v.metric).toBe('difference')
    expect(v.verdict).toBe('regression')
  })

  it('a flat series with noise under the floor does not regress', () => {
    const id = 'heap.views.flat'
    const dataRng = mulberry32(9)
    const baseVals: number[] = []
    const candVals: number[] = []
    for (let i = 0; i < 8; i++) {
      baseVals.push(1000 + (dataRng() - 0.5) * 200)
      candVals.push(1000 + (dataRng() - 0.5) * 200)
    }
    const v = verdictForId(id, rounds(id, baseVals), rounds(id, candVals), {
      rng: mulberry32(10),
      resamples: 500,
    })
    expect(v.verdict).toBe('ok')
  })

  it('the floor is at least 64 KiB even when the base median is near zero', () => {
    const id = 'heap.views.nearzero'
    const baseVals = [0, 1, -1, 0, 1, -1, 0, 1]
    // A few hundred bytes of "drift" must not trip a near-zero-baseline series.
    const candVals = baseVals.map(v => v + 500)
    const v = verdictForId(id, rounds(id, baseVals), rounds(id, candVals), {
      rng: mulberry32(4),
      resamples: 500,
    })
    expect(v.threshold).toBeGreaterThanOrEqual(HEAP_MIN_ABS_BYTES)
    expect(v.verdict).toBe('ok')
  })
})
