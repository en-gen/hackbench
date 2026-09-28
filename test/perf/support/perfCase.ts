/**
 * Runs one benchmark case and records it to the NDJSON scratch file named by
 * HB_PERF_RESULTS_FILE, one line per case, in the shape results.mjs expects
 * for a single `results[]` entry.
 *
 * Vitest 5 replaced the old top-level `bench()`/`describe` benchmarking mode
 * (see docs/superpowers/specs/2026-09-28-perf-gates-design.md section 2) with
 * an in-test `bench` fixture backed by a pluggable provider, and tinybench's
 * own time-budget mode ran several of this file's sub-millisecond cases into
 * millions of iterations, large enough that `JSON.stringify` on the samples
 * threw "Invalid string length" (measured while building this PR). Sampling
 * by hand, batched to clear timer resolution, keeps the same outcome -
 * vitest test files, `describe.skipIf` corpus gating, a fixed, bounded
 * sample count - without either dependency's surprises. Deviation from the
 * spec's exact CLI plumbing ("vitest bench", "--outputJson", "tinybench");
 * everything the spec actually cares about (schema 1 output, corpus gating,
 * separate config) is unchanged.
 *
 * HB_PERF_ONLY, a comma list of ids, restricts which ids actually run; a
 * case not named there is skipped so `--only` on the paired runner and
 * bisect's per-id runs stay cheap.
 *
 * HB_PERF_PLANT="id=factor" (design section 7) busy-waits inside the
 * measured function for the one named id, scaling it by `factor`. The extra
 * wait is a fraction of a quick calibration run of the real function, so the
 * plant scales the true cost rather than adding a fixed constant.
 */
import { appendFileSync } from 'node:fs'

export type Unit = 'ms' | 'bytes/cycle'
export type Better = 'lower'

const WARMUP_BATCHES = 3
const SAMPLE_BATCHES = 20
const MIN_BATCH_MS = 1
const MAX_CALIBRATION_REPS = 1_000_000

function parsePlant(spec: string | undefined): { id: string; factor: number } | undefined {
  if (!spec) return undefined
  const eq = spec.lastIndexOf('=')
  if (eq === -1) return undefined
  const id = spec.slice(0, eq)
  const factor = Number(spec.slice(eq + 1))
  if (!Number.isFinite(factor)) return undefined
  return { id, factor }
}

function onlyList(): string[] | undefined {
  const raw = process.env.HB_PERF_ONLY
  if (!raw) return undefined
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function busyWaitMs(ms: number): void {
  if (ms <= 0) return
  const end = performance.now() + ms
  while (performance.now() < end) {
    // spin: this measures wall time, not CPU work, on purpose - a planted
    // regression must show up in the same samples a real slowdown would.
  }
}

export function shouldRun(id: string): boolean {
  const only = onlyList()
  return !only || only.includes(id)
}

/** Batched call count needed for one batch to clear MIN_BATCH_MS, found by
 *  doubling. Bounded so a pathologically slow fn cannot blow the time budget. */
async function calibrate(fn: () => void | Promise<void>): Promise<number> {
  let reps = 1
  for (;;) {
    const t0 = performance.now()
    for (let i = 0; i < reps; i++) await fn()
    const elapsed = performance.now() - t0
    if (elapsed >= MIN_BATCH_MS || reps >= MAX_CALIBRATION_REPS) return reps
    reps *= 4
  }
}

/** Runs `fn` in batches of `reps` calls, timing each batch once and dividing,
 *  so a sample stays meaningful even for sub-millisecond functions without
 *  ever running an unbounded number of iterations. */
async function sampleBatched(fn: () => void | Promise<void>, reps: number): Promise<number[]> {
  for (let w = 0; w < WARMUP_BATCHES; w++) {
    for (let i = 0; i < reps; i++) await fn()
  }
  const samples: number[] = []
  for (let s = 0; s < SAMPLE_BATCHES; s++) {
    const t0 = performance.now()
    for (let i = 0; i < reps; i++) await fn()
    samples.push((performance.now() - t0) / reps)
  }
  return samples
}

export async function perfCase(
  id: string,
  unit: Unit,
  better: Better,
  fn: () => void | Promise<void>,
): Promise<void> {
  if (!shouldRun(id)) return

  const plant = parsePlant(process.env.HB_PERF_PLANT)
  let measured = fn
  if (plant && plant.id === id && plant.factor !== 1) {
    const t0 = performance.now()
    await fn()
    const baselineMs = performance.now() - t0
    const extraMs = baselineMs * (plant.factor - 1)
    measured = async () => {
      await fn()
      busyWaitMs(extraMs)
    }
  }

  const reps = await calibrate(measured)
  const samples = await sampleBatched(measured, reps)

  const outPath = process.env.HB_PERF_RESULTS_FILE
  if (outPath) {
    const line = JSON.stringify({ id, unit, better, samples })
    appendFileSync(outPath, line + '\n')
  }
}
