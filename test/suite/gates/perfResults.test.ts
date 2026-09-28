/**
 * Proof that the result-format gate (tools/perf/results.mjs, design section 1)
 * can fail. A suite that measured nothing must never report green.
 */
import { describe, it, expect } from 'vitest'
import { validate, familyOf, writeResultText } from '../../../tools/perf/results.mjs'

function baseDoc(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    sha: 'abc123',
    suite: 'core',
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

  it('writeResultText round-trips through JSON.parse and validate', () => {
    const text = writeResultText(baseDoc())
    expect(() => validate(JSON.parse(text))).not.toThrow()
  })
})

describe('familyOf', () => {
  it('is the first dotted segment', () => {
    expect(familyOf('core.lclz2.decompress.synthetic-64k')).toBe('core')
    expect(familyOf('heap.views.slope')).toBe('heap')
  })
})
