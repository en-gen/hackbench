/**
 * A per-test timeout replaces the file budget, so in a file the #1209 gate lists
 * one under 30 s undercuts it (#1333). Plants go through temp files, like
 * processTimeoutGate.test.ts, so the file listing is part of what is proven.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { processStartingFiles } from './processTimeoutGate'
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
    ['one under the floor', "it('x', () => {}, 29_999)", '29999'],
    ['15 s', "it('x', () => {}, 15_000)", '15000'],
    ['25 s', "it('x', () => {}, 25_000)", '25000'],
    ['a shorthand timeout', "const timeout = 2000; it('x', { timeout }, () => {})", '2000'],
    ['a describe options object', "describe('x', { timeout: 4000 }, () => {})", '4000'],
    ['a setConfig testTimeout', 'vi.setConfig({ testTimeout: 5000 })', '5000'],
    ['a setConfig hookTimeout', 'vi.setConfig({ hookTimeout: loadTimeout(1000) })', '1000'],
    ['a setConfig spread', 'vi.setConfig({ ...slow(1000) })', '1000'],
    ['an options const', "const o = { timeout: 2000 }; it('x', o, () => {})", '2000'],
    ['an options spread', "it('x', { ...{ timeout: 3000 } }, () => {})", '3000'],
  ])('refuses %s under the floor, naming file and line', (_n, body, value) => {
    expect(offences(body)).toEqual([`p.test.ts:2 ${value}`])
  })

  it('resolves a module-scope const', () => {
    expect(offences('const T = 5 * 1000', "it('x', () => {}, T)")).toEqual(['p.test.ts:3 5000'])
  })
  it('reports both values on one line', () => {
    expect(offences("it('a', slow(1), () => {}); it('b', slow(2), () => {})")).toEqual([
      'p.test.ts:2 1',
      'p.test.ts:2 2',
    ])
  })
  it('refuses an options variable or spread it cannot read', () => {
    expect(offences("it('x', someOpts, () => {})")).toEqual(['p.test.ts:2 cannot read'])
    expect(offences("it('x', { ...someOpts }, () => {})")).toEqual(['p.test.ts:2 cannot read'])
  })
  it('does not resolve a let', () => {
    expect(offences('let T = 30000', 'T = 1', "it('x', () => {}, T)")).toEqual([
      'p.test.ts:4 cannot read',
    ])
  })
  it('does not resolve a const shadowed in a nested scope or a parameter', () => {
    expect(
      offences('const T = 40000', "describe('d', () => { const T = 1; it('x', () => {}, T) })"),
    ).toEqual(['p.test.ts:3 cannot read'])
    expect(offences('const T = 40000', "const f = (T: number) => it('x', () => {}, T)")).toEqual([
      'p.test.ts:3 cannot read',
    ])
  })
  it('refuses an unreadable hook timeout', () => {
    expect(offences('beforeAll(setup, someImported)')).toEqual(['p.test.ts:2 cannot read'])
  })
  it('does not refuse a child-process timeout or a test.extend fixture named timeout', () => {
    expect(offences("spawnSync('x', [], { timeout: loadTimeout(5000) })")).toEqual([])
    expect(offences('const t2 = test.extend({ timeout: 1000 })')).toEqual([])
    expect(offences('const a = slow(1000)')).toEqual([])
  })
  it('resolves a sum of literals to its value', () => {
    expect(offences('const T = 20_000 + 10_000', "it('x', () => {}, T)")).toEqual([])
  })
  it('keeps a multi-line call by a marker above it', () => {
    expect(
      offences('// timeout-floor: a loop', 'it(', "  'x',", '  () => {},', '  1000,', ')'),
    ).toEqual([])
  })
  it.each([
    ['a title', ["it('// timeout-floor: why', slow(1000), () => {})"]],
    ['a block comment', ['/* timeout-floor: why */', "it('x', slow(1000), () => {})"]],
    [
      'the previous statement trailing comment',
      ['const a = 1 // timeout-floor: why', "it('x', slow(1000), () => {})"],
    ],
    [
      'one marker for two statements on the next line',
      ['// timeout-floor: why', "it('a', slow(1), () => {}); it('b', slow(2), () => {})"],
    ],
    [
      'a marker above a wrapped argument line',
      ['it(', "  'x',", '  // timeout-floor: why', '  slow(1000),', '  () => {},', ')'],
    ],
    [
      'a marker trailing a wrapped argument line',
      ['it(', "  'x',", '  slow(1000), // timeout-floor: why', '  () => {},', ')'],
    ],
    [
      'a marker above a wrapped options argument',
      ['it(', "  'x',", '  // timeout-floor: why', '  { timeout: 1000 },', '  () => {},', ')'],
    ],
    [
      'a marker after other comment text',
      ['// see below // timeout-floor: why', "it('x', slow(1000), () => {})"],
    ],
    [
      'a marker on the outer call of a nested test',
      ['// timeout-floor: why', "describe('d', () => it('x', slow(1000), () => {}))"],
    ],
    [
      'a marker above a bare numeric argument',
      ['it(', "  'x',", '  () => {},', '  // timeout-floor: why', '  1000,', ')'],
    ],
    [
      'a marker on an options const',
      [
        '// timeout-floor: why',
        'const o = { timeout: 1000 }',
        "it('a', o, () => {})",
        "it('b', o, () => {})",
      ],
    ],
    [
      'a marker on a numeric const',
      ['// timeout-floor: why', 'const T = 1000', "it('a', () => {}, T)"],
    ],
  ])('does not keep a value by %s', (_n, body) => {
    expect(offences(...body).length).toBeGreaterThan(0)
  })
  it('reports an options const once per use site, at the use line', () => {
    expect(
      offences('const o = { timeout: 1000 }', "it('a', o, () => {})", "it('b', o, () => {})"),
    ).toEqual(['p.test.ts:3 1000', 'p.test.ts:4 1000'])
  })
  it('refuses a computed key in an options object it cannot read', () => {
    expect(offences("it('x', { ['timeout']: 1000 }, () => {})")).toEqual([
      'p.test.ts:2 cannot read',
    ])
    expect(offences("vi.setConfig({ ['testTimeout']: 1000 })")).toEqual(['p.test.ts:2 cannot read'])
  })
  it('lists offences by file then numeric line', () => {
    const body = (n: number) => Array(n).fill('').concat("it('x', slow(1), () => {})").join('\n')
    expect(
      plant({ 'b.test.ts': `${SPAWN}\n${body(1)}`, 'a.test.ts': `${SPAWN}\n${body(9)}` }),
    ).toEqual(['a.test.ts:11 1', 'b.test.ts:3 1'])
    expect(plant({ 'a.test.ts': `${SPAWN}\n${body(7)}\n${body(0)}` })[0]).toBe('a.test.ts:9 1')
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
    const root = path.resolve(__dirname, '..')
    // A walk that lists nothing would pass the next line, so tie it to a file known to start a process.
    expect(
      processStartingFiles(root).map(f => path.relative(root, f).split(path.sep).join('/')),
    ).toContain('unit/SpriteReport.test.ts')
    expect(perTestTimeoutOffences(root)).toEqual([])
  })
})
