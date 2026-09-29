#!/usr/bin/env node
// Runs the core benchmark suite (test/perf/core/*.bench.ts) and writes one
// schema-1 result file (design section 1). This is what `npm run perf:core`
// and paired.mjs both invoke, always against the current working directory
// (paired.mjs sets that when it spawns this file; there is no --cwd flag).
//
//   node tools/perf/run-core.mjs --out <file> [--only id,id] [--plant id=factor]

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeResultFile, collectDoc, perfEnv, cliMain } from './results.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function runCore({ out, only, plant } = {}) {
  const cwd = process.cwd()
  const scratch = mkdtempSync(join(tmpdir(), 'hb-perf-core-'))
  const ndjson = join(scratch, 'results.ndjson')
  try {
    const res = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--config',
        join(repoRoot, 'vitest.perf.config.ts'),
      ],
      {
        cwd,
        env: perfEnv({ ndjson, only, plant }),
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      },
    )
    if (res.status !== 0) {
      throw new Error(`vitest run failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`)
    }
    const doc = collectDoc({ suite: 'core', cwd, ndjson, only, plant })
    if (out) writeResultFile(out, doc)
    return doc
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// Same invoked-directly test as tools/scripts/check-content.mjs.
if (/run-core\.mjs$/i.test(process.argv[1] ?? '')) await cliMain('run-core.mjs', runCore)
