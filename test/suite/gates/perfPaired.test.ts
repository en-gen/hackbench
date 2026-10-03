/**
 * Proof that the paired runner (tools/perf/paired.mjs, design D1/D2/D3) can
 * fail: wrong-directory routing, plant leaking onto base, an ignored suite
 * failure, and a skipped result-doc validation are all mocked at the
 * spawnSync boundary so they are deterministic and fast. The real
 * end-to-end `--plant` run (spawning actual vitest, issue #413's acceptance
 * list) lives in perfPairedE2E.test.ts, unmocked.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn() }
})

import { spawnSync } from 'node:child_process'
import { abbaSchedule, runPaired } from '../../../tools/perf/paired.mjs'

const mockedSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>

type Call = { cwd: string; hasOnly: boolean; hasPlant: boolean; plantValue?: string }

/** Configures the mocked spawnSync to record every call's cwd/only/plant and
 *  write a valid, trivially-passing result doc to whatever --out it was
 *  asked for, so runPaired's own validation and the rest of the pipeline
 *  proceed exactly as with a real suite run. */
function recordingRunner(calls: Call[], { fail = false, invalidDoc = false } = {}) {
  return (_cmd: string, args: string[], opts: { cwd: string }) => {
    const out = args[args.indexOf('--out') + 1]
    const plantIdx = args.indexOf('--plant')
    calls.push({
      cwd: opts.cwd,
      hasOnly: args.includes('--only'),
      hasPlant: plantIdx !== -1,
      plantValue: plantIdx !== -1 ? args[plantIdx + 1] : undefined,
    })
    if (fail) return { status: 1, stdout: '', stderr: 'boom' }
    const doc = invalidDoc
      ? { schema: 1, sha: 'x', suite: 'core', harness: 'h', results: [] }
      : {
          schema: 1,
          sha: 'x',
          suite: 'core',
          harness: 'h',
          results: [{ id: 'core.x', unit: 'ms', better: 'lower', samples: [1, 2, 3] }],
        }
    fs.writeFileSync(out, JSON.stringify(doc))
    return { status: 0, stdout: '', stderr: '' }
  }
}

describe('design D3: ABBA schedule', () => {
  it('is base,cand,cand,base per block of two rounds, pairing by round index', () => {
    expect(abbaSchedule(4)).toEqual([
      { round: 0, side: 'base' },
      { round: 0, side: 'cand' },
      { round: 1, side: 'cand' },
      { round: 1, side: 'base' },
      { round: 2, side: 'base' },
      { round: 2, side: 'cand' },
      { round: 3, side: 'cand' },
      { round: 3, side: 'base' },
    ])
  })

  it('a trailing unpaired round (odd n) runs base then cand', () => {
    expect(abbaSchedule(1)).toEqual([
      { round: 0, side: 'base' },
      { round: 0, side: 'cand' },
    ])
    expect(abbaSchedule(5).slice(-2)).toEqual([
      { round: 4, side: 'base' },
      { round: 4, side: 'cand' },
    ])
  })
})

describe('paired.mjs, spawnSync mocked', () => {
  let baseDir: string
  let candDir: string

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-paired-base-'))
    candDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-paired-cand-'))
    mockedSpawnSync.mockReset()
  })
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
    fs.rmSync(candDir, { recursive: true, force: true })
  })

  it('M22: every call runs in the directory its side names, never the other one', () => {
    const calls: Call[] = []
    mockedSpawnSync.mockImplementation(recordingRunner(calls))
    runPaired({ base: baseDir, cand: candDir, suite: 'core', rounds: 5 })
    const expectedCwds = abbaSchedule(5).map(s => (s.side === 'base' ? baseDir : candDir))
    expect(calls.map(c => c.cwd)).toEqual(expectedCwds)
  })

  it('M20/M21: --plant is forwarded on every cand call and never on a base call', () => {
    const calls: Call[] = []
    mockedSpawnSync.mockImplementation(recordingRunner(calls))
    runPaired({ base: baseDir, cand: candDir, suite: 'core', rounds: 5, plant: 'core.x=1.3' })
    const bySide = abbaSchedule(5).map((s, i) => ({ side: s.side, call: calls[i] }))
    for (const { side, call } of bySide) {
      if (side === 'cand') expect(call.plantValue).toBe('core.x=1.3')
      else expect(call.hasPlant).toBe(false)
    }
  })

  it('M23: a non-zero suite exit status is not ignored', () => {
    mockedSpawnSync.mockImplementation(recordingRunner([], { fail: true }))
    expect(() => runPaired({ base: baseDir, cand: candDir, suite: 'core', rounds: 5 })).toThrow(
      /exit 1/,
    )
  })

  it('M24: an invalid round result doc is not silently accepted', () => {
    mockedSpawnSync.mockImplementation(recordingRunner([], { invalidDoc: true }))
    expect(() => runPaired({ base: baseDir, cand: candDir, suite: 'core', rounds: 5 })).toThrow(
      /non-empty/,
    )
  })

  it('design D2: --rounds below MIN_ROUNDS is rejected before any suite runs', () => {
    mockedSpawnSync.mockImplementation(recordingRunner([]))
    expect(() => runPaired({ base: baseDir, cand: candDir, suite: 'core', rounds: 3 })).toThrow(
      />= 5/,
    )
    expect(mockedSpawnSync).not.toHaveBeenCalled()
  })

  it('design D1: overlays the candidate harness onto base and restores it afterwards', () => {
    fs.mkdirSync(path.join(baseDir, 'test', 'perf', 'core'), { recursive: true })
    fs.writeFileSync(path.join(baseDir, 'test', 'perf', 'core', 'old.bench.ts'), 'old-base-content')
    fs.mkdirSync(path.join(candDir, 'test', 'perf', 'core'), { recursive: true })
    fs.writeFileSync(path.join(candDir, 'test', 'perf', 'core', 'new.bench.ts'), 'new-cand-content')

    let sawOverlaidFileDuringRun = false
    mockedSpawnSync.mockImplementation((cmd, args, opts) => {
      // Only base's directory receives the overlay; a call routed there
      // should see cand's bench file, never base's original one.
      if (opts.cwd === baseDir) {
        sawOverlaidFileDuringRun ||= fs.existsSync(
          path.join(baseDir, 'test', 'perf', 'core', 'new.bench.ts'),
        )
        expect(fs.existsSync(path.join(baseDir, 'test', 'perf', 'core', 'old.bench.ts'))).toBe(
          false,
        )
      }
      return recordingRunner([])(cmd, args, opts)
    })
    runPaired({ base: baseDir, cand: candDir, suite: 'core', rounds: 5 })
    expect(sawOverlaidFileDuringRun).toBe(true)
    // restored afterwards
    expect(fs.existsSync(path.join(baseDir, 'test', 'perf', 'core', 'old.bench.ts'))).toBe(true)
    expect(fs.existsSync(path.join(baseDir, 'test', 'perf', 'core', 'new.bench.ts'))).toBe(false)
  })

  it('a directory overlay is skipped entirely when base and cand are the same path', () => {
    mockedSpawnSync.mockImplementation(recordingRunner([]))
    // No overlay bookkeeping should touch a real filesystem path here; this
    // just proves the no-op path does not throw.
    expect(() =>
      runPaired({ base: baseDir, cand: baseDir, suite: 'core', rounds: 5 }),
    ).not.toThrow()
  })

  it('rejects a suite that has no runner', () => {
    expect(() => runPaired({ base: baseDir, cand: candDir, suite: 'nope', rounds: 5 })).toThrow(
      /unsupported suite/,
    )
  })
})
