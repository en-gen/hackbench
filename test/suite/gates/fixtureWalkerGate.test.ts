/**
 * Every gate test that walks a directory tree must skip `__fixtures__`
 * (#796, follow-up to #754/#770). lintGate.test.ts creates and deletes
 * `__fixtures__/run-<pid>-<ts>/*.ts` while other workers run; a walker that
 * lists that directory and reads the file afterwards fails with ENOENT.
 * #770 fixed the three walkers that scan `test/`; this gate closes the class
 * for the rest, including walkers added later whose SCANNED roots grow.
 *
 * Evidence scope: static text check over test/suite/gates/*.test.ts, one
 * machine. On the shipped #770 tree, controlBytes/testRegistration/
 * perfConfigSeparation survived 20 of 20 runs under a 100 s external churner;
 * the other two walkers scan only src roots and were exposed by root
 * choice alone.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const GATES = __dirname

/** A recursive walker: reads a directory with entry types, then recurses. */
const WALKS = /readdirSync\([^)]*withFileTypes/
export function unguardedWalkers(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([, text]) => WALKS.test(text) && !text.includes('__fixtures__'))
    .map(([name]) => name)
}

describe('gate walkers skip __fixtures__', () => {
  it('no gate test walks a tree without skipping __fixtures__', () => {
    const names = fs.readdirSync(GATES).filter(f => f.endsWith('.test.ts'))
    const files = Object.fromEntries(
      names.map(n => [n, fs.readFileSync(path.join(GATES, n), 'utf8')]),
    )
    // Tripwire: the check must still see the walkers it exists for.
    expect(Object.values(files).filter(t => WALKS.test(t)).length).toBeGreaterThanOrEqual(5)
    expect(unguardedWalkers(files)).toEqual([])
  })

  it('goes red on a planted walker without the skip, green with it', () => {
    const bad = 'fs.readdirSync(d, { withFileTypes: true }).flatMap(e => walk(e))'
    expect(unguardedWalkers({ 'x.test.ts': bad })).toEqual(['x.test.ts'])
    expect(unguardedWalkers({ 'x.test.ts': bad + " e.name === '__fixtures__'" })).toEqual([])
  })
})
