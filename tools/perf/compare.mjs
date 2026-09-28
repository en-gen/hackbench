#!/usr/bin/env node
// Detector (design section 4). Statistics are plain exported functions so
// tests call them directly; the bottom of this file is the CLI wrapper.
//
// Input: a "paired" document produced by paired.mjs -
//   { schema: 1, suite, baseRounds: [resultDoc, ...], candRounds: [resultDoc, ...] }
// where baseRounds[i] pairs with candRounds[i] (paired.mjs alternates base,
// cand per round so round i of each side ran back to back).

import { familyOf, validate as validateResultDoc } from './results.mjs'

export const THRESHOLDS = { core: 0.1, app: 0.15, startup: 0.15 }
export const HEAP_MIN_ABS_BYTES = 64 * 1024
export const HEAP_RELATIVE_FRACTION = 0.25
export const DEFAULT_RESAMPLES = 2000

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
 *  replacement `resamples` times using `rng` (a 0..1 generator). Paired
 *  values (ratios or differences) are resampled as whole pairs by resampling
 *  their shared index, which this takes care of by resampling `values`
 *  itself: each entry already IS one round's paired statistic. */
export function bootstrapMedianCI(
  values,
  { resamples = DEFAULT_RESAMPLES, rng = Math.random } = {},
) {
  if (values.length === 0) throw new Error('bootstrap of empty array')
  const estimate = median(values)
  if (values.length === 1) return { estimate, lower: estimate, upper: estimate }
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

/** Round value for one id: the median of that round's samples, or undefined
 *  when the round's result doc does not carry that id. */
function roundValueFor(resultDoc, id) {
  const r = resultDoc.results.find(x => x.id === id)
  return r ? median(r.samples) : undefined
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
  return THRESHOLDS[family] ?? THRESHOLDS.core
}

/** Verdict for one id, given its per-round base and cand result docs (same
 *  length, index i of base pairs with index i of cand). */
export function verdictForId(
  id,
  baseRounds,
  candRounds,
  { resamples = DEFAULT_RESAMPLES, rng = Math.random } = {},
) {
  const family = familyOf(id)
  const baseVals = baseRounds.map(d => roundValueFor(d, id))
  const candVals = candRounds.map(d => roundValueFor(d, id))
  const pairedBase = []
  const pairedCand = []
  for (let i = 0; i < baseVals.length; i++) {
    if (baseVals[i] !== undefined && candVals[i] !== undefined) {
      pairedBase.push(baseVals[i])
      pairedCand.push(candVals[i])
    }
  }
  if (pairedBase.length === 0) {
    throw new Error(`id ${id}: no round has this id on both sides`)
  }

  const baseMedian = median(pairedBase)
  const candMedian = median(pairedCand)

  if (family === 'heap') {
    const diffs = pairedBase.map((b, i) => pairedCand[i] - b)
    const ci = bootstrapMedianCI(diffs, { resamples, rng })
    const threshold = Math.max(HEAP_RELATIVE_FRACTION * Math.abs(baseMedian), HEAP_MIN_ABS_BYTES)
    let verdict = 'ok'
    if (ci.lower > threshold) verdict = 'regression'
    else if (ci.upper < -threshold) verdict = 'improvement'
    return {
      id,
      family,
      baseMedian,
      candMedian,
      metric: 'difference',
      estimate: ci.estimate,
      lower: ci.lower,
      upper: ci.upper,
      threshold,
      verdict,
    }
  }

  const ratios = pairedBase.map((b, i) => pairedCand[i] / b)
  const ci = bootstrapMedianCI(ratios, { resamples, rng })
  const threshold = thresholdFor(family)
  let verdict = 'ok'
  if (ci.lower > 1 + threshold) verdict = 'regression'
  else if (ci.upper < 1 - threshold) verdict = 'improvement'
  return {
    id,
    family,
    baseMedian,
    candMedian,
    metric: 'ratio',
    estimate: ci.estimate,
    lower: ci.lower,
    upper: ci.upper,
    threshold,
    verdict,
  }
}

/** Compares every id across both sides. Ids present on only one side are
 *  reported as added/removed, never compared (design section 4, point 6). */
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

export function overallExitCode(verdicts) {
  return verdicts.some(v => v.verdict === 'regression') ? 1 : 0
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
      `| ${v.id} | ${fmt(v.baseMedian)} | ${v.candMedian !== undefined ? fmt(v.candMedian) : '-'} | ${ratioCell} | [${fmt(v.lower)}, ${fmt(v.upper)}] | ${v.verdict} |`,
    )
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { seed: 1, resamples: DEFAULT_RESAMPLES }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--in') args.in = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--md') args.md = argv[++i]
    else if (a === '--seed') args.seed = Number(argv[++i])
    else if (a === '--resamples') args.resamples = Number(argv[++i])
  }
  return args
}

function validatePairedDoc(doc) {
  if (doc === null || typeof doc !== 'object') throw new Error('paired document must be an object')
  if (!Array.isArray(doc.baseRounds) || doc.baseRounds.length === 0)
    throw new Error('baseRounds must be a non-empty array')
  if (!Array.isArray(doc.candRounds) || doc.candRounds.length === 0)
    throw new Error('candRounds must be a non-empty array')
  for (const d of [...doc.baseRounds, ...doc.candRounds]) validateResultDoc(d)
}

export async function runCli(argv, io = {}) {
  const fs = io.fs ?? (await import('node:fs/promises'))
  const log = io.log ?? console.log
  const err = io.err ?? console.error
  const args = parseArgs(argv)
  if (!args.in) {
    err('usage: compare.mjs --in <paired.json> [--out verdict.json] [--md table.md] [--seed N]')
    return 2
  }
  let doc
  try {
    const text = await fs.readFile(args.in, 'utf8')
    doc = JSON.parse(text)
    validatePairedDoc(doc)
  } catch (e) {
    err(`malformed input: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }

  let verdicts
  try {
    const rng = mulberry32(args.seed)
    verdicts = compareRounds(doc.baseRounds, doc.candRounds, { resamples: args.resamples, rng })
  } catch (e) {
    err(`malformed input: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }

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
  return overallExitCode(verdicts)
}

// Windows paths need the backslash-vs-URL dance; comparing basenames avoids it.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())

if (isMain) {
  runCli(process.argv.slice(2)).then(code => process.exit(code))
}
