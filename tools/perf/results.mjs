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

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
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

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
}

/** sha256 of the benchmark harness rooted at `dir`: every file under
 *  test/perf, theia/browser-app/perf, plus vitest.perf.config.ts,
 *  playwright.perf.config.cjs, tools/perf/run-core.mjs and run-app.mjs,
 *  hashed in a fixed (sorted, path-relative) order so it is stable across
 *  machines and checkouts. */
export function computeHarness(dir) {
  const files = []
  const perfDir = join(dir, 'test', 'perf')
  try {
    if (statSync(perfDir).isDirectory()) walk(perfDir, files)
  } catch {
    // no test/perf directory at all: hash proceeds with just the two named files
  }
  for (const f of [
    join(dir, 'vitest.perf.config.ts'),
    join(dir, 'tools', 'perf', 'run-core.mjs'),
    join(dir, 'tools', 'perf', 'run-app.mjs'),
    join(dir, 'theia', 'browser-app', 'playwright.perf.config.cjs'),
  ]) {
    try {
      if (statSync(f).isFile()) files.push(f)
    } catch {
      // missing harness file: absence is itself part of what gets hashed via its omission
    }
  }
  // The app suite's harness (design section 2): its specs and config.
  const appPerf = join(dir, 'theia', 'browser-app', 'perf')
  try {
    if (statSync(appPerf).isDirectory()) walk(appPerf, files)
  } catch {
    // no app perf directory: absent, like the other missing harness files
  }
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
