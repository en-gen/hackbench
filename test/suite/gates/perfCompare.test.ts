/**
 * Proof that the detector (tools/perf/compare.mjs, design section 4, D1/D2,
 * and issue #413's acceptance list) can fail. Every case here either plants
 * a defect the gate exists to catch, or is a witness handed down from
 * adversarial review that a concrete off-by-one or dropped check would flip
 * (see docs/superpowers/specs/2026-09-28-perf-gates-design.md and the
 * mutation driver in the session scratchpad this PR was reviewed against).
 */
import { describe, it, expect } from 'vitest'
import {
  compareRounds,
  verdictForId,
  bootstrapMedianCI,
  median,
  mulberry32,
  runCli,
  MIN_PAIRS,
} from '../../../tools/perf/compare.mjs'

function roundDoc(id: string, value: number, opts: { unit?: string; harness?: string } = {}) {
  const { unit = 'ms', harness = 'h' } = opts
  return {
    schema: 1,
    sha: 'x',
    suite: 'core',
    harness,
    results: [{ id, unit, better: 'lower', samples: [value] }],
  }
}

function rounds(id: string, values: number[], opts: { unit?: string; harness?: string } = {}) {
  return values.map(v => roundDoc(id, v, opts))
}

describe('median', () => {
  it('odd and even length arrays', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
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
    const baseRounds = rounds('core.only-base', [5, 5, 5, 5, 5])
    const candRounds = rounds('core.only-cand', [5, 5, 5, 5, 5])
    const verdicts = compareRounds(baseRounds, candRounds, { rng: mulberry32(1) })
    const byId = new Map(verdicts.map(v => [v.id, v.verdict]))
    expect(byId.get('core.only-base')).toBe('removed')
    expect(byId.get('core.only-cand')).toBe('added')
  })
})

describe('design D2: at least 5 pairs, else malformed', () => {
  it('rejects fewer than MIN_PAIRS paired rounds for an id', () => {
    expect(MIN_PAIRS).toBe(5)
    const id = 'core.few'
    expect(() =>
      verdictForId(id, rounds(id, [10, 10, 10, 10]), rounds(id, [11, 11, 11, 11])),
    ).toThrow(/at least 5/)
  })
})

describe('unknown family and unit/family agreement', () => {
  it('rejects an id whose family is not core/app/startup/heap', () => {
    const id = 'bogus.x.y'
    expect(() =>
      verdictForId(id, rounds(id, [10, 10, 10, 10, 10]), rounds(id, [10, 10, 10, 10, 10])),
    ).toThrow(/unknown perf family/)
  })

  it('rejects a heap id measured in ms instead of bytes/cycle', () => {
    const id = 'heap.wrong-unit'
    const baseR = rounds(id, [1, 1, 1, 1, 1], { unit: 'ms' })
    const candR = rounds(id, [1, 1, 1, 1, 1], { unit: 'ms' })
    expect(() => verdictForId(id, baseR, candR)).toThrow(/unit does not match family/)
  })
})

// ---------------------------------------------------------------------------
// Adversarial-review witnesses. Each value set is chosen so a specific
// off-by-one or dropped check flips the verdict; a correct implementation
// must land where the comment says.
// ---------------------------------------------------------------------------

