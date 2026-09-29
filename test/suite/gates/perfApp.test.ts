/**
 * Proof that the app half of the perf gates (issue #414) can fail: the marks
 * fail closed, the heap slope is a real least-squares slope, the plant
 * reaches only the planted id, run-app.mjs refuses a run that measured
 * nothing or a build it did not just make, and the e2e Playwright config
 * never collects a perf spec. No ROM, no browser: spawnSync, the server and
 * the page are fakes.
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
import { PLANTABLE, runApp } from '../../../tools/perf/run-app.mjs'
import { perfEnv } from '../../../tools/perf/results.mjs'
import { runPaired } from '../../../tools/perf/paired.mjs'
import {
  perfEnd,
  perfEndAfterPaint,
  perfStart,
} from '../../../theia/extension/src/common/perf-marks'

const repoRoot = path.resolve(__dirname, '../../..')
const require = createRequire(import.meta.url)
const support = require('../../../theia/browser-app/perf/support.cjs')
const mockedSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>

describe('perf-marks', () => {
  beforeEach(() => {
    performance.clearMarks()
    performance.clearMeasures()
  })
  const measures = () => performance.getEntriesByName('hb:t', 'measure')

  it('a start and an end record one measure; an end with no start, or a repeat, records none', () => {
    perfEnd('t')
    expect(measures()).toHaveLength(0)
    perfStart('t')
    perfEnd('t')
    perfEnd('t')
    expect(measures()).toHaveLength(1)
  })

  it('perfEndAfterPaint schedules nothing unless a start is pending', () => {
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    try {
      perfEndAfterPaint('t')
      expect(raf).not.toHaveBeenCalled()
      perfStart('t')
      perfEndAfterPaint('t')
      expect(raf).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a missing perfEnd leaves no measure, and the spec reader throws instead of returning 0', () => {
    perfStart('t')
    expect(() => support.measureOf(performance.getEntriesByType('measure'), 't')).toThrow(
      /no 'hb:t' measure/,
    )
  })
})

describe('support.cjs', () => {
  it('heapSlope is exact on a line, recovers a slope through noise, and refuses one point', () => {
    expect(support.heapSlope([10, 30, 50, 70])).toBe(20)
    const noise = [3, -2, 5, -4, 1, -3, 2, -1, 4, -5]
    expect(support.heapSlope(noise.map((n, i) => 1e6 + 4096 * i + n * 10))).toBeCloseTo(4096, -1)
    expect(Math.abs(support.heapSlope(noise.map(n => 1e6 + n)))).toBeLessThan(2)
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

  it('perfEnv sets only and plant when given, and never inherits stale ones', () => {
    const base = { HB_PERF_ONLY: 'stale', HB_PERF_PLANT: 'stale=9' }
    const bare = perfEnv({ base, ndjson: 'n' })
    expect(bare.HB_PERF_ONLY).toBeUndefined()
    expect(bare.HB_PERF_PLANT).toBeUndefined()
    expect(perfEnv({ base, ndjson: 'n', only: 'a', plant: 'a=2' })).toMatchObject({
      HB_PERF_ONLY: 'a',
      HB_PERF_PLANT: 'a=2',
      HB_PERF_RESULTS_FILE: 'n',
    })
  })
})

describe('withPlant, sample and collect against a fake page', () => {
  const log: string[] = []
  const fakePage = (entries: { name: string; duration: number }[] = []) => {
    const cdp = {
      send: vi.fn(async (m: string, a: { rate: number }) => void log.push(`${m}:${a.rate}`)),
    }
    return {
      cdp,
      context: () => ({ newCDPSession: async () => cdp }),
      waitForFunction: async () => undefined,
      evaluate: async (_fn: unknown, arg?: string) => {
        if (arg === undefined) return entries
        log.push(`clear:${arg}`)
      },
    }
  }
  beforeEach(() => {
    log.length = 0
    delete process.env.HB_PERF_PLANT
  })
  afterEach(() => {
    delete process.env.HB_PERF_PLANT
  })

  it('throttles only the planted id, and resets in a finally even when the case throws', async () => {
    process.env.HB_PERF_PLANT = 'app.a=4'
    const page = fakePage()
    await support.withPlant(page, 'app.b', async () => undefined)
    expect(page.cdp.send).not.toHaveBeenCalled()
    await expect(
      support.withPlant(page, 'app.a', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(log).toEqual(['Emulation.setCPUThrottlingRate:4', 'Emulation.setCPUThrottlingRate:1'])
  })

  it('sample clears the old measure before the action, then reads the new one', async () => {
    const page = fakePage([{ name: 'hb:t', duration: 7 }])
    const d = await support.sample(page, 't', async () => void log.push('action'))
    expect(d).toBe(7)
    expect(log).toEqual(['clear:t', 'action'])
  })

  it('sample fails when the app never emitted the measure', async () => {
    await expect(support.sample(fakePage(), 't', async () => undefined)).rejects.toThrow(
      /no 'hb:t'/,
    )
  })

  it('collect drops exactly WARMUP results and keeps SAMPLES', async () => {
    const out = await support.collect(async (i: number) => i)
    expect(out).toHaveLength(support.SAMPLES)
    expect(out[0]).toBe(support.WARMUP)
  })
})

describe('runApp, spawnSync and the server mocked', () => {
  let cwd: string
  let prevCwd: string
  let stop: ReturnType<typeof vi.fn>
  let started: number
  const deps = () => ({
    playwrightCli: 'cli.js',
    startServer: async () => {
      started++
      return { url: 'http://127.0.0.1:1', root: 'root', stop }
    },
  })
  const line = (id: string) =>
    JSON.stringify({ id, unit: 'ms', better: 'lower', samples: [1, 2, 3] }) + '\n'
  const stamp = (sha: string) => {
    const dir = path.join(cwd, 'theia', 'browser-app', 'lib')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'hb-build-stamp.json'), JSON.stringify({ sha }))
  }
  const playwrightCalls = () => mockedSpawnSync.mock.calls.filter(c => c[0] !== 'git')
  const git = { status: 0, stdout: 'abc123\n', stderr: '' }

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-runapp-'))
    prevCwd = process.cwd()
    process.chdir(cwd)
    mockedSpawnSync.mockReset()
    stop = vi.fn()
    started = 0
    stamp('abc123')
  })
  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  const playwrightWrites =
    (ids: string[]) => (cmd: string, _a: string[], opts: { env: Record<string, string> }) => {
      if (cmd === 'git') return git
      for (const id of ids) fs.appendFileSync(opts.env.HB_PERF_RESULTS_FILE, line(id))
      return { status: 0, stdout: '', stderr: '' }
    }

  it('a run that writes no result lines fails, and stops every server it started', async () => {
    mockedSpawnSync.mockImplementation(playwrightWrites([]))
    await expect(runApp({}, deps())).rejects.toThrow(/measured nothing/)
    expect(stop).toHaveBeenCalledTimes(started)
  })

  it('a failed Playwright run fails and stops the server', async () => {
    mockedSpawnSync.mockImplementation((cmd: string) =>
      cmd === 'git' ? git : { status: 1, stdout: '', stderr: 'boom' },
    )
    await expect(runApp({}, deps())).rejects.toThrow(/exit 1/)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('a requested --only id that produced no result is caught', async () => {
    mockedSpawnSync.mockImplementation(playwrightWrites(['app.other']))
    await expect(runApp({ only: 'app.wanted' }, deps())).rejects.toThrow(/app\.wanted.*no result/)
  })

  it('runs startup first on its own server, then app and heap on another', async () => {
    mockedSpawnSync.mockImplementation(playwrightWrites(['startup.shell', 'app.a']))
    const doc = await runApp({}, deps())
    expect(doc).toMatchObject({ schema: 1, suite: 'app', sha: 'abc123' })
    expect(doc.harness).toMatch(/^[0-9a-f]{64}$/)
    expect(started).toBe(2)
    const files = playwrightCalls().map(c => c[1].slice(4))
    expect(files).toEqual([['startup.perf.cjs'], ['app.perf.cjs', 'heap.perf.cjs']])
  })

  it('--only starts only the phase that owns the id, and passes only/plant via the env', async () => {
    mockedSpawnSync.mockImplementation(playwrightWrites(['app.open-gfx']))
    await runApp({ only: 'app.open-gfx', plant: 'app.open-gfx=3' }, deps())
    expect(started).toBe(1)
    expect(playwrightCalls()[0][2].env).toMatchObject({
      HB_PERF_ONLY: 'app.open-gfx',
      HB_PERF_PLANT: 'app.open-gfx=3',
    })
  })

  it('refuses a plant on an id a renderer throttle cannot slow, before starting anything', async () => {
    for (const id of ['app.edit', 'app.undo', 'app.open-project', 'core.x']) {
      await expect(runApp({ plant: `${id}=3` }, deps())).rejects.toThrow(/cannot plant/)
    }
    expect(started).toBe(0)
    for (const id of PLANTABLE) expect(id).toMatch(/^(startup|app|heap)\./)
  })

  it('refuses a missing or stale build stamp', async () => {
    stamp('old')
    mockedSpawnSync.mockImplementation(playwrightWrites(['app.a']))
    await expect(runApp({}, deps())).rejects.toThrow(/stale build/)
    fs.rmSync(path.join(cwd, 'theia', 'browser-app', 'lib'), { recursive: true })
    await expect(runApp({}, deps())).rejects.toThrow(/no build stamp/)
    expect(started).toBe(0)
  })
})

describe('paired.mjs app suite', () => {
  it('runs run-app.mjs, defaults to 6 rounds, overlays app specs, plants only the candidate', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pa-base-'))
    const cand = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pa-cand-'))
    const spec = (dir: string) => path.join(dir, 'theia', 'browser-app', 'perf', 'new.perf.cjs')
    fs.mkdirSync(path.dirname(spec(cand)), { recursive: true })
    fs.writeFileSync(spec(cand), 'x')
    const calls: { cwd: string; args: string[]; overlaid: boolean }[] = []
    mockedSpawnSync.mockReset()
    mockedSpawnSync.mockImplementation((_c: string, args: string[], opts: { cwd: string }) => {
      calls.push({ cwd: opts.cwd, args, overlaid: fs.existsSync(spec(base)) })
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
        expect(c.overlaid).toBe(true)
      }
      expect(fs.existsSync(path.dirname(spec(base)))).toBe(false) // restored afterwards
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
  const specs = (dir: string, ext: string) =>
    fs.readdirSync(path.join(app, dir)).filter(f => f.endsWith(ext))
  const perfSpecs = specs('perf', '.perf.cjs')
  const e2eSpecs = specs('test', '.spec.cjs')

  it('keeps the two apart by directory and by the default match', () => {
    expect(perfSpecs.length).toBeGreaterThanOrEqual(3)
    expect(e2eSpecs.length).toBeGreaterThan(10)
    expect([dirOf(e2e), dirOf(perf)]).toEqual(['test', 'perf'])
    expect(e2e).not.toMatch(/testMatch/) // a widened match could reach ../perf
    expect(perf).toMatch(/testMatch:\s*'\*\*\/\*\.perf\.cjs'/)
    const defaultMatch = /\.(spec|test)\.[cm]?[jt]sx?$/
    for (const f of perfSpecs) expect(defaultMatch.test(f)).toBe(false)
    for (const f of e2eSpecs) expect(defaultMatch.test(f)).toBe(true)
  })
})
