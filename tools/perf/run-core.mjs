#!/usr/bin/env node
// Runs the core benchmark suite (test/perf/core/*.bench.ts) and writes one
// schema-1 result file (design section 1). This is what `npm run perf:core`
// and paired.mjs both invoke, always against the current working directory
// (paired.mjs sets that when it spawns this file; there is no --cwd flag).
//
//   node tools/perf/run-core.mjs --out <file> [--only id,id] [--plant id=factor]

import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeResultFile, computeHarness, SCHEMA } from './results.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

function gitSha(cwd) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git rev-parse HEAD failed in ${cwd}: ${res.stderr}`)
  return res.stdout.trim()
}

export function runCore({ out, only, plant } = {}) {
  const cwd = process.cwd()
  const scratch = mkdtempSync(join(tmpdir(), 'hb-perf-core-'))
  const ndjson = join(scratch, 'results.ndjson')
  try {
    const env = { ...process.env, HB_PERF_RESULTS_FILE: ndjson }
    // A leftover value inherited from the parent process would otherwise
    // silently scope or slow down a run that did not ask for either.
    delete env.HB_PERF_ONLY
    delete env.HB_PERF_PLANT
    if (only) env.HB_PERF_ONLY = only
    if (plant) env.HB_PERF_PLANT = plant

    const res = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--config',
        join(repoRoot, 'vitest.perf.config.ts'),
      ],
      { cwd, env, encoding: 'utf8', shell: false },
    )
    if (res.status !== 0) {
      throw new Error(`vitest run failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`)
    }

    const text = existsSync(ndjson) ? readFileSync(ndjson, 'utf8') : ''
    const lines = text.split('\n').filter(Boolean)
    if (lines.length === 0) {
      throw new Error('perf:core produced no results; a suite that measured nothing must fail')
    }
    const results = lines.map(line => JSON.parse(line))

    const expectedIds = new Set(only ? only.split(',').map(s => s.trim()) : [])
    if (plant) expectedIds.add(plant.slice(0, plant.lastIndexOf('=')))
    const gotIds = new Set(results.map(r => r.id))
    for (const id of expectedIds) {
      if (!gotIds.has(id)) throw new Error(`perf:core: requested id '${id}' produced no result`)
    }

    const doc = {
      schema: SCHEMA,
      sha: gitSha(cwd),
      suite: 'core',
      harness: computeHarness(cwd),
      results,
    }
    if (out) writeResultFile(out, doc)
    return doc
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const CLI_OPTIONS = {
  out: { type: 'string' },
  only: { type: 'string' },
  plant: { type: 'string' },
}

// Same invoked-directly test as tools/scripts/check-content.mjs.
const isMain = /run-core\.mjs$/i.test(process.argv[1] ?? '')
if (isMain) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: CLI_OPTIONS, strict: true })
  if (!values.out) {
    console.error('usage: run-core.mjs --out <file> [--only id,id] [--plant id=factor]')
    process.exit(2)
  }
  try {
    runCore(values)
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
}
