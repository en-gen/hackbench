/**
 * Proof that the app half of the perf gates (issue #414) can fail: the marks
 * fail closed, the heap slope is a real least-squares slope, run-app.mjs
 * refuses a run that measured nothing, --plant reaches only the candidate,
 * and the e2e Playwright config never collects a perf spec. No ROM, no
 * browser: spawnSync and the server are mocked.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn() }
})

import { spawnSync } from 'node:child_process'
import { appEnv, runApp } from '../../../tools/perf/run-app.mjs'
import { runPaired } from '../../../tools/perf/paired.mjs'
import { perfEnd, perfStart } from '../../../theia/extension/src/common/perf-marks'

const repoRoot = path.resolve(__dirname, '../../..')
const require = createRequire(import.meta.url)
const support = require('../../../theia/browser-app/perf/support.cjs')
const mockedSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>

describe('perf-marks', () => {
  beforeEach(() => {
    performance.clearMarks()
    performance.clearMeasures()
  })

  it('a start and an end record one hb: measure', () => {
    perfStart('t')
    expect(perfEnd('t')).toBe(true)
    expect(performance.getEntriesByName('hb:t', 'measure')).toHaveLength(1)
  })

  it('an end with no pending start records nothing, and a repaint cannot record twice', () => {
    expect(perfEnd('t')).toBe(false)
    perfStart('t')
    perfEnd('t')
    expect(perfEnd('t')).toBe(false)
    expect(performance.getEntriesByName('hb:t', 'measure')).toHaveLength(1)
  })

  it('a missing perfEnd leaves no measure, and the spec reader throws instead of returning 0', () => {
    perfStart('t')
    const entries = performance.getEntriesByType('measure')
    expect(() => support.measureOf(entries, 't')).toThrow(/no 'hb:t' measure/)
  })
})

describe('support.cjs', () => {
  it('heapSlope recovers a planted slope through noise, and reads a flat series as ~0', () => {
    const noise = [3, -2, 5, -4, 1, -3, 2, -1, 4, -5]
    const rising = noise.map((n, i) => 1_000_000 + 4096 * i + n * 10)
    expect(support.heapSlope(rising)).toBeCloseTo(4096, -1)
    expect(Math.abs(support.heapSlope(noise.map(n => 1_000_000 + n)))).toBeLessThan(2)
  })

  it('heapSlope is exact on a line and refuses fewer than two points', () => {
    expect(support.heapSlope([10, 30, 50, 70])).toBe(20)
    expect(() => support.heapSlope([1])).toThrow()
  })

  it('measureOf refuses a zero-length measure', () => {
    expect(() => support.measureOf([{ name: 'hb:t', duration: 0 }], 't')).toThrow(/measured 0/)
  })

  it('parsePlant refuses a factor below 1, a non-number and a missing id', () => {
    expect(support.parsePlant('app.x=3')).toEqual({ id: 'app.x', factor: 3 })
    for (const bad of ['app.x=0.5', 'app.x=fast', '=3', 'app.x']) {
      expect(() => support.parsePlant(bad)).toThrow(/bad plant/)
    }
  })

  it('shouldRun follows HB_PERF_ONLY', () => {
    expect(support.shouldRun('a', undefined)).toBe(true)
    expect(support.shouldRun('a', 'a,b')).toBe(true)
    expect(support.shouldRun('c', 'a, b')).toBe(false)
  })
})

describe('appEnv', () => {
  it('sets only and plant when given, and drops inherited ones when not', () => {
    const base = { HB_PERF_ONLY: 'stale', HB_PERF_PLANT: 'stale=9' }
    const bare = appEnv({ base, url: 'u', root: 'r', ndjson: 'n' })
    expect(bare.HB_PERF_ONLY).toBeUndefined()
    expect(bare.HB_PERF_PLANT).toBeUndefined()
    const set = appEnv({ base, url: 'u', root: 'r', ndjson: 'n', only: 'a', plant: 'a=2' })
    expect(set).toMatchObject({ HB_PERF_ONLY: 'a', HB_PERF_PLANT: 'a=2', HB_APP_URL: 'u' })
    expect(set.HB_TEST_APPDATA).toBe('r')
  })
})

describe('runApp, spawnSync and the server mocked', () => {
  let cwd: string
  let prevCwd: string
  let stop: ReturnType<typeof vi.fn>
  const deps = () => ({
    playwrightCli: 'cli.js',
    startServer: async () => ({ url: 'http://127.0.0.1:1', root: 'root', stop }),
  })
  const line = (id: string) =>
    JSON.stringify({ id, unit: 'ms', better: 'lower', samples: [1, 2, 3] }) + '\n'

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-runapp-'))
    prevCwd = process.cwd()
    process.chdir(cwd)
    mockedSpawnSync.mockReset()
    stop = vi.fn()
  })
  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  const playwrightWrites =
    (ids: string[]) => (cmd: string, _a: string[], opts: { env: Record<string, string> }) => {
      if (cmd === 'git') return { status: 0, stdout: 'abc123\n', stderr: '' }
      for (const id of ids) fs.appendFileSync(opts.env.HB_PERF_RESULTS_FILE, line(id))
      return { status: 0, stdout: '', stderr: '' }
    }

  it('a run that writes no result lines fails, and still stops the server', async () => {
    mockedSpawnSync.mockImplementation(playwrightWrites([]))
    await expect(runApp({}, deps())).rejects.toThrow(/measured nothing/)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('a failed Playwright run fails and stops the server', async () => {
    mockedSpawnSync.mockImplementation(() => ({ status: 1, stdout: '', stderr: 'boom' }))
    await expect(runApp({}, deps())).rejects.toThrow(/exit 1/)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('a requested --only id or plant id that produced no result is caught', async () => {
    mockedSpawnSync.mockImplementation(playwrightWrites(['app.other']))
    await expect(runApp({ only: 'app.wanted' }, deps())).rejects.toThrow(/app\.wanted.*no result/)
    await expect(runApp({ plant: 'app.planted=3' }, deps())).rejects.toThrow(
      /app\.planted.*no result/,
    )
  })

  it('a good run yields a valid schema-1 app doc and passes only/plant through the env', async () => {
    mockedSpawnSync.mockImplementation(playwrightWrites(['app.a']))
    const doc = await runApp({ only: 'app.a', plant: 'app.a=3' }, deps())
    expect(doc).toMatchObject({ schema: 1, suite: 'app', sha: 'abc123' })
    expect(doc.harness).toMatch(/^[0-9a-f]{64}$/)
    const pw = mockedSpawnSync.mock.calls.find(c => c[0] !== 'git')!
    expect(pw[2].env).toMatchObject({ HB_PERF_ONLY: 'app.a', HB_PERF_PLANT: 'app.a=3' })
    expect(pw[1]).toEqual(['cli.js', 'test', '-c', 'playwright.perf.config.cjs'])
  })
})

describe('paired.mjs app suite', () => {
  it('runs run-app.mjs, defaults to 6 rounds, and plants only the candidate', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pa-base-'))
    const cand = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pa-cand-'))
    const calls: { cwd: string; args: string[] }[] = []
    mockedSpawnSync.mockReset()
    mockedSpawnSync.mockImplementation((_c: string, args: string[], opts: { cwd: string }) => {
      calls.push({ cwd: opts.cwd, args })
      const results = [{ id: 'app.x', unit: 'ms', better: 'lower', samples: [1] }]
      const doc = { schema: 1, sha: 'x', suite: 'app', harness: 'h', results }
      fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(doc))
      return { status: 0, stdout: '', stderr: '' }
    })
    try {
      const doc = runPaired({ base, cand, suite: 'app', plant: 'app.x=3' })
      expect(doc.rounds).toBe(6)
      expect(calls).toHaveLength(12)
      for (const c of calls) {
        expect(c.args[0]).toMatch(/run-app\.mjs$/)
        expect(c.args.includes('--plant')).toBe(c.cwd === cand)
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
      fs.rmSync(cand, { recursive: true, force: true })
    }
  })
})

describe('the e2e Playwright config never collects a perf spec', () => {
  const app = path.join(repoRoot, 'theia', 'browser-app')
  const e2e = fs.readFileSync(path.join(app, 'playwright.config.cjs'), 'utf8')
  const perf = fs.readFileSync(path.join(app, 'playwright.perf.config.cjs'), 'utf8')
  const dirOf = (src: string) => src.match(/testDir:\s*'\.\/([^']+)'/)![1]
  const perfSpecs = fs.readdirSync(path.join(app, 'perf')).filter(f => f.endsWith('.perf.cjs'))
  const e2eSpecs = fs.readdirSync(path.join(app, 'test')).filter(f => f.endsWith('.spec.cjs'))

  it('there are real specs on both sides to check', () => {
    expect(perfSpecs.length).toBeGreaterThanOrEqual(3)
    expect(e2eSpecs.length).toBeGreaterThan(10)
  })

  it('no perf spec sits under the e2e testDir, and the e2e config keeps the default testMatch', () => {
    expect(e2e).not.toMatch(/testMatch/)
    expect(dirOf(e2e)).toBe('test')
    for (const f of perfSpecs) {
      expect(path.join('perf', f).startsWith(dirOf(e2e) + path.sep)).toBe(false)
    }
  })

  it('the perf config collects perf specs only, from its own directory', () => {
    expect(dirOf(perf)).toBe('perf')
    expect(perf).toMatch(/testMatch:\s*'\*\*\/\*\.perf\.cjs'/)
  })

  it('the default e2e match (spec/test suffixes) does not select a .perf.cjs file', () => {
    const defaultMatch = /\.(spec|test)\.[cm]?[jt]sx?$/
    for (const f of perfSpecs) expect(defaultMatch.test(f)).toBe(false)
    for (const f of e2eSpecs) expect(defaultMatch.test(f)).toBe(true)
  })
})
