#!/usr/bin/env node
// Runs the core benchmark suite (test/perf/core/*.bench.ts) and writes one
// schema-1 result file (design section 1). This is what `npm run perf:core`
// and paired.mjs's core suite hook both invoke.
//
//   node tools/perf/run-core.mjs --out <file> [--only id,id] [--plant id=factor]

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeResultFile, SCHEMA } from './results.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') args.out = argv[++i]
    else if (a === '--only') args.only = argv[++i]
    else if (a === '--plant') args.plant = argv[++i]
    else if (a === '--cwd') args.cwd = argv[++i]
  }
  return args
}

function gitSha(cwd) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  return res.status === 0 ? res.stdout.trim() : 'unknown'
}

export function runCore({ out, only, plant, cwd = process.cwd() } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'hb-perf-core-'))
  const ndjson = join(scratch, 'results.ndjson')
  try {
    const env = { ...process.env, HB_PERF_RESULTS_FILE: ndjson }
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
    const doc = { schema: SCHEMA, sha: gitSha(cwd), suite: 'core', results }
    if (out) writeResultFile(out, doc)
    return doc
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.out) {
    console.error('usage: run-core.mjs --out <file> [--only id,id] [--plant id=factor]')
    process.exit(2)
  }
  try {
    runCore(args)
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
}
