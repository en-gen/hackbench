#!/usr/bin/env node
// Runs the app perf suite (theia/browser-app/perf/*.perf.cjs) against the
// build:browser output of the current working directory and writes one
// schema-1 result file (design section 1). Shape mirrors run-core.mjs.
//
//   node tools/perf/run-app.mjs --out <file> [--only id,id] [--plant id=factor]
//
// It owns an isolated test server for the whole run: random port, its own
// app data and THEIA_CONFIG_DIR (start-test-server.cjs's prepareTestServer),
// no window (the backend is headless; Playwright's chromium runs headless).
// --plant is a CPU-throttle factor the specs apply to that one id.

import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeResultFile, computeHarness, SCHEMA } from './results.mjs'

function gitSha(cwd) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git rev-parse HEAD failed in ${cwd}: ${res.stderr}`)
  return res.stdout.trim()
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

async function waitUntilUp(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(url)
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`backend at ${url} did not come up`)
      await new Promise(r => setTimeout(r, 500))
    }
  }
}

/** The isolated backend for `cwd`'s build. Injected in tests. */
export async function startServer(cwd) {
  const req = createRequire(join(cwd, 'theia', 'browser-app', 'package.json'))
  const { prepareTestServer } = req('./test/start-test-server.cjs')
  const { startBackend, stopBackend } = req('./test/own-backend.cjs')
  const port = await freePort()
  const { root, env } = prepareTestServer(port)
  const child = startBackend(port, { env })
  const url = `http://127.0.0.1:${port}`
  try {
    await waitUntilUp(url)
  } catch (err) {
    stopBackend(child)
    rmSync(root, { recursive: true, force: true })
    throw err
  }
  return {
    url,
    root,
    stop() {
      stopBackend(child)
      rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

/** The environment the Playwright run needs; undefined options are left unset, never inherited. */
export function appEnv({ base = process.env, url, root, ndjson, only, plant }) {
  const env = { ...base, HB_APP_URL: url, HB_TEST_APPDATA: root, HB_PERF_RESULTS_FILE: ndjson }
  delete env.HB_PERF_ONLY
  delete env.HB_PERF_PLANT
  if (only) env.HB_PERF_ONLY = only
  if (plant) env.HB_PERF_PLANT = plant
  return env
}

export async function runApp({ out, only, plant } = {}, deps = {}) {
  const cwd = process.cwd()
  const start = deps.startServer ?? startServer
  const scratch = mkdtempSync(join(tmpdir(), 'hb-perf-app-'))
  const ndjson = join(scratch, 'results.ndjson')
  const server = await start(cwd)
  try {
    const appDir = join(cwd, 'theia', 'browser-app')
    const cli =
      deps.playwrightCli ??
      createRequire(join(appDir, 'package.json')).resolve('@playwright/test/cli')
    const res = spawnSync(process.execPath, [cli, 'test', '-c', 'playwright.perf.config.cjs'], {
      cwd: appDir,
      env: appEnv({ url: server.url, root: server.root, ndjson, only, plant }),
      encoding: 'utf8',
      shell: false,
    })
    if (res.status !== 0) {
      throw new Error(
        `playwright perf run failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
      )
    }

    const text = existsSync(ndjson) ? readFileSync(ndjson, 'utf8') : ''
    const lines = text.split('\n').filter(Boolean)
    if (lines.length === 0) {
      throw new Error('perf:app produced no results; a suite that measured nothing must fail')
    }
    const results = lines.map(line => JSON.parse(line))

    const expectedIds = new Set(only ? only.split(',').map(s => s.trim()) : [])
    if (plant) expectedIds.add(plant.slice(0, plant.lastIndexOf('=')))
    const gotIds = new Set(results.map(r => r.id))
    for (const id of expectedIds) {
      if (!gotIds.has(id)) throw new Error(`perf:app: requested id '${id}' produced no result`)
    }

    const doc = {
      schema: SCHEMA,
      sha: gitSha(cwd),
      suite: 'app',
      harness: computeHarness(cwd),
      results,
    }
    if (out) writeResultFile(out, doc)
    return doc
  } finally {
    server.stop()
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

const isMain = /run-app\.mjs$/i.test(process.argv[1] ?? '')
if (isMain) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: CLI_OPTIONS, strict: true })
  if (!values.out) {
    console.error('usage: run-app.mjs --out <file> [--only id,id] [--plant id=factor]')
    process.exit(2)
  }
  try {
    await runApp(values)
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
}
