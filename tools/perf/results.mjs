// Perf result format (design section 1): one JSON file per suite run, schema 1.
// Nothing downstream knows which tool produced it, so this is the only place
// that reads or writes the shape. A suite that measured nothing must fail,
// never report green: validate() rejects an empty results array and any
// result with no samples.
//
// `harness` (design decision D1) is a sha256 of the benchmark code that
// produced this doc - test/perf/**, vitest.perf.config.ts and
// tools/perf/run-core.mjs, relative to the directory that ran the suite.
// paired.mjs overlays the candidate's copies of those files onto the base
// directory before running base, so a base round and a cand round always
// carry the SAME code even when the repos differ (a renamed or added bench
// case would otherwise silently compare against stale harness code, or
// simply not exist on one side). compare.mjs refuses to compare two sides
// whose harness hashes differ.

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

export const SCHEMA = 1
const UNITS = new Set(['ms', 'bytes/cycle'])
const BETTER = new Set(['lower'])

/** First dotted segment of an id, e.g. "core" from "core.lclz2.decompress.x". */
export function familyOf(id) {
  const i = id.indexOf('.')
  return i === -1 ? id : id.slice(0, i)
}

function walk(path, out) {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return
  if (st.isFile()) return void out.push(path)
  for (const entry of readdirSync(path)) walk(join(path, entry), out)
}

/** Every file that decides what a perf run measures, relative to a checkout.
 *  Hashed by computeHarness and overlaid by paired.mjs (design D1), so both
 *  sides run the same harness. Known limit: the mark call sites inside
 *  widgets are app code, not harness, and are not covered. */
export const HARNESS_PATHS = [
  'test/perf',
  'vitest.perf.config.ts',
  'tools/perf/run-core.mjs',
  'tools/perf/run-app.mjs',
  'theia/browser-app/perf',
  'theia/browser-app/playwright.perf.config.cjs',
  'theia/browser-app/test/start-test-server.cjs',
  'theia/browser-app/test/own-backend.cjs',
  'theia/browser-app/test/app-data.cjs',
  'theia/extension/src/common/perf-marks.ts',
  'test/suite/support/corpus.cjs',
]

/** sha256 of HARNESS_PATHS under `dir`, in a fixed (sorted, path-relative)
 *  order so it is stable across machines and checkouts. A missing path is
 *  simply absent from the hash. */
export function computeHarness(dir) {
  const files = []
  for (const rel of HARNESS_PATHS) walk(join(dir, rel), files)
  files.sort()
  const hash = createHash('sha256')
  for (const f of files) {
    hash.update(relative(dir, f).split('\\').join('/'))
    hash.update('\0')
    hash.update(readFileSync(f))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function gitSha(cwd) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true })
  if (res.status !== 0) throw new Error(`git rev-parse HEAD failed in ${cwd}: ${res.stderr}`)
  return res.stdout.trim()
}

/** The env for a suite child: results file set, stale only/plant never inherited. */
export function perfEnv({ base = process.env, ndjson, only, plant, extra = {} }) {
  const env = { ...base, ...extra, HB_PERF_RESULTS_FILE: ndjson }
  delete env.HB_PERF_ONLY
  delete env.HB_PERF_PLANT
  if (only) env.HB_PERF_ONLY = only
  if (plant) env.HB_PERF_PLANT = plant
  return env
}

/** Reads a suite's NDJSON into a schema-1 doc. Fails on no results, and on a
 *  requested --only or plant id that produced none. */
export function collectDoc({ suite, cwd, ndjson, only, plant }) {
  const text = existsSync(ndjson) ? readFileSync(ndjson, 'utf8') : ''
  const results = text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  if (results.length === 0) {
    throw new Error(`perf:${suite} produced no results; a suite that measured nothing must fail`)
  }
  const expected = new Set(only ? only.split(',').map(s => s.trim()) : [])
  if (plant) expected.add(plant.slice(0, plant.lastIndexOf('=')))
  const got = new Set(results.map(r => r.id))
  for (const id of expected) {
    if (!got.has(id)) throw new Error(`perf:${suite}: requested id '${id}' produced no result`)
  }
  return { schema: SCHEMA, sha: gitSha(cwd), suite, harness: computeHarness(cwd), results }
}

/** The shared CLI tail of run-core.mjs and run-app.mjs. */
export async function cliMain(name, run) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { out: { type: 'string' }, only: { type: 'string' }, plant: { type: 'string' } },
    strict: true,
  })
  if (!values.out) {
    console.error(`usage: ${name} --out <file> [--only id,id] [--plant id=factor]`)
    process.exit(2)
  }
  try {
    await run(values)
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
}

/** Throws a descriptive Error on the first thing wrong with `doc`. */
export function validate(doc) {
  if (doc === null || typeof doc !== 'object') throw new Error('result document must be an object')
  if (doc.schema !== SCHEMA) throw new Error(`unsupported schema: ${JSON.stringify(doc.schema)}`)
  if (typeof doc.sha !== 'string' || doc.sha.length === 0) {
    throw new Error('sha must be a non-empty string')
  }
  if (typeof doc.suite !== 'string' || doc.suite.length === 0) {
    throw new Error('suite must be a non-empty string')
  }
  if (typeof doc.harness !== 'string' || doc.harness.length === 0) {
    throw new Error('harness must be a non-empty string (sha256 of the benchmark code, design D1)')
  }
  if (!Array.isArray(doc.results) || doc.results.length === 0) {
    throw new Error('results must be a non-empty array; a suite that measured nothing must fail')
  }
  const ids = new Set()
  for (const r of doc.results) {
    if (r === null || typeof r !== 'object') throw new Error('each result must be an object')
    if (typeof r.id !== 'string' || r.id.length === 0) {
      throw new Error('result id must be a non-empty string')
    }
    if (ids.has(r.id)) throw new Error(`duplicate result id: ${r.id}`)
    ids.add(r.id)
    if (!UNITS.has(r.unit))
      throw new Error(`result ${r.id}: unsupported unit ${JSON.stringify(r.unit)}`)
    if (!BETTER.has(r.better))
      throw new Error(`result ${r.id}: unsupported better ${JSON.stringify(r.better)}`)
    if (!Array.isArray(r.samples) || r.samples.length === 0) {
      throw new Error(`result ${r.id}: samples must be a non-empty array`)
    }
    for (const s of r.samples) {
      if (typeof s !== 'number' || !Number.isFinite(s)) {
        throw new Error(`result ${r.id}: sample is not a finite number: ${JSON.stringify(s)}`)
      }
      if (r.unit === 'ms' && s <= 0) {
        throw new Error(`result ${r.id}: ms sample must be > 0, got ${s}`)
      }
    }
  }
  return doc
}

export function readResultFile(path) {
  return validate(JSON.parse(readFileSync(path, 'utf8')))
}

export function writeResultFile(path, doc) {
  validate(doc)
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
}
