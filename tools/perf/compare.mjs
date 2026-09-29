#!/usr/bin/env node
// Detector (design section 4). Statistics are plain exported functions so
// tests call them directly; the bottom of this file is the CLI wrapper.
//
// Input: a "paired" document produced by paired.mjs -
//   { schema: 1, suite, baseRounds: [resultDoc, ...], candRounds: [resultDoc, ...] }
// where baseRounds[i] pairs with candRounds[i] (paired.mjs runs ABBA order,
// design D3, but still pairs by round index).
//
// D1: every round doc carries a `harness` hash (results.mjs computeHarness).
// A base and cand round measured with different benchmark code compare
// nothing meaningful, so a harness mismatch is malformed input (exit 2).
// D2: fewer than MIN_PAIRS paired rounds for an id, or unequal round counts
// between the two sides, is also malformed input - the bootstrap needs a
// real sample to resample from.

import { parseArgs } from 'node:util'
import { familyOf, validate as validateResultDoc } from './results.mjs'

export const THRESHOLDS = { core: 0.1, app: 0.15, startup: 0.15 }
export const KNOWN_FAMILIES = new Set([...Object.keys(THRESHOLDS), 'heap'])
export const HEAP_MIN_ABS_BYTES = 64 * 1024
export const HEAP_RELATIVE_FRACTION = 0.25
export const DEFAULT_RESAMPLES = 2000
export const MIN_PAIRS = 5

// ---------------------------------------------------------------------------
// Small stats primitives
// ---------------------------------------------------------------------------

/** Median of a numeric array. Does not mutate its argument. */
export function median(values) {
  if (values.length === 0) throw new Error('median of empty array')
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Deterministic mulberry32 PRNG, so a verdict is reproducible from the file
 *  alone (design section 4, point 3). */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 95% bootstrap interval for the median of `values`, resampling with
 *  replacement `resamples` times using `rng` (a 0..1 generator). Each entry
 *  of `values` is already one round's paired statistic (a ratio or a
 *  difference), so resampling `values` itself resamples whole pairs. */
export function bootstrapMedianCI(
  values,
  { resamples = DEFAULT_RESAMPLES, rng = Math.random } = {},
) {
  if (values.length === 0) throw new Error('bootstrap of empty array')
  const estimate = median(values)
  const n = values.length
  const medians = new Array(resamples)
  for (let r = 0; r < resamples; r++) {
    const sample = new Array(n)
    for (let i = 0; i < n; i++) sample[i] = values[Math.floor(rng() * n)]
    medians[r] = median(sample)
  }
  medians.sort((a, b) => a - b)
  const lowerIdx = Math.floor(0.025 * resamples)
  const upperIdx = Math.min(resamples - 1, Math.ceil(0.975 * resamples) - 1)
  return { estimate, lower: medians[lowerIdx], upper: medians[upperIdx] }
}

// ---------------------------------------------------------------------------
// Per-id extraction and verdict
// ---------------------------------------------------------------------------

function expectedUnit(family) {
  return family === 'heap' ? 'bytes/cycle' : 'ms'
}

function roundEntry(resultDoc, id) {
  return resultDoc.results.find(x => x.id === id)
}

/** All ids present across every round of a side (base or cand), in first-seen order. */
function idsOf(rounds) {
  const seen = new Set()
  const order = []
  for (const doc of rounds) {
    for (const r of doc.results) {
      if (!seen.has(r.id)) {
        seen.add(r.id)
        order.push(r.id)
      }
    }
  }
  return order
}

function thresholdFor(family) {
  if (!Object.hasOwn(THRESHOLDS, family)) {
    throw new Error(`unknown perf family for a ratio comparison: ${family}`)
  }
  return THRESHOLDS[family]
}

/** Verdict for one id, given its per-round base and cand result docs (same
 *  length, index i of base pairs with index i of cand). Heap ids compare
 *  differences; every other family compares ratios - one shared shape:
 *  bootstrap the paired statistic's median, then check its interval against
 *  a threshold that is relative-to-1 for a ratio or absolute for heap. */
