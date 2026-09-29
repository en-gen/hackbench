#!/usr/bin/env node
// Paired runner (design section 3).
//
//   node tools/perf/paired.mjs --base <dir> --cand <dir> --suite core
//        [--rounds N] [--only id,id] [--plant <id>=<factor>] --out <file>
//
// Runs base and cand ABBA (design D3: base,cand,cand,base,... in blocks of
// two rounds) rather than strict alternation, so a linear drift across the
// whole run (machine warming up, thermal throttling) cancels out instead of
// biasing one side. Rounds are still paired by index: baseRounds[i] is
// compared against candRounds[i] regardless of execution order.
//
// D1: before any round runs, the candidate's test/perf/**,
// vitest.perf.config.ts and tools/perf/run-core.mjs are overlaid onto the
// base directory (and restored afterwards), so base and cand always measure
// with the SAME benchmark code - a renamed or newly added case would
// otherwise compare against stale harness code on one side, or simply not
// exist there. Only the `core` suite is wired; `app` lands in PR 2.

import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validate as validateResultDoc } from './results.mjs'

export const CORE_DEFAULT_ROUNDS = 10
export const MIN_ROUNDS = 5
const HARNESS_PATHS = ['test/perf', 'vitest.perf.config.ts', join('tools', 'perf', 'run-core.mjs')]

function runSuiteOnce(dir, { out, only, plant }) {
  const args = ['tools/perf/run-core.mjs', '--out', out]
  if (only) args.push('--only', only)
  if (plant) args.push('--plant', plant)
  const res = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(
      `core suite failed in ${dir} (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
    )
  }
  const doc = JSON.parse(readFileSync(out, 'utf8'))
  validateResultDoc(doc)
  return doc
}

/** Overlays candDir's harness files onto baseDir (design D1) and returns a
 *  restore function that puts baseDir back exactly as it was. A no-op when
 *  the two directories are the same path. */
export function overlayHarness(baseDir, candDir) {
  if (resolve(baseDir) === resolve(candDir)) return () => {}

  const backupDir = mkdtempSync(join(tmpdir(), 'hb-perf-harness-backup-'))
  // Back up everything before touching baseDir, so a failed backup leaves the
  // base exactly as it was.
  try {
    for (const rel of HARNESS_PATHS) {
      const basePath = join(baseDir, rel)
      if (existsSync(basePath)) cpSync(basePath, join(backupDir, rel), { recursive: true })
    }
  } catch (e) {
    rmSync(backupDir, { recursive: true, force: true })
    throw e
  }

  function restore() {
    for (const rel of HARNESS_PATHS) rmSync(join(baseDir, rel), { recursive: true, force: true })
    for (const rel of HARNESS_PATHS) {
      const backupPath = join(backupDir, rel)
      if (existsSync(backupPath)) cpSync(backupPath, join(baseDir, rel), { recursive: true })
    }
    rmSync(backupDir, { recursive: true, force: true })
  }

  try {
    for (const rel of HARNESS_PATHS) rmSync(join(baseDir, rel), { recursive: true, force: true })
    for (const rel of HARNESS_PATHS) {
      const candPath = join(candDir, rel)
      if (existsSync(candPath)) cpSync(candPath, join(baseDir, rel), { recursive: true })
    }
  } catch (e) {
    restore()
    throw e
  }
  return restore
}

/** ABBA execution order (design D3) as a flat list of {round, side}. Rounds
 *  are grouped in twos: base_i, cand_i, cand_{i+1}, base_{i+1}. A trailing
 *  unpaired round (odd `n`) just runs base then cand. */
export function abbaSchedule(n) {
  const schedule = []
  let i = 0
  while (i < n) {
    if (i + 1 < n) {
      schedule.push({ round: i, side: 'base' }, { round: i, side: 'cand' })
      schedule.push({ round: i + 1, side: 'cand' }, { round: i + 1, side: 'base' })
      i += 2
    } else {
      schedule.push({ round: i, side: 'base' }, { round: i, side: 'cand' })
      i += 1
    }
  }
  return schedule
}

/** Runs N paired rounds ABBA (design D3). Returns the paired document
 *  compare.mjs expects. Throws on the first failed round; a paired run is
 *  only meaningful as a complete set. */
export function runPaired({ base, cand, suite, rounds, only, plant }) {
  if (suite !== 'core')
    throw new Error(`unsupported suite: ${suite} (only 'core' is wired; app lands in PR 2)`)
  if (!existsSync(base)) throw new Error(`--base directory does not exist: ${base}`)
  if (!existsSync(cand)) throw new Error(`--cand directory does not exist: ${cand}`)
  const n = rounds ?? CORE_DEFAULT_ROUNDS
  if (!Number.isInteger(n) || n < MIN_ROUNDS) {
    throw new Error(
      `--rounds must be an integer >= ${MIN_ROUNDS} (design D2), got ${JSON.stringify(rounds)}`,
    )
  }

  const restoreHarness = overlayHarness(base, cand)
  const scratch = mkdtempSync(join(tmpdir(), 'hb-perf-paired-'))
  try {
    const baseRounds = new Array(n)
    const candRounds = new Array(n)
    for (const { round, side } of abbaSchedule(n)) {
      const dir = side === 'base' ? base : cand
      const out = join(scratch, `${side}-${round}.json`)
      // Plant only applies to the candidate: it simulates a regression the
      // candidate introduced, not one the baseline already had.
      const doc = runSuiteOnce(dir, { out, only, plant: side === 'cand' ? plant : undefined })
      if (side === 'base') baseRounds[round] = doc
      else candRounds[round] = doc
    }
    return { schema: 1, suite, rounds: n, baseRounds, candRounds }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    restoreHarness()
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const CLI_OPTIONS = {
  base: { type: 'string' },
  cand: { type: 'string' },
  suite: { type: 'string' },
  rounds: { type: 'string' },
  only: { type: 'string' },
  plant: { type: 'string' },
  out: { type: 'string' },
}

// Same invoked-directly test as tools/scripts/check-content.mjs.
const isMain = /paired\.mjs$/i.test(process.argv[1] ?? '')
if (isMain) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: CLI_OPTIONS, strict: true })
  if (!values.base || !values.cand || !values.suite || !values.out) {
    console.error(
      'usage: paired.mjs --base <dir> --cand <dir> --suite core [--rounds N] [--only id,id] [--plant id=factor] --out <file>',
    )
    process.exit(2)
  }
  try {
    const doc = runPaired({ ...values, rounds: values.rounds ? Number(values.rounds) : undefined })
    writeFileSync(values.out, JSON.stringify(doc, null, 2) + '\n')
    console.log(`wrote ${values.out}: ${doc.rounds} rounds, suite ${doc.suite}`)
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
}
