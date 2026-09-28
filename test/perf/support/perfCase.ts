/**
 * Registers one benchmark case and, when it runs, appends its result to the
 * NDJSON scratch file named by HB_PERF_RESULTS_FILE. `measureCase` is the
 * pure sampler (batched, timer-resolution safe - see the git history of this
 * file for why tinybench's own time-budget mode is not used); `perfCase`
 * wraps it in `it.skipIf`, so an id excluded by HB_PERF_ONLY shows up as
 * skipped rather than silently absent.
 */
import { appendFileSync } from 'node:fs'
import { it } from 'vitest'

const WARMUP_BATCHES = 3
const SAMPLE_BATCHES = 20
const MIN_BATCH_MS = 1
const MAX_CALIBRATION_REPS = 1_000_000

function parsePlant(spec: string | undefined): { id: string; factor: number } | undefined {
  if (!spec) return undefined
  const eq = spec.lastIndexOf('=')
  if (eq === -1) throw new Error(`HB_PERF_PLANT must be "id=factor": ${spec}`)
  const id = spec.slice(0, eq)
  const factor = Number(spec.slice(eq + 1))
  if (!Number.isFinite(factor)) throw new Error(`HB_PERF_PLANT factor is not a number: ${spec}`)
  if (factor < 1)
    throw new Error(`HB_PERF_PLANT factor must be >= 1, a plant only simulates a slowdown: ${spec}`)
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

export function shouldRun(id: string): boolean {
  const only = onlyList()
  return !only || only.includes(id)
}

function busyWaitMs(ms: number): void {
  if (ms <= 0) return
  const end = performance.now() + ms
  while (performance.now() < end) {
    // spin: this measures wall time, not CPU work, on purpose - a planted
    // regression must show up in the same samples a real slowdown would.
  }
}

function isPromiseLike(v: unknown): v is Promise<unknown> {
  return v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function'
}

/** One batch of `reps` calls, timed once. H1: the plant busy-waits ONCE
 *  after the raw batch elapsed, scaling the whole batch by `plantFactor`
 *  rather than padding each call - so calibration and sampling both see the
 *  same scaled cost, and the timestamp taken at the very end (after the
 *  wait) is what gets divided by `reps`. */
async function timedBatch(
  fn: () => unknown,
  reps: number,
  isAsync: boolean,
  plantFactor: number | undefined,
): Promise<number> {
  const t0 = performance.now()
  if (isAsync) {
    for (let i = 0; i < reps; i++) await fn()
  } else {
    for (let i = 0; i < reps; i++) fn()
  }
  if (plantFactor !== undefined) busyWaitMs((performance.now() - t0) * (plantFactor - 1))
  return performance.now() - t0
}

async function calibrate(
  fn: () => unknown,
  isAsync: boolean,
  plantFactor: number | undefined,
): Promise<number> {
  let reps = 1
  for (;;) {
    const elapsed = await timedBatch(fn, reps, isAsync, plantFactor)
    if (elapsed >= MIN_BATCH_MS || reps >= MAX_CALIBRATION_REPS) return reps
    reps *= 4
  }
}

/** Runs and records one case's samples, bypassing vitest's `it` registration
 *  so tests can call this directly (perfCase wraps it for real bench files). */
export async function measureCase(id: string, fn: () => unknown): Promise<number[]> {
  const plant = parsePlant(process.env.HB_PERF_PLANT)
  const plantFactor = plant && plant.id === id ? plant.factor : undefined

  const probe = fn()
  const isAsync = isPromiseLike(probe)
  if (isAsync) await probe

  const reps = await calibrate(fn, isAsync, plantFactor)
  for (let w = 0; w < WARMUP_BATCHES; w++) await timedBatch(fn, reps, isAsync, plantFactor)
  const samples: number[] = []
  for (let s = 0; s < SAMPLE_BATCHES; s++)
    samples.push((await timedBatch(fn, reps, isAsync, plantFactor)) / reps)

  const outPath = process.env.HB_PERF_RESULTS_FILE
  if (outPath) {
    appendFileSync(outPath, JSON.stringify({ id, unit: 'ms', better: 'lower', samples }) + '\n')
  }
  return samples
}

export function perfCase(id: string, fn: () => unknown): void {
  it.skipIf(!shouldRun(id))(id, () => measureCase(id, fn))
}