export function verdictForId(
  id,
  baseRounds,
  candRounds,
  { resamples = DEFAULT_RESAMPLES, rng = Math.random } = {},
) {
  const family = familyOf(id)
  if (!KNOWN_FAMILIES.has(family)) throw new Error(`unknown perf family: ${family}`)
  const isHeap = family === 'heap'

  const pairedBase = []
  const pairedCand = []
  for (let i = 0; i < baseRounds.length; i++) {
    const b = roundEntry(baseRounds[i], id)
    const c = roundEntry(candRounds[i], id)
    if (!b || !c) continue
    if (b.unit !== expectedUnit(family) || c.unit !== expectedUnit(family)) {
      throw new Error(
        `id ${id}: unit does not match family ${family} (expected ${expectedUnit(family)})`,
      )
    }
    pairedBase.push(median(b.samples))
    pairedCand.push(median(c.samples))
  }
  if (pairedBase.length < MIN_PAIRS) {
    throw new Error(
      `id ${id}: only ${pairedBase.length} paired round(s), need at least ${MIN_PAIRS} (design D2)`,
    )
  }

  const baseMedian = median(pairedBase)
  const candMedian = median(pairedCand)
  const paired = isHeap
    ? pairedBase.map((b, i) => pairedCand[i] - b)
    : pairedBase.map((b, i) => pairedCand[i] / b)
  const ci = bootstrapMedianCI(paired, { resamples, rng })
  const threshold = isHeap
    ? Math.max(HEAP_RELATIVE_FRACTION * Math.abs(baseMedian), HEAP_MIN_ABS_BYTES)
    : thresholdFor(family)
  const regressBound = isHeap ? threshold : 1 + threshold
  const improveBound = isHeap ? -threshold : 1 - threshold

  let verdict = 'ok'
  if (ci.lower > regressBound) verdict = 'regression'
  else if (ci.upper < improveBound) verdict = 'improvement'

  return {
    id,
    family,
    baseMedian,
    candMedian,
    metric: isHeap ? 'difference' : 'ratio',
    estimate: ci.estimate,
    lower: ci.lower,
    upper: ci.upper,
    threshold,
    verdict,
  }
}

/** Compares every id across both sides. An id present on only one side is
 *  reported as added/removed, never compared (design section 4, point 6).
 *  `removed` still fails the run (design D1): a benchmark that vanished
 *  needs the owner's acknowledgement the same way a regression does;
 *  `added` is informational only. */
export function compareRounds(baseRounds, candRounds, opts = {}) {
  const baseIds = new Set(idsOf(baseRounds))
  const candIds = new Set(idsOf(candRounds))
  const allIds = new Set([...baseIds, ...candIds])
  const verdicts = []
  for (const id of allIds) {
    if (baseIds.has(id) && !candIds.has(id)) {
      verdicts.push({ id, family: familyOf(id), verdict: 'removed' })
    } else if (!baseIds.has(id) && candIds.has(id)) {
      verdicts.push({ id, family: familyOf(id), verdict: 'added' })
    } else {
      verdicts.push(verdictForId(id, baseRounds, candRounds, opts))
    }
  }
  verdicts.sort((a, b) => a.id.localeCompare(b.id))
  return verdicts
}

