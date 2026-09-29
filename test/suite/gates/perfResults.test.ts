/**
 * Proof that the result-format gate (tools/perf/results.mjs, design section 1)
 * can fail. A suite that measured nothing must never report green.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  validate,
  familyOf,
  computeHarness,
  writeResultFile,
  readResultFile,
} from '../../../tools/perf/results.mjs'

function baseDoc(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    sha: 'abc123',
    suite: 'core',
    harness: 'deadbeef',
    results: [{ id: 'core.x.y', unit: 'ms', better: 'lower', samples: [1, 2, 3] }],
    ...overrides,
  }
}

describe('results.mjs validate()', () => {
  it('accepts a well-formed document', () => {
    expect(() => validate(baseDoc())).not.toThrow()
  })

  it('rejects an empty results array', () => {
    expect(() => validate(baseDoc({ results: [] }))).toThrow(/non-empty/)
  })

  it('rejects a result with no samples', () => {
    const doc = baseDoc({ results: [{ id: 'core.x.y', unit: 'ms', better: 'lower', samples: [] }] })
    expect(() => validate(doc)).toThrow(/samples must be a non-empty array/)
  })

  it('rejects an unsupported schema', () => {
    expect(() => validate(baseDoc({ schema: 2 }))).toThrow(/schema/)
  })

  it('rejects a missing sha', () => {
    expect(() => validate(baseDoc({ sha: '' }))).toThrow(/sha/)
  })

  it('rejects a missing harness (design D1)', () => {
    expect(() => validate(baseDoc({ harness: '' }))).toThrow(/harness/)
  })

  it('rejects a duplicate id', () => {
    const doc = baseDoc({
      results: [
        { id: 'core.x.y', unit: 'ms', better: 'lower', samples: [1] },
        { id: 'core.x.y', unit: 'ms', better: 'lower', samples: [2] },
      ],
    })
    expect(() => validate(doc)).toThrow(/duplicate/)
  })

  it('rejects a non-finite sample', () => {
    const doc = baseDoc({
      results: [{ id: 'core.x.y', unit: 'ms', better: 'lower', samples: [1, NaN] }],
    })
    expect(() => validate(doc)).toThrow(/finite/)
  })

  it('rejects an ms sample that is not > 0', () => {
    const doc = baseDoc({
      results: [{ id: 'core.x.y', unit: 'ms', better: 'lower', samples: [1, 0] }],
    })
    expect(() => validate(doc)).toThrow(/> 0/)
  })
})

describe('familyOf', () => {
  it('is the first dotted segment', () => {
    expect(familyOf('core.lclz2.decompress.synthetic-64k')).toBe('core')
    expect(familyOf('heap.views.slope')).toBe('heap')
  })
})

describe('writeResultFile / readResultFile', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-perf-results-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('round-trips a document through disk', () => {
    const file = path.join(tmp, 'r.json')
    writeResultFile(file, baseDoc())
    expect(readResultFile(file)).toEqual(baseDoc())
  })

  it('refuses to write an invalid document', () => {
    const file = path.join(tmp, 'r.json')
    expect(() => writeResultFile(file, baseDoc({ results: [] }))).toThrow(/non-empty/)
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('computeHarness', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-perf-harness-'))
    fs.mkdirSync(path.join(tmp, 'test', 'perf', 'core'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'tools', 'perf'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'test', 'perf', 'core', 'a.bench.ts'), 'a')
    fs.writeFileSync(path.join(tmp, 'vitest.perf.config.ts'), 'config')
    fs.writeFileSync(path.join(tmp, 'tools', 'perf', 'run-core.mjs'), 'runner')
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('is stable across repeated calls on identical content', () => {
    expect(computeHarness(tmp)).toBe(computeHarness(tmp))
  })

  it('changes when a bench file changes', () => {
    const before = computeHarness(tmp)
    fs.writeFileSync(path.join(tmp, 'test', 'perf', 'core', 'a.bench.ts'), 'a-edited')
    expect(computeHarness(tmp)).not.toBe(before)
  })

  it('changes when run-core.mjs changes', () => {
    const before = computeHarness(tmp)
    fs.writeFileSync(path.join(tmp, 'tools', 'perf', 'run-core.mjs'), 'runner-edited')
    expect(computeHarness(tmp)).not.toBe(before)
  })
})
