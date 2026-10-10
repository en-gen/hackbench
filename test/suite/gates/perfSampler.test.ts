/**
 * Proof that the batched sampler (test/perf/support/perfCase.ts) can fail:
 * H1's plant precision requirement (a 1.3 factor measures within
 * [1.2, 1.4] of an unplanted run), rejecting a factor < 1 or non-numeric,
 * and that it measures async and sync functions correctly.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
  it('a plant for a different id does not affect this one', async () => {
    const id = 'test.sampler.unaffected'
    const fn = () => busyMs(0.1)
    process.env.HB_PERF_PLANT = 'some.other.id=5.0'
    const samples = await measureCase(id, fn)
    expect(median(samples)).toBeLessThan(1) // nowhere near a 5x-scaled 0.1ms
  })

  it('rejects a factor below 1 (a plant only simulates a slowdown)', async () => {
    process.env.HB_PERF_PLANT = 'test.sampler.x=0.5'
    await expect(measureCase('test.sampler.x', () => 1)).rejects.toThrow(/>= 1/)
  })

  it('rejects a non-numeric factor', async () => {
    process.env.HB_PERF_PLANT = 'test.sampler.x=notanumber'
    await expect(measureCase('test.sampler.x', () => 1)).rejects.toThrow(/not a number/)
  })

  it('rejects an empty id ("=2")', async () => {
    process.env.HB_PERF_PLANT = '=2'
    await expect(measureCase('test.sampler.x', () => 1)).rejects.toThrow(/id=factor/)
  })
})

describe('M33: measureCase records its samples to HB_PERF_RESULTS_FILE', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sampler-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('appends one NDJSON line with the id, unit and 20 samples', async () => {
    const out = path.join(dir, 'results.ndjson')
    process.env.HB_PERF_RESULTS_FILE = out
    await measureCase('test.sampler.recorded', () => 1)
    const lines = fs
      .readFileSync(out, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0].id).toBe('test.sampler.recorded')
    expect(lines[0].unit).toBe('ms')
    expect(lines[0].samples).toHaveLength(20)
  })

  it('records nothing when HB_PERF_RESULTS_FILE is unset', async () => {
    delete process.env.HB_PERF_RESULTS_FILE
    await expect(measureCase('test.sampler.unrecorded', () => 1)).resolves.toHaveLength(20)
  })
})

describe('sync and async functions are both measured correctly', () => {
  it('a sync function returns real, non-zero-median samples', async () => {
    const samples = await measureCase('test.sampler.sync', () => {
      let s = 0
      for (let i = 0; i < 1000; i++) s += i
      return s
    })
    expect(samples).toHaveLength(20)
    expect(median(samples)).toBeGreaterThan(0)
  })

  // Timed out at the 5 s default in 1 of 10 loaded runs (two concurrent full unit runs, 32-core machine, 2026-10-09/10), true duration unknown; idle 0.34 s.
  it('an async function is awaited per call, not raced', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fn = async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 0))
      inFlight--
    }
    const samples = await measureCase('test.sampler.async', fn)
    expect(samples).toHaveLength(20)
    expect(maxInFlight).toBe(1)
  }, 10_000)
})