export function toMarkdownTable(verdicts) {
  const lines = [
    '| id | base | cand | ratio | interval | verdict |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const v of verdicts) {
    if (v.verdict === 'added' || v.verdict === 'removed') {
      lines.push(`| ${v.id} | - | - | - | - | ${v.verdict} |`)
      continue
    }
    const fmt = n => (Number.isFinite(n) ? n.toPrecision(4) : String(n))
    const ratioCell = v.metric === 'ratio' ? fmt(v.estimate) : `${fmt(v.estimate)} (diff)`
    lines.push(
      `| ${v.id} | ${fmt(v.baseMedian)} | ${fmt(v.candMedian)} | ${ratioCell} | [${fmt(v.lower)}, ${fmt(v.upper)}] | ${v.verdict} |`,
    )
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const CLI_OPTIONS = {
  in: { type: 'string' },
  out: { type: 'string' },
  md: { type: 'string' },
  seed: { type: 'string', default: '1' },
  resamples: { type: 'string', default: String(DEFAULT_RESAMPLES) },
}

function validatePairedDoc(doc) {
  if (doc === null || typeof doc !== 'object') throw new Error('paired document must be an object')
  if (!Array.isArray(doc.baseRounds) || doc.baseRounds.length === 0) {
    throw new Error('baseRounds must be a non-empty array')
  }
  if (!Array.isArray(doc.candRounds) || doc.candRounds.length === 0) {
    throw new Error('candRounds must be a non-empty array')
  }
  if (doc.baseRounds.length !== doc.candRounds.length) {
    throw new Error(
      `baseRounds and candRounds must have equal length (design D2): ${doc.baseRounds.length} vs ${doc.candRounds.length}`,
    )
  }
  if (doc.schema !== 1) throw new Error(`paired document schema must be 1, got ${doc.schema}`)
  if (doc.suite !== 'core' && doc.suite !== 'app') {
    throw new Error(`paired document suite must be 'core' or 'app', got ${doc.suite}`)
  }
  for (const d of [...doc.baseRounds, ...doc.candRounds]) {
    validateResultDoc(d)
    if (d.suite !== doc.suite) {
      throw new Error(`round suite '${d.suite}' differs from document suite '${doc.suite}'`)
    }
  }

  const baseHarness = new Set(doc.baseRounds.map(d => d.harness))
  const candHarness = new Set(doc.candRounds.map(d => d.harness))
  if (baseHarness.size > 1)
    throw new Error(`baseRounds carry inconsistent harness hashes: ${[...baseHarness]}`)
  if (candHarness.size > 1)
    throw new Error(`candRounds carry inconsistent harness hashes: ${[...candHarness]}`)
  const [baseH] = baseHarness
  const [candH] = candHarness
  if (baseH !== candH) {
    throw new Error(
      `base and cand harness hashes differ (design D1): base ${baseH}, cand ${candH}. ` +
        'paired.mjs should have overlaid the candidate harness onto base before running it.',
    )
  }
}

function parseCliArgs(argv) {
  const { values } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true })
  const seed = Number(values.seed)
  const resamples = Number(values.resamples)
  if (!Number.isFinite(seed) || !Number.isInteger(seed)) {
    throw new Error(`--seed must be a finite integer, got ${JSON.stringify(values.seed)}`)
  }
  if (!Number.isInteger(resamples) || resamples < 1000) {
    throw new Error(
      `--resamples must be an integer >= 1000, got ${JSON.stringify(values.resamples)}`,
    )
  }
  return { in: values.in, out: values.out, md: values.md, seed, resamples }
}

export async function runCli(argv, io = {}) {
  const fs = io.fs ?? (await import('node:fs/promises'))
  const log = io.log ?? console.log
  const err = io.err ?? console.error

  let args
  try {
    args = parseCliArgs(argv)
    if (!args.in) throw new Error('--in <paired.json> is required')
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
    err(
      'usage: compare.mjs --in <paired.json> [--out verdict.json] [--md table.md] [--seed N] [--resamples N]',
    )
    return 2
  }

  let verdicts
  try {
    const doc = JSON.parse(await fs.readFile(args.in, 'utf8'))
    validatePairedDoc(doc)
    verdicts = compareRounds(doc.baseRounds, doc.candRounds, {
      resamples: args.resamples,
      rng: mulberry32(args.seed),
    })

    const verdictDoc = {
      schema: 1,
      suite: doc.suite,
      seed: args.seed,
      resamples: args.resamples,
      verdicts,
    }
    const md = toMarkdownTable(verdicts)
    if (args.out) await fs.writeFile(args.out, JSON.stringify(verdictDoc, null, 2) + '\n')
    if (args.md) await fs.writeFile(args.md, md)
    log(md)
  } catch (e) {
    err(`malformed input: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }

  return verdicts.some(v => v.verdict === 'regression' || v.verdict === 'removed') ? 1 : 0
}

// Same invoked-directly test as tools/scripts/check-content.mjs.
const isMain = /compare\.mjs$/i.test(process.argv[1] ?? '')
if (isMain) {
  runCli(process.argv.slice(2)).then(code => process.exit(code))
}