describe('adversarial witnesses', () => {
  it('M2 upper-bound: a mostly-flat series with a high tail stays ok', () => {
    const id = 'core.x'
    const v = verdictForId(
      id,
      rounds(id, Array(10).fill(10)),
      rounds(id, [9, 9, 10, 10, 10, 10, 11, 12, 13, 14]),
      {
        rng: mulberry32(1),
        resamples: 2000,
      },
    )
    expect(v.verdict).toBe('ok')
  })

  it('M3 point estimate vs interval: a point estimate past threshold with a wide interval stays ok', () => {
    const id = 'core.x'
    const v = verdictForId(
      id,
      rounds(id, Array(10).fill(10)),
      rounds(id, [9, 9.5, 10, 11.2, 11.2, 11.2, 11.3, 11.5, 12, 12.5]),
      { rng: mulberry32(1), resamples: 2000 },
    )
    expect(v.verdict).toBe('ok')
  })

  it('M4 seed: identical seed gives an identical verdict, on this call and across a sweep', () => {
    const id = 'core.x'
    const baseR = rounds(id, Array(8).fill(10))
    const candR = rounds(id, [10.5, 11, 11.1, 11.2, 11.3, 11.4, 12, 13])
    const first = verdictForId(id, baseR, candR, { rng: mulberry32(1), resamples: 2000 })
    const second = verdictForId(id, baseR, candR, { rng: mulberry32(1), resamples: 2000 })
    expect(second.verdict).toBe(first.verdict)
    expect(second.lower).toBe(first.lower)
    expect(second.upper).toBe(first.upper)
    // the default seed (1) is asserted explicitly, not just "matches itself"
    expect(first.verdict).toBe('ok')

    for (let seed = 2; seed <= 20; seed++) {
      const a = verdictForId(id, baseR, candR, { rng: mulberry32(seed), resamples: 2000 })
      const b = verdictForId(id, baseR, candR, { rng: mulberry32(seed), resamples: 2000 })
      expect(b.verdict).toBe(a.verdict)
      expect(b.lower).toBe(a.lower)
    }
  })

  it('M5 bootstrap index off-by-one: an outlier that only the correct resampler can reach', () => {
    // ratios [1.15,1.15,1.15,1.15,0.7]: the correct bootstrap can resample
    // index 4 (the 0.7) and its interval reaches down to 0.7, staying ok. An
    // off-by-one that never draws the last index degenerates to a point mass
    // at 1.15 and would read as regression instead - found by scripting the
    // actual mutant against candidate value sets, not guessed.
    const id = 'core.x'
    const v = verdictForId(
      id,
      rounds(id, Array(5).fill(10)),
      rounds(id, [11.5, 11.5, 11.5, 11.5, 7.0]),
      {
        rng: mulberry32(1),
        resamples: 2000,
      },
    )
    expect(v.verdict).toBe('ok')
  })

  it('M6 bootstrap never resamples: an outlier that must be resamplable to stay ok', () => {
    const id = 'core.x'
    const v = verdictForId(
      id,
      rounds(id, Array(6).fill(10)),
      rounds(id, [11.5, 11.5, 11.5, 9, 9, 20]),
      {
        rng: mulberry32(1),
        resamples: 2000,
      },
    )
    expect(v.verdict).toBe('ok')
  })

  it('M7 pairing: base and cand identical round for round stays ok even with wide spread', () => {
    const id = 'core.x'
    const vals = [5, 10, 20, 40, 80, 160, 320, 640]
    const v = verdictForId(id, rounds(id, vals), rounds(id, vals), {
      rng: mulberry32(1),
      resamples: 2000,
    })
    expect(v.verdict).toBe('ok')
  })

  it('M8 family threshold: 12% is ok for app (0.15) though it would regress core (0.10)', () => {
    const id = 'app.x'
    const v = verdictForId(id, rounds(id, Array(5).fill(10)), rounds(id, Array(5).fill(11.2)), {
      rng: mulberry32(1),
      resamples: 2000,
    })
    expect(v.verdict).toBe('ok')
  })

  it('M9 threshold value: 15% is a regression for core (0.10)', () => {
    const id = 'core.x'
    const v = verdictForId(id, rounds(id, Array(5).fill(10)), rounds(id, Array(5).fill(11.5)), {
      rng: mulberry32(1),
      resamples: 2000,
    })
    expect(v.verdict).toBe('regression')
  })

  it('M17/M18 a: a mostly-flat series with one high round is not a regression', () => {
    const id = 'core.x'
    const v = verdictForId(
      id,
      rounds(id, Array(10).fill(10)),
      rounds(id, [10, 10, 10, 12, 10, 10, 10, 12, 10, 10]),
      {
        rng: mulberry32(1),
        resamples: 2000,
      },
    )
    expect(v.verdict).toBe('ok')
  })

  it('M17/M18 b: a symmetric spread around the base median is not an improvement', () => {
    const id = 'core.x'
    const v = verdictForId(
      id,
      rounds(id, Array(10).fill(10)),
      rounds(id, [8, 9, 10, 11, 12, 8, 9, 10, 11, 12]),
      {
        rng: mulberry32(1),
        resamples: 2000,
      },
    )
    expect(v.verdict).toBe('ok')
  })
})

