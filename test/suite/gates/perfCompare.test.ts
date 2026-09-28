/**
 * Proof that the detector (tools/perf/compare.mjs, design section 4 and
 * issue #413's acceptance list) can fail. Every case here plants the exact
 * defect the gate exists to catch, per the oracle rule.
 */
import { describe, it, expect } from 'vitest'
import {
  compareRounds,
  verdictForId,
  bootstrapMedianCI,
  median,
  mulberry32,
  overallExitCode,
  runCli,
} from '../../../tools/perf/compare.mjs'

function roundDoc(id: string, value: number, suite = 'core') {
  return {
    schema: 1,
    sha: 'x',
    suite,
    results: [{ id, unit: 'ms', better: 'lower', samples: [value] }],
  }
}

function rounds(id: string, values: number[]) {
  return values.map(v => roundDoc(id, v))
}

describe('median and mulberry32', () => {
  it('median of odd and even length arrays', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('mulberry32 is deterministic for a given seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect(a()).toBe(b())
    expect(a()).toBe(b())
  })
})

describe('verdictForId - a planted 20% slowdown is REGRESSION', () => {
  it('flags candidate consistently 20% slower than base', () => {
    const id = 'core.synthetic.planted'
    const baseVals = [10.0, 10.1, 9.9, 10.0, 10.2, 9.8, 10.0, 10.1]
    const candVals = baseVals.map(v => v * 1.2)
    const v = verdictForId(id, rounds(id, baseVals), rounds(id, candVals), {
      rng: mulberry32(7),
      resamples: 500,
    })
    expect(v.verdict).toBe('regression')
  })

  it('a 20% speedup is IMPROVEMENT, never actioned but reported', () => {
    const id = 'core.synthetic.planted'
    const baseVals = [10.0, 10.1, 9.9, 10.0, 10.2, 9.8, 10.0, 10.1]
    const candVals = baseVals.map(v => v * 0.8)
    const v = verdictForId(id, rounds(id, baseVals), rounds(id, candVals), {
      rng: mulberry32(7),
      resamples: 500,
    })
    expect(v.verdict).toBe('improvement')
  })
})

describe('A/A noise at 5% jitter stays clean', () => {
  it('at most 2 false positives across 200 seeded trials', () => {
    const id = 'core.synthetic.aa'
    let falsePositives = 0
    for (let trial = 0; trial < 200; trial++) {
      const dataRng = mulberry32(1000 + trial)
      const baseVals: number[] = []
      const candVals: number[] = []
      for (let r = 0; r < 8; r++) {
        baseVals.push(10 * (1 + (dataRng() - 0.5) * 0.05))
        candVals.push(10 * (1 + (dataRng() - 0.5) * 0.05))
      }
      const v = verdictForId(id, rounds(id, baseVals), rounds(id, candVals), {
        rng: mulberry32(50000 + trial),
        resamples: 500,
      })
      if (v.verdict === 'regression') falsePositives++
    }
    expect(falsePositives).toBeLessThanOrEqual(2)
  })
})

describe('one-sided ids are added/removed, never compared', () => {
  it('an id on base only is removed; an id on cand only is added', () => {
    const baseRounds = [roundDoc('core.only-base', 5)]
    const candRounds = [roundDoc('core.only-cand', 5)]
    const verdicts = compareRounds(baseRounds, candRounds, { rng: mulberry32(1) })
    const byId = new Map(verdicts.map(v => [v.id, v.verdict]))
    expect(byId.get('core.only-base')).toBe('removed')
    expect(byId.get('core.only-cand')).toBe('added')
  })
})

describe('overallExitCode', () => {
  it('is 0 with no regression, 1 with any regression', () => {
    expect(overallExitCode([{ verdict: 'ok' }, { verdict: 'improvement' }])).toBe(0)
    expect(overallExitCode([{ verdict: 'ok' }, { verdict: 'regression' }])).toBe(1)
  })
})

describe('CLI exits 2 on malformed input', () => {
  function fakeFs(text: string | null) {
    return {
      async readFile() {
        if (text === null) throw new Error('ENOENT')
        return text
      },
      async writeFile() {},
    }
  }

  it('exits 2 when the file cannot be read', async () => {
    const code = await runCli(['--in', 'missing.json'], {
      fs: fakeFs(null),
      log: () => {},
      err: () => {},
    })
    expect(code).toBe(2)
  })

  it('exits 2 on unparsable JSON', async () => {
    const code = await runCli(['--in', 'x.json'], {
      fs: fakeFs('{not json'),
      log: () => {},
      err: () => {},
    })
    expect(code).toBe(2)
  })

  it('exits 2 when baseRounds is missing', async () => {
    const code = await runCli(['--in', 'x.json'], {
      fs: fakeFs(JSON.stringify({ candRounds: [roundDoc('core.a', 1)] })),
      log: () => {},
      err: () => {},
    })
    expect(code).toBe(2)
  })

  it('exits 2 when a round result has no samples', async () => {
    const badDoc = {
      schema: 1,
      sha: 'x',
      suite: 'core',
      results: [{ id: 'core.a', unit: 'ms', better: 'lower', samples: [] }],
    }
    const code = await runCli(['--in', 'x.json'], {
      fs: fakeFs(JSON.stringify({ baseRounds: [badDoc], candRounds: [roundDoc('core.a', 1)] })),
      log: () => {},
      err: () => {},
    })
    expect(code).toBe(2)
  })

  it('exits 0 for a clean comparison and 1 for a planted one, via the real CLI path', async () => {
    const id = 'core.cli.check'
    const cleanDoc = {
      baseRounds: rounds(id, [10, 10, 10, 10]),
      candRounds: rounds(id, [10, 10, 10, 10]),
    }
    const regressedDoc = {
      baseRounds: rounds(id, [10, 10, 10, 10]),
      candRounds: rounds(id, [13, 13, 13, 13]),
    }
    expect(
      await runCli(['--in', 'clean.json', '--seed', '1'], {
        fs: fakeFs(JSON.stringify(cleanDoc)),
        log: () => {},
        err: () => {},
      }),
    ).toBe(0)
    expect(
      await runCli(['--in', 'bad.json', '--seed', '1'], {
        fs: fakeFs(JSON.stringify(regressedDoc)),
        log: () => {},
        err: () => {},
      }),
    ).toBe(1)
  })
})

describe('bootstrapMedianCI', () => {
  it('a single value has a degenerate interval equal to itself', () => {
    const ci = bootstrapMedianCI([5], { rng: mulberry32(1) })
    expect(ci.lower).toBe(5)
    expect(ci.upper).toBe(5)
    expect(ci.estimate).toBe(5)
  })
})
