/**
 * A test file that starts a process needs a load-scaled budget (#1209, #485).
 * The plants are line arrays: a string-literal import never sits at column 0.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { processTimeoutOffences } from './processTimeoutGate'

const BUDGET =
  'vi.setConfig({ testTimeout: loadTimeout(30_000), hookTimeout: loadTimeout(30_000) })'
const SPAWN = "import { spawnSync } from 'child_process'"
const TEST = "it('x', () => {})"
const dirs: string[] = []

/** Writes planted files (name to source) into a fresh temp dir and returns the gate's verdict. */
function plant(files: Record<string, string>): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptg-'))
  dirs.push(dir)
  for (const [n, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), src)
  return processTimeoutOffences(dir)
}
const offences = (...lines: string[]) => plant({ 'p.test.ts': lines.join('\n') })
afterEach(() => dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })))

describe('processTimeoutGate planted sources', () => {
  it('refuses a bare spawnSync with no budget', () => {
    expect(offences(SPAWN, TEST)).toEqual(['p.test.ts'])
  })
  it('accepts the module-scope budget', () => {
    expect(offences(SPAWN, BUDGET, TEST)).toEqual([])
  })
  it.each([
    ['multi-line, aliased', ['import {', '  spawnSync as run,', "} from 'node:child_process'"]],
    ['namespace', ["import * as cp from 'child_process'"]],
    ['default', ["import cp from 'child_process'"]],
    ['require', ["const cp = require('child_process')"]],
    ['dynamic import', ["const cp = await import('node:child_process')"]],
    ['isolatedGit', ["import { isolatedGit } from '../support/isolatedGit'"]],
    ['gitBash', ["import { findBash } from '../support/gitBash'"]],
  ])('refuses %s with no budget', (_n, imp) => {
    expect(offences(...imp, TEST)).toEqual(['p.test.ts'])
  })
  it('refuses a budget inside a describe', () => {
    expect(offences(SPAWN, "describe('d', () => {", `  ${BUDGET}`, `  ${TEST}`, '})')).toEqual([
      'p.test.ts',
    ])
  })
  it('refuses a budget placed after the first test', () => {
    expect(offences(SPAWN, TEST, BUDGET)).toEqual(['p.test.ts'])
  })
  it('refuses a bare number, and a budget with only one key', () => {
    expect(offences(SPAWN, 'vi.setConfig({ testTimeout: 20_000 })', TEST)).toEqual(['p.test.ts'])
    const one = 'vi.setConfig({ testTimeout: loadTimeout(30_000) })'
    expect(offences(SPAWN, one, TEST)).toEqual(['p.test.ts'])
  })
  it('does not list a type import, a mocked child_process, or a non-starter', () => {
    expect(offences("import type { SpawnSyncReturns } from 'child_process'", TEST)).toEqual([])
    expect(offences("import { type spawn } from 'child_process'", TEST)).toEqual([])
    expect(offences(SPAWN, "vi.mock('node:child_process')", TEST)).toEqual([])
    expect(offences("import { ChildProcess } from 'child_process'", TEST)).toEqual([])
  })
  it('lists an untracked planted file and skips timing and nightly files', () => {
    const src = `${SPAWN}
${TEST}
`
    const files = { 'a.test.ts': src, 'b.timing.test.ts': src, 'c.nightly.test.ts': src }
    expect(plant(files)).toEqual(['a.test.ts'])
  })
})

describe('processTimeoutGate real tree', () => {
  it('lists no process-starting test file without the budget', () => {
    expect(processTimeoutOffences(path.resolve(__dirname, '..'))).toEqual([])
  })
})