describe('heap family compares differences, not ratios', () => {
  it('a planted slope well past the byte floor regresses', () => {
    const id = 'heap.views.slope'
    const baseVals = [1000, 1050, 980, 1020, 1010, 990, 1005, 1015]
    const candVals = baseVals.map(v => v + 200_000)
    const v = verdictForId(
      id,
      rounds(id, baseVals, { unit: 'bytes/cycle' }),
      rounds(id, candVals, { unit: 'bytes/cycle' }),
      {
        rng: mulberry32(3),
        resamples: 500,
      },
    )
    expect(v.metric).toBe('difference')
    expect(v.verdict).toBe('regression')
  })

  it('a flat series with noise under the floor does not regress', () => {
    const id = 'heap.views.flat'
    const dataRng = mulberry32(9)
    const baseVals: number[] = []
    const candVals: number[] = []
    for (let i = 0; i < 8; i++) {
      baseVals.push(1000 + (dataRng() - 0.5) * 200)
      candVals.push(1000 + (dataRng() - 0.5) * 200)
    }
    const v = verdictForId(
      id,
      rounds(id, baseVals, { unit: 'bytes/cycle' }),
      rounds(id, candVals, { unit: 'bytes/cycle' }),
      {
        rng: mulberry32(10),
        resamples: 500,
      },
    )
    expect(v.verdict).toBe('ok')
  })

  it('M11 the relative term matters even when the base median is large', () => {
    // 1e6 -> 1.1e6 is a 10% difference, under the 25% relative floor.
    const id = 'heap.x'
    const v = verdictForId(
      id,
      rounds(id, Array(5).fill(1e6), { unit: 'bytes/cycle' }),
      rounds(id, Array(5).fill(1.1e6), { unit: 'bytes/cycle' }),
      {
        rng: mulberry32(1),
        resamples: 2000,
      },
    )
    expect(v.verdict).toBe('ok')
  })

  it('the floor is at least 64 KiB even when the base median is near zero', () => {
    const id = 'heap.views.nearzero'
    const baseVals = [0, 1, -1, 0, 1, -1, 0, 1]
    const candVals = baseVals.map(v => v + 500)
    const v = verdictForId(
      id,
      rounds(id, baseVals, { unit: 'bytes/cycle' }),
      rounds(id, candVals, { unit: 'bytes/cycle' }),
      {
        rng: mulberry32(4),
        resamples: 500,
      },
    )
    expect(v.threshold).toBeGreaterThanOrEqual(64 * 1024)
    expect(v.verdict).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// CLI: fail-closed on every malformed shape, exits 0/1 correctly otherwise.
// ---------------------------------------------------------------------------

describe('CLI', () => {
  function fakeFs(text: string | null) {
    return {
      async readFile() {
        if (text === null) throw new Error('ENOENT')
        return text
      },
      async writeFile() {},
    }
  }

  async function cli(body: unknown) {
    return runCli(['--in', 'x.json', '--seed', '1'], {
      fs: fakeFs(JSON.stringify({ schema: 1, suite: 'core', ...(body as object) })),
      log: () => {},
      err: () => {},
    })
  }

  it('exits 2 on wrong or omitted schema or suite, or a mismatched round suite', async () => {
    const ok = () => rounds('core.a', [1, 1, 1, 1, 1])
    const base = {
      baseRounds: ok(),
      candRounds: ok(),
      schema: 1,
      suite: 'core',
    }
    expect(await cli(base)).toBe(0)
    expect(await cli({ ...base, schema: undefined })).toBe(2)
    expect(await cli({ ...base, schema: 2 })).toBe(2)
    expect(await cli({ ...base, suite: undefined })).toBe(2)
    expect(await cli({ ...base, suite: 'other' })).toBe(2)
    expect(await cli({ ...base, suite: 'app' })).toBe(2)
    const appRound = { ...roundDoc('core.a', 1), suite: 'app' }
    expect(await cli({ ...base, candRounds: [appRound, ...ok().slice(1)] })).toBe(2)
  })

  it('exits 2 when the file cannot be read', async () => {
    expect(
      await runCli(['--in', 'missing.json'], { fs: fakeFs(null), log: () => {}, err: () => {} }),
    ).toBe(2)
  })

  it('exits 2 on unparsable JSON', async () => {
    expect(
      await runCli(['--in', 'x.json'], { fs: fakeFs('{not json'), log: () => {}, err: () => {} }),
    ).toBe(2)
  })

  it('exits 2 when baseRounds is missing', async () => {
    expect(await cli({ candRounds: rounds('core.a', [1, 1, 1, 1, 1]) })).toBe(2)
  })

  it('exits 2 when a round result has no samples', async () => {
    const badDoc = {
      schema: 1,
      sha: 'x',
      suite: 'core',
      harness: 'h',
      results: [{ id: 'core.a', unit: 'ms', better: 'lower', samples: [] }],
    }
    expect(await cli({ baseRounds: [badDoc], candRounds: rounds('core.a', [1, 1, 1, 1, 1]) })).toBe(
      2,
    )
  })

  it('M3: exits 2 when cand results is empty', async () => {
    const emptyDoc = { schema: 1, sha: 'x', suite: 'core', harness: 'h', results: [] }
    expect(
      await cli({ baseRounds: rounds('core.a', [1, 1, 1, 1, 1]), candRounds: [emptyDoc] }),
    ).toBe(2)
  })

  it('M3: exits 2 when candRounds itself is empty', async () => {
    expect(await cli({ baseRounds: rounds('core.a', [1, 1, 1, 1, 1]), candRounds: [] })).toBe(2)
  })

  it('M3: exits 1 (not 2) when every id is one-sided - added/removed, never compared', async () => {
    const baseRounds = rounds('core.starved', [1, 1, 1, 1, 1])
    const candRounds = rounds('core.other', [1, 1, 1, 1, 1])
    // Neither id appears on both sides, so both are added/removed - reported,
    // not a bootstrap failure. D1 still fails the run (removed needs
    // acceptance), but distinctly from malformed input.
    expect(await cli({ baseRounds, candRounds })).toBe(1)
  })

  it('M3: exits 2 when an id is on both sides but never in the same round index', async () => {
    // 'core.x' is base-only at round 0 and cand-only at round 1: idsOf sees
    // it on both sides (so it is NOT reported added/removed), but no round
    // index has it paired, starving the bootstrap of any sample at all.
    const baseRounds = [
      roundDoc('core.x', 1),
      roundDoc('core.filler', 1),
      roundDoc('core.filler', 1),
      roundDoc('core.filler', 1),
      roundDoc('core.filler', 1),
    ]
    const candRounds = [
      roundDoc('core.filler', 1),
      roundDoc('core.x', 1),
      roundDoc('core.filler', 1),
      roundDoc('core.filler', 1),
      roundDoc('core.filler', 1),
    ]
    expect(await cli({ baseRounds, candRounds })).toBe(2)
  })

  it('exits 2 when baseRounds and candRounds have unequal length (design D2)', async () => {
    expect(
      await cli({
        baseRounds: rounds('core.a', [1, 1, 1, 1, 1]),
        candRounds: rounds('core.a', [1, 1, 1, 1]),
      }),
    ).toBe(2)
  })

  it('exits 2 when base and cand harness hashes differ (design D1)', async () => {
    const baseRounds = rounds('core.a', [1, 1, 1, 1, 1], { harness: 'aaa' })
    const candRounds = rounds('core.a', [1, 1, 1, 1, 1], { harness: 'bbb' })
    expect(await cli({ baseRounds, candRounds })).toBe(2)
  })

  it('exits 2 on a per-round doc that fails results.mjs validation on its own (schema)', async () => {
    // Nothing else in compare.mjs ever reads `schema` - only the explicit
    // `validateResultDoc(d)` call over every round catches this, so this
    // isolates that call from every other check (array lengths, harness
    // equality, unit/family agreement) that would also reject a more
    // obviously-broken doc for an unrelated reason. Same length both sides,
    // so only the schema field is wrong.
    const baseRounds = rounds('core.a', [1, 1, 1, 1, 1])
    baseRounds[0] = { ...baseRounds[0], schema: 2 }
    expect(await cli({ baseRounds, candRounds: rounds('core.a', [1, 1, 1, 1, 1]) })).toBe(2)
  })

  it('exits 2 on --seed that is not a finite integer', async () => {
    const code = await runCli(['--in', 'x.json', '--seed', 'nope'], {
      fs: fakeFs(
        JSON.stringify({
          baseRounds: rounds('core.a', [1, 1, 1, 1, 1]),
          candRounds: rounds('core.a', [1, 1, 1, 1, 1]),
        }),
      ),
      log: () => {},
      err: () => {},
    })
    expect(code).toBe(2)
  })

  it('exits 2 on --resamples below 1000', async () => {
    const code = await runCli(['--in', 'x.json', '--resamples', '10'], {
      fs: fakeFs(
        JSON.stringify({
          baseRounds: rounds('core.a', [1, 1, 1, 1, 1]),
          candRounds: rounds('core.a', [1, 1, 1, 1, 1]),
        }),
      ),
      log: () => {},
      err: () => {},
    })
    expect(code).toBe(2)
  })

  it('exits 0 for a clean comparison and 1 for a planted one, via the real CLI path', async () => {
    const id = 'core.cli.check'
    expect(
      await cli({
        baseRounds: rounds(id, [10, 10, 10, 10, 10]),
        candRounds: rounds(id, [10, 10, 10, 10, 10]),
      }),
    ).toBe(0)
    expect(
      await cli({
        baseRounds: rounds(id, [10, 10, 10, 10, 10]),
        candRounds: rounds(id, [13, 13, 13, 13, 13]),
      }),
    ).toBe(1)
  })

  it('exits 1 when an id is removed (design D1), not just on regression', async () => {
    expect(
      await cli({
        baseRounds: rounds('core.gone', [1, 1, 1, 1, 1]),
        candRounds: rounds('core.new', [1, 1, 1, 1, 1]),
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
