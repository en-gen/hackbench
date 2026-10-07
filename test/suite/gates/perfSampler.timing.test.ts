/**
 * Wall-clock half of the sampler proof (#537): a 1.3 plant measures within
 * [1.2, 1.4] of an unplanted run. Flakes under parallel load, so it runs
 * through `npm run test:timing`, not `test:unit`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { measureCase } from '../../perf/support/perfCase'

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function busyMs(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // deliberate spin, mirrors what a real bench case spends its time on
  }
}

afterEach(() => {
  delete process.env.HB_PERF_PLANT
  delete process.env.HB_PERF_RESULTS_FILE
})

describe('H1: plant scales the measured cost by the stated factor', () => {
  it('a 1.3 factor measures within [1.2, 1.4] of an unplanted run', async () => {
    const id = 'test.sampler.plant-precision'
    const fn = () => busyMs(0.2)

    delete process.env.HB_PERF_PLANT
    const unplanted = await measureCase(id, fn)

    process.env.HB_PERF_PLANT = `${id}=1.3`
    const planted = await measureCase(id, fn)

    const ratio = median(planted) / median(unplanted)
    expect(ratio).toBeGreaterThanOrEqual(1.2)
    expect(ratio).toBeLessThanOrEqual(1.4)
  })
})
