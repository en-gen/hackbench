/**
 * A test file that starts a process needs a load-scaled budget (#1209, #485).
 * The plants are line arrays: a string-literal import never sits at column 0.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { processStartingFiles, processTimeoutOffences } from './processTimeoutGate'
import { slow } from '../support/loadTimeout'

const BUDGET =
  'vi.setConfig({ testTimeout: loadTimeout(30_000), hookTimeout: loadTimeout(30_000) })'
const SPAWN = "import { spawnSync } from 'child_process'"
const TEST = "it('x', () => {})"
const dirs: string[] = []

/** Writes planted files (name to source) into a fresh temp dir and returns the gate's verdict. */
function plant(files: Record<string, string>): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptg-'))
  dirs.push(dir)
  for (const [n, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true })
    fs.writeFileSync(path.join(dir, n), src)
  }
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
  it.each(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])(
    'refuses a bare %s with no budget',
    name => {
      expect(offences(`import { ${name} } from 'child_process'`, TEST)).toEqual(['p.test.ts'])
    },
  )
  it.each([
    ['multi-line, aliased', ['import {', '  spawnSync as run,', "} from 'node:child_process'"]],
    ['namespace', ["import * as cp from 'child_process'"]],
    ['default', ["import cp from 'child_process'"]],
    ['require', ["const cp = require('child_process')"]],
    ['dynamic import', ["const cp = await import('node:child_process')"]],
    ['isolatedGit', ["import { isolatedGit } from '../support/isolatedGit'"]],
    ['gitBash', ["import { findBash } from '../support/gitBash'"]],
    ['default plus named', ["import cp, { type SpawnSyncReturns } from 'child_process'"]],
    [
      'a second import that is the starter',
      ["import { ChildProcess } from 'child_process'", SPAWN],
    ],
    ['a commented-out vi.mock', [SPAWN, "// vi.mock('child_process')"]],
  ])('refuses %s with no budget', (_n, imp) => {
    expect(offences(...imp, TEST)).toEqual(['p.test.ts'])
  })
  it('refuses a budget inside a describe', () => {
    expect(offences(SPAWN, "describe('d', () => {", `  ${BUDGET}`, `  ${TEST}`, '})')).toEqual([
      'p.test.ts',
    ])
  })
  it.each([
    ['the first test', TEST],
    ['a top-level hook', 'beforeAll(() => {})'],
  ])('refuses a budget placed after %s', (_n, first) => {
    expect(offences(SPAWN, first, BUDGET)).toEqual(['p.test.ts'])
  })
  it.each([
    ['a bare number', 'vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })'],
    ['one key', 'vi.setConfig({ testTimeout: loadTimeout(30_000) })'],
    ['a different value', BUDGET.replace('(30_000), h', '(1), h')],
    ['a different hook value', BUDGET.replace('(30_000) })', '(1) })')],
    ['an indented line', `  ${BUDGET}`],
    ['a trailing comment line', `// ${BUDGET}`],
  ])('refuses %s in place of the budget', (_n, line) => {
    expect(offences(SPAWN, line, TEST)).toEqual(['p.test.ts'])
  })
  it('does not list a type import, a mocked child_process, or a non-starter', () => {
    expect(offences("import type { SpawnSyncReturns } from 'child_process'", TEST)).toEqual([])
    expect(offences("import type { isolatedGit } from '../support/isolatedGit'", TEST)).toEqual([])
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
  it('walks nested directories but skips __fixtures__', () => {
    const files = {
      'a/b/deep.test.ts': `${SPAWN}
${TEST}
`,
      '__fixtures__/x.test.ts': SPAWN,
    }
    expect(plant(files)).toEqual(['a/b/deep.test.ts'])
  })
})

describe('processTimeoutGate real tree', () => {
  const root = path.resolve(__dirname, '..')
  it('lists no process-starting test file without the budget', slow(30_000), () => {
    expect(processTimeoutOffences(root)).toEqual([])
  })
  it('finds the 26 process-starting files, so an empty walk cannot pass', slow(30_000), () => {
    expect(processStartingFiles(root).length).toBeGreaterThanOrEqual(26)
  })
})
