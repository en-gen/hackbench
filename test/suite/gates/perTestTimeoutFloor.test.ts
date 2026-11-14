/**
 * A per-test timeout replaces the file budget, so in a file the #1209 gate lists
 * one under 30 s undercuts it (#1333). Plants go through temp files, like
 * processTimeoutGate.test.ts, so the file listing is part of what is proven.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { perTestTimeoutOffences, timeoutFloorOffences } from './perTestTimeoutFloor'
import { slow } from '../support/loadTimeout'

const SPAWN = "import { spawnSync } from 'child_process'"
const dirs: string[] = []

function plant(files: Record<string, string>): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptf-'))
  dirs.push(dir)
  for (const [n, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), src)
  return perTestTimeoutOffences(dir)
}
/** Plants a process-starting file whose line 2 onward is `body`. */
const offences = (...body: string[]) => plant({ 'p.test.ts': [SPAWN, ...body].join('\n') })
afterEach(() => dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })))

describe('perTestTimeoutFloor planted sources', () => {
  it.each([
    ['slow()', "it('x', slow(10_000), () => {})", '10000'],
    ['slow() in a describe', "describe('x', slow(5000), () => {})", '5000'],
    ['loadTimeout()', "it('x', { timeout: loadTimeout(9000) }, () => {})", '9000'],
    ['a trailing number', "it('x', () => {}, 12_000)", '12000'],
    ['a trailing number on a describe', "describe('x', () => {}, 7000)", '7000'],
    ['a hook number', 'beforeAll(() => {}, 1000)', '1000'],
    ['each', "it.each([1])('x', () => {}, 2000)", '2000'],
    ['skipIf', "it.skipIf(false)('x', () => {}, 3000)", '3000'],
    ['only', "it.only('x', () => {}, 4000)", '4000'],
    ['concurrent', "it.concurrent('x', () => {}, 6000)", '6000'],
    ['an options object', "it('x', { timeout: 8000 }, () => {})", '8000'],
    ['arithmetic', "it('x', () => {}, 10 * 1000)", '10000'],
  ])('refuses %s under the floor, naming file and line', (_n, body, value) => {
    expect(offences(body)).toEqual([`p.test.ts:2 ${value}`])
  })

  it('resolves a module-scope const', () => {
    expect(offences('const T = 5 * 1000', "it('x', () => {}, T)")).toEqual(['p.test.ts:3 5000'])
  })
  it('names the line of the value on a wrapped call', () => {
    expect(offences("it(\n  'x',\n  () => {},\n  9000,\n)")).toEqual(['p.test.ts:5 9000'])
  })
  it('refuses a value it cannot read', () => {
    expect(offences("it('x', () => {}, compute())")).toEqual(['p.test.ts:2 cannot read'])
    expect(offences("it('x', () => {}, someImported)")).toEqual(['p.test.ts:2 cannot read'])
  })
  it.each([
    "it('x', slow(30_000), () => {})",
    "it('x', () => {}, 30000)",
    "it('x', { timeout: 120_000 }, () => {})",
    "it('x', { retry: 2 }, () => {})",
    "it.each([1])('x', () => {})",
    "it('x', handler)",
    "it.skipIf(true)('x', () => {})",
    'vi.setConfig({ testTimeout: loadTimeout(30_000), hookTimeout: loadTimeout(30_000) })',
  ])('accepts %s', body => {
    expect(offences(body)).toEqual([])
  })
  it('accepts a const at or above the floor', () => {
    expect(offences('const T = 60 * 1000', 'beforeAll(() => {}, T)')).toEqual([])
  })

  it('keeps a value with a marker and a reason, on the same or the preceding line', () => {
    expect(offences("it('x', slow(1000), () => {}) // timeout-floor: a 5 ms loop")).toEqual([])
    expect(offences('// timeout-floor: pure arithmetic', "it('x', slow(1000), () => {})")).toEqual(
      [],
    )
  })
  it('does not keep a value with an empty reason or a distant marker', () => {
    expect(offences("it('x', slow(1000), () => {}) // timeout-floor:")).toHaveLength(1)
    expect(offences("it('x', slow(1000), () => {}) // timeout-floor:   ")).toHaveLength(1)
    expect(offences('// timeout-floor: why', '', "it('x', slow(1000), () => {})")).toHaveLength(1)
  })
  it('does not check a file the #1209 gate does not list', () => {
    expect(plant({ 'q.test.ts': "it('x', slow(1000), () => {})" })).toEqual([])
  })
  it('lets the pure scanner read a source directly', () => {
    expect(timeoutFloorOffences("it('x', slow(1), () => {})")).toEqual(['1 1'])
  })
})

describe('perTestTimeoutFloor real tree', () => {
  it('finds no per-test timeout under 30 s in a process-starting file', slow(30_000), () => {
    expect(perTestTimeoutOffences(path.resolve(__dirname, '..'))).toEqual([])
  })
})
