/**
 * One sweep run's state handling for tools/scripts/hack-sweep.ts, kept apart so a
 * fake sweeper can drive it in a test without a ROM.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  HackRecord,
  diffRuns,
  mergeCarried,
  pickBatch,
  summarize,
  trackingIssueBody,
} from './hackSweepReport'

/** The cursor lives in the same file as the records, so one atomic write moves both or neither. */
export interface SweepState {
  cursor: number
  records: HackRecord[]
}

/** A bad value stops the run: a silent fallback would sweep a different batch than the operator asked for. */
export function batchSize(raw: string | undefined): number {
  if (raw === undefined) return 50
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new Error(`HACKBENCH_SWEEP_BATCH must be a positive integer, got "${raw}"`)
  }
  return Number(raw)
}

/** A killed run must never leave a half-written file where the next run reads its state. */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

/** Null when the file is absent; a file that is there but unreadable stops the run, before any sweeping. */
export function loadState(path: string): { state: SweepState; text: string } | null {
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  let state: unknown
  try {
    state = JSON.parse(text)
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${(err as Error).message}); restore it or delete it`,
      { cause: err },
    )
  }
  const s = state as Partial<SweepState> | null
  if (!s || typeof s.cursor !== 'number' || !Array.isArray(s.records)) {
    throw new Error(`${path} is not a sweep state ({ cursor, records }); restore it or delete it`)
  }
  return { state: s as SweepState, text }
}

export interface SweepRun {
  outDir: string
  index: { smwc_id: number; name: string }[]
  size: number
  sweep: (h: SweepRun['index'][number]) => HackRecord
  log?: (line: string) => void
}

export function runSweep(run: SweepRun): void {
  const log = run.log ?? ((line: string) => void process.stdout.write(`${line}\n`))
  mkdirSync(run.outDir, { recursive: true })
  const resultsPath = join(run.outDir, 'results.json')
  const prev = loadState(resultsPath)
  const { batch, next } = pickBatch(run.index, prev?.state.cursor ?? 0, run.size)
  const swept: HackRecord[] = []
  for (const h of batch) {
    log(`${h.smwc_id} ${h.name}`)
    swept.push(run.sweep(h))
  }
  // Records for hacks outside this batch stay, marked carried, so every run holds the whole store.
  const records = prev
    ? mergeCarried(
        prev.state.records,
        swept,
        run.index.map(h => h.smwc_id),
      )
    : swept
  const summary = summarize(records)
  const body = trackingIssueBody(prev ? diffRuns(prev.state.records, records) : null, summary)
  // results.json goes last: a death before it leaves the old state, so the rerun repeats this batch
  // against the same previous run instead of against itself.
  if (prev) writeAtomic(join(run.outDir, 'results.prev.json'), prev.text)
  writeAtomic(join(run.outDir, 'summary.md'), summary)
  writeAtomic(join(run.outDir, 'tracking-issue.md'), body)
  writeAtomic(resultsPath, JSON.stringify({ cursor: next, records }, null, 2))
  log(`wrote ${swept.length} records to ${run.outDir}`)
}
