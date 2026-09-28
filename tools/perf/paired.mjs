#!/usr/bin/env node
// Paired runner (design section 3).
//
//   node tools/perf/paired.mjs --base <dir> --cand <dir> --suite core|app
//        [--rounds N] [--only id,id] [--plant <id>=<factor>] --out <file>
//
// Alternates base, cand, base, cand for N rounds, running the suite's own
// command inside each built checkout (`<dir>/tools/perf/run-core.mjs` for
// core), so the same tool measures exactly what CI measured: this script
// never imports the suite directly, only shells out into each `<dir>`.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validate as validateResultDoc } from './results.mjs'

export const DEFAULT_ROUNDS = { core: 10, app: 6 }

export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') args.base = argv[++i]
    else if (a === '--cand') args.cand = argv[++i]
    else if (a === '--suite') args.suite = argv[++i]
    else if (a === '--rounds') args.rounds = Number(argv[++i])
    else if (a === '--only') args.only = argv[++i]
    else if (a === '--plant') args.plant = argv[++i]
    else if (a === '--out') args.out = argv[++i]
  }
  return args
}

/** One entry per known suite: how to run it inside a built checkout. Only
 *  `core` is wired; `app` is the hook PR 2 fills in (task item 3). */
export const SUITE_HOOKS = {
  core: (dir, { out, only, plant }) => {
    const args = ['tools/perf/run-core.mjs', '--out', out]
    if (only) args.push('--only', only)
    if (plant) args.push('--plant', plant)
    return { cmd: process.execPath, args, cwd: dir }
  },
  app: () => {
    throw new Error(
      'the app suite hook lands in PR 2 (perf-app); core is the only suite paired.mjs runs today',
    )
  },
}

function runSuiteOnce(suite, dir, opts) {
  const hook = SUITE_HOOKS[suite]
  if (!hook) throw new Error(`unknown suite: ${suite}`)
  const { cmd, args, cwd } = hook(dir, opts)
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(
      `suite '${suite}' failed in ${dir} (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
    )
  }
  const text = readFileSync(opts.out, 'utf8')
  const doc = JSON.parse(text)
  validateResultDoc(doc)
  return doc
}

/** Runs N paired rounds, alternating base then cand each round. Returns the
 *  paired document compare.mjs expects. Throws on the first failed round;
 *  a paired run is only meaningful as a complete set. */
export function runPaired({ base, cand, suite, rounds, only, plant }) {
  if (!existsSync(base)) throw new Error(`--base directory does not exist: ${base}`)
  if (!existsSync(cand)) throw new Error(`--cand directory does not exist: ${cand}`)
  const n = rounds ?? DEFAULT_ROUNDS[suite] ?? DEFAULT_ROUNDS.core

  const scratch = mkdtempSync(join(tmpdir(), 'hb-perf-paired-'))
  try {
    const baseRounds = []
    const candRounds = []
    for (let i = 0; i < n; i++) {
      const baseOut = join(scratch, `base-${i}.json`)
      baseRounds.push(runSuiteOnce(suite, base, { out: baseOut, only }))
      const candOut = join(scratch, `cand-${i}.json`)
      // Plant only applies to the candidate: it simulates a regression the
      // candidate introduced, not one the baseline already had.
      candRounds.push(runSuiteOnce(suite, cand, { out: candOut, only, plant }))
    }
    return {
      schema: 1,
      suite,
      rounds: n,
      generatedAt: new Date().toISOString(),
      baseRounds,
      candRounds,
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.base || !args.cand || !args.suite || !args.out) {
    console.error(
      'usage: paired.mjs --base <dir> --cand <dir> --suite core|app [--rounds N] [--only id,id] [--plant id=factor] --out <file>',
    )
    process.exit(2)
  }
  try {
    const doc = runPaired(args)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(args.out, JSON.stringify(doc, null, 2) + '\n')
    console.log(`wrote ${args.out}: ${doc.rounds} rounds, suite ${doc.suite}`)
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
}
