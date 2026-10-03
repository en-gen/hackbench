/**
 * Proof that run-core.mjs (tools/perf/run-core.mjs) fails closed: a suite
 * run that produced zero samples must never report green (design section
 * 1), and a requested --only/--plant id that produced no result is caught
 * rather than silently dropped. spawnSync is mocked so these are fast and
 * do not actually spawn vitest.
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
import { runCore } from '../../../tools/perf/run-core.mjs'

const mockedSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>

describe('runCore, spawnSync mocked', () => {
  let cwd: string
  let prevCwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-runcore-'))
    prevCwd = process.cwd()
    process.chdir(cwd)
    mockedSpawnSync.mockReset()
  })
  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('M27: a vitest run that writes zero result lines fails, never reports green', () => {
    mockedSpawnSync.mockImplementation(() => ({ status: 0, stdout: '', stderr: '' }))
    expect(() => runCore({})).toThrow(/measured nothing/)
  })

  it('a requested --only id that produced no result is caught', () => {
    mockedSpawnSync.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        const out = opts.env.HB_PERF_RESULTS_FILE
        fs.appendFileSync(
          out,
          JSON.stringify({ id: 'core.other', unit: 'ms', better: 'lower', samples: [1] }) + '\n',
        )
        return { status: 0, stdout: '', stderr: '' }
      },
    )
    expect(() => runCore({ only: 'core.wanted' })).toThrow(/core.wanted.*no result/)
  })

  it('the plant id is checked the same way as --only', () => {
    mockedSpawnSync.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        const out = opts.env.HB_PERF_RESULTS_FILE
        fs.appendFileSync(
          out,
          JSON.stringify({ id: 'core.other', unit: 'ms', better: 'lower', samples: [1] }) + '\n',
        )
        return { status: 0, stdout: '', stderr: '' }
      },
    )
    expect(() => runCore({ plant: 'core.wanted=1.5' })).toThrow(/core.wanted.*no result/)
  })

  it('empty components in --only are ignored', () => {
    mockedSpawnSync.mockImplementation(
      (_cmd: string, _args: string[], opts?: { env?: Record<string, string> }) => {
        const file = opts?.env?.HB_PERF_RESULTS_FILE
        if (file)
          fs.appendFileSync(
            file,
            JSON.stringify({ id: 'core.a', unit: 'ms', better: 'lower', samples: [1] }) + '\n',
          )
        return { status: 0, stdout: '', stderr: '' }
      },
    )
    expect(() => runCore({ only: 'core.a, ,' })).not.toThrow()
  })
})
