#!/usr/bin/env node
// Runs the app perf suite (theia/browser-app/perf/*.perf.cjs) against the
// build:browser output of the current working directory and writes one
// schema-1 result file (design section 1). Shape mirrors run-core.mjs.
//
//   node tools/perf/run-app.mjs --out <file> [--only id,id] [--plant id=factor]
//
// Two Playwright runs, each on its own fresh isolated server (random port,
// own app data and THEIA_CONFIG_DIR): startup first, so it and a later
// `--only` confirmation measure the same conditions, then the app and heap
// specs. --plant is a factor the specs apply to one id: a CPU throttle for
// the render-bound ids, retained memory for the heap ids.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeResultFile, collectDoc, perfEnv, cliMain } from './results.mjs'

/** Ids a plant can make slower honestly: a renderer CPU throttle only slows
 *  render-bound work, and the heap ids retain memory in the page. Ids whose
 *  time is spent in the backend are refused rather than planted in vain. */
export const PLANTABLE = new Set([
  'startup.shell',
  'app.open-maps',
  'app.open-map16',
  'app.open-gfx',
  'app.open-palette',
  'heap.map16-reopen',
  'heap.gfx-reopen',
  'heap.palette-reopen',
  'heap.maps-reopen',
])

const PHASES = [
  { files: ['startup.perf.cjs'], has: id => id.startsWith('startup.') },
  { files: ['app.perf.cjs', 'heap.perf.cjs'], has: id => !id.startsWith('startup.') },
]

/** The isolated backend for `cwd`'s build. Injected in tests. */
export async function startServer(cwd) {
  const req = createRequire(join(cwd, 'theia', 'browser-app', 'package.json'))
  return req('./test/start-test-server.cjs').startTestServer({ wait: true })
}

function gitHead(cwd) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true })
  return res.status === 0 ? res.stdout.trim() : undefined
}

/** Refuses a bundle that was not built from this checkout's HEAD. */
function checkStamp(cwd) {
  let stamp
  try {
    const file = join(cwd, 'theia', 'browser-app', 'lib', 'hb-build-stamp.json')
    stamp = JSON.parse(readFileSync(file, 'utf8')).sha
  } catch {
    throw new Error('no build stamp: run `yarn --cwd theia build:browser` in this checkout first')
  }
  const head = gitHead(cwd)
  if (stamp !== head) {
    throw new Error(`stale build: bundle built from ${stamp}, checkout is at ${head}; rebuild`)
  }
}

export async function runApp({ out, only, plant } = {}, deps = {}) {
  const plantId = plant?.slice(0, plant.lastIndexOf('='))
  if (plant && !PLANTABLE.has(plantId)) {
    throw new Error(
      `cannot plant '${plantId}': a renderer throttle only proves render-bound ids ` +
        `(${[...PLANTABLE].join(', ')})`,
    )
  }
  const cwd = process.cwd()
  checkStamp(cwd)
  const start = deps.startServer ?? startServer
  const appDir = join(cwd, 'theia', 'browser-app')
  const cli =
    deps.playwrightCli ??
    createRequire(join(appDir, 'package.json')).resolve('@playwright/test/cli')
  const ids = [...(only ? only.split(',').map(s => s.trim()) : []), ...(plant ? [plantId] : [])]

  let scratch
  const cleanup = () => scratch && rmSync(scratch, { recursive: true, force: true })
  const onSigint = () => (cleanup(), process.exit(130))
  process.once('SIGINT', onSigint)
  try {
    scratch = mkdtempSync(join(tmpdir(), 'hb-perf-app-'))
    const ndjson = join(scratch, 'results.ndjson')
    writeFileSync(ndjson, '')
    for (const phase of PHASES) {
      if (ids.length > 0 && !ids.some(phase.has)) continue
      const server = await start(cwd)
      try {
        const env = perfEnv({
          ndjson,
          only,
          plant,
          extra: { HB_APP_URL: server.url, HB_TEST_APPDATA: server.root },
        })
        const args = [cli, 'test', '-c', 'playwright.perf.config.cjs', ...phase.files]
        const res = spawnSync(process.execPath, args, {
          cwd: appDir,
          env,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
        })
        if (res.status !== 0) {
          throw new Error(
            `playwright perf run failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
          )
        }
      } finally {
        server.stop()
      }
    }
    const doc = collectDoc({ suite: 'app', cwd, ndjson, only, plant })
    if (out) writeResultFile(out, doc)
    return doc
  } finally {
    process.removeListener('SIGINT', onSigint)
    cleanup()
  }
}

if (/run-app\.mjs$/i.test(process.argv[1] ?? '')) await cliMain('run-app.mjs', runApp)
