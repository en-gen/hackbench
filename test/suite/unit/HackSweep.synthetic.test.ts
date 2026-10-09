/** The hack sweep's verdicts and summary, with no ROM: the sweep itself is hand-run. */
import { createHash } from 'crypto'
import { describe, it, expect } from 'vitest'
import {
  HackRecord,
  blockerKey,
  decideInterop,
  diffRuns,
  gfxRefusals,
  mergeCarried,
  pickBatch,
  runReader,
  stripByteRuns,
  summarize,
  trackingIssueBody,
} from '../../../tools/scripts/hackSweepReport'

describe('runReader', () => {
  it('passes an ok and a refusal through, and turns a throw into a crash with its frame', () => {
    expect(runReader(() => ({ verdict: 'ok', summary: '3 maps' }))).toEqual({
      verdict: 'ok',
      summary: '3 maps',
    })
    expect(runReader(() => ({ verdict: 'unavailable', reasons: ['a', 'b'] }))).toEqual({
      verdict: 'unavailable',
      reasons: ['a', 'b'],
    })
    const crash = runReader(() => {
      throw new RangeError('offset out of bounds')
    })
    expect(crash).toMatchObject({ verdict: 'crash', error: 'RangeError: offset out of bounds' })
    expect(crash.verdict === 'crash' && crash.frame).toMatch(/^at .*HackSweep\.synthetic\.test\.ts/)
  })
})

describe('stripByteRuns', () => {
  it('elides runs past an opcode and operand, keeping the address and gate name', () => {
    const reason = '$05D8A2 (CODE_05D8A2) holds c9 25 90 03 38, not the stock c9 ?? 90 03 38.'
    expect(stripByteRuns(reason)).toBe(
      '$05D8A2 (CODE_05D8A2) holds <bytes>, not the stock <bytes>.',
    )
    expect(stripByteRuns('holds 22 ff eb 92')).toBe('holds 22 ff eb 92')
    expect(runReader(() => ({ verdict: 'unavailable', reasons: [reason] }))).toMatchObject({
      reasons: ['$05D8A2 (CODE_05D8A2) holds <bytes>, not the stock <bytes>.'],
    })
  })
})

describe('gfxRefusals', () => {
  const files = [{ index: 0, unavailable: 'loader patched' }, { index: 1 }]
  it('records listed and deliberately thrown refusals', () => {
    const decode = (): never => {
      throw new Error('Palette column 1 is unavailable: patched')
    }
    expect(gfxRefusals(files, decode)).toEqual([
      'loader patched',
      'Palette column 1 is unavailable: patched',
    ])
  })
  it('lets any other throw through, so the sweep reports a crash', () => {
    const typeErr = (): never => {
      throw new TypeError('GFX file $01 is unavailable: x')
    }
    const other = (): never => {
      throw new Error('Address out of range')
    }
    expect(() => gfxRefusals(files, typeErr)).toThrow(TypeError)
    expect(() => gfxRefusals(files, other)).toThrow('Address out of range')
  })
})

describe('decideInterop', () => {
  const bytes = Uint8Array.of(1, 2, 3)
  const sha = createHash('sha256').update(bytes).digest('hex')
  it('matches only when our output hashes to the index', () => {
    expect(decideInterop(`\\${sha.toUpperCase()}`, { ok: true, bytes })).toMatchObject({
      verdict: 'match',
    })
    expect(decideInterop(sha, { ok: true, bytes: Uint8Array.of(1, 2, 4) })).toMatchObject({
      verdict: 'mismatch',
    })
  })
  it('reports a refused patch and an unparseable index hash', () => {
    expect(decideInterop(sha, { ok: false, reason: 'crc' })).toEqual({
      verdict: 'refused',
      reason: 'crc',
    })
    expect(decideInterop(sha.slice(1), { ok: true, bytes })).toMatchObject({
      verdict: 'index-hash-invalid',
    })
  })
})

describe('blockerKey', () => {
  it('folds a FastROM mirror and drops what a hack put at the gate', () => {
    expect(blockerKey('call targets $85DCD0')).toBe(blockerKey('call targets $05DCD0'))
    expect(blockerKey('$0096F4 (JSL, x.asm:1) holds 22 ff eb 92, not the stock 22 96 d7 05.')).toBe(
      '$0096F4 (JSL, x.asm:1) is not stock.',
    )
  })
})

describe('summarize', () => {
  const rec = (smwcId: number, maps: HackRecord['readers'][string]): HackRecord => ({
    smwcId,
    name: `hack ${smwcId}`,
    romSha256: null,
    romSize: smwcId === 5 ? 0x300200 : null,
    readers: { maps },
    interop:
      smwcId === 2
        ? { verdict: 'mismatch', resultSha256: 'b' }
        : { verdict: 'match', resultSha256: 'a' },
  })
  const u = (...reasons: string[]) => ({ verdict: 'unavailable' as const, reasons })
  const md = summarize([
    rec(1, { verdict: 'ok', summary: '9 maps, 0 roots, 9 unassigned' }),
    rec(2, u('shared', 'rare')),
    rec(3, u('shared')),
    rec(4, u('shared', 'rare')),
    rec(5, { verdict: 'crash', error: 'TypeError: x', frame: 'at f' }),
  ])

  it('counts each verdict per view with the share that works', () => {
    expect(md).toContain('| maps | 1 | 3 | 1 | 20.0% |')
  })

  it('ranks each gate by the hacks it alone blocks and by all it blocks', () => {
    expect(md).toContain('| 1 | 3 | shared |')
    expect(md).toContain('| 0 | 2 | rare |')
    expect(md.indexOf('| shared |')).toBeLessThan(md.indexOf('| rare |'))
  })

  it('lists flat trees, crashes, headered-size ROMs and interop failures', () => {
    expect(md).toContain('1 hacks load with 0 roots')
    expect(md).toContain('- 5 hack 5 / maps: TypeError: x (at f)')
    expect(md).toContain('- 5 hack 5: 3146240 bytes')
    expect(md).toContain('- match: 4')
    expect(md).toContain('- mismatch: 2 hack 2: b')
  })
})

type Readers = HackRecord['readers']
const rec = (smwcId: number, readers: Readers): HackRecord => ({
  smwcId,
  name: `hack${smwcId}`,
  romSha256: null,
  romSize: null,
  readers,
  interop: { verdict: 'unchecked', reason: 'x' },
})
const okR = { verdict: 'ok', summary: 's' } as const
const gate = (...reasons: string[]): Readers['v'] => ({ verdict: 'unavailable', reasons })
const crashR = { verdict: 'crash', error: 'E: boom', frame: 'at f' } as const

describe('diffRuns', () => {
  it('reports a new crash and a cleared crash, and counts only the hacks in both runs', () => {
    const prev = [rec(1, { maps: okR }), rec(2, { maps: crashR })]
    const cur = [rec(1, { maps: crashR }), rec(2, { maps: okR })]
    const d = diffRuns(prev, cur)
    expect(d.compared).toBe(2)
    expect(d.newCrashes).toEqual(['1 hack1 / maps'])
    expect(d.clearedCrashes).toEqual(['2 hack2 / maps'])
  })

  it('reports each verdict change per view and ignores a view that did not change', () => {
    const prev = [rec(1, { maps: okR, sfx: okR })]
    const cur = [rec(1, { maps: gate('g'), sfx: okR })]
    const d = diffRuns(prev, cur)
    expect(d.verdictChanges).toEqual(['1 hack1 / maps: ok -> unavailable'])
    expect(d.newCrashes).toEqual([])
  })

  it('reports works-on before and after per view, over the shared hacks only', () => {
    const prev = [rec(1, { maps: okR }), rec(2, { maps: okR }), rec(9, { maps: gate('g') })]
    const cur = [rec(1, { maps: okR }), rec(2, { maps: gate('g') }), rec(8, { maps: okR })]
    expect(diffRuns(prev, cur).worksOn).toEqual([
      { view: 'maps', before: '100.0%', after: '50.0%' },
    ])
    expect(diffRuns([rec(1, { maps: okR })], [rec(1, { maps: okR })]).worksOn).toEqual([])
  })

  it('reports a blocker that moves up the ranking, and one that appears', () => {
    const prev = [rec(1, { v: gate('A') }), rec(2, { v: gate('A') }), rec(3, { v: gate('B') })]
    const cur = [rec(1, { v: gate('B') }), rec(2, { v: gate('B') }), rec(3, { v: gate('B') })]
    expect(diffRuns(prev, cur).blockerMoves).toEqual(['v: A: #1 -> unranked', 'v: B: #2 -> #1'])
  })

  it('lists a hack in one run as added or not covered, and does not diff it', () => {
    const d = diffRuns(
      [rec(1, { maps: okR }), rec(2, { maps: okR })],
      [rec(1, { maps: okR }), rec(3, { maps: crashR })],
    )
    expect(d.added).toEqual(['3 hack3'])
    expect(d.removed).toEqual(['2 hack2'])
    expect(d.compared).toBe(1)
    expect(d.newCrashes).toEqual([])
  })

  it('goes red on a planted diff that ignores verdict changes', () => {
    const catches = (diff: typeof diffRuns): boolean => {
      const d = diff([rec(1, { maps: okR })], [rec(1, { maps: crashR })])
      return d.newCrashes.length === 1 && d.verdictChanges.length === 1
    }
    expect(catches(diffRuns)).toBe(true)
    // The planted defect compares the previous run with itself, so no verdict can differ.
    expect(catches(prev => diffRuns(prev, prev))).toBe(false)
  })

  it('ranks blockers over the compared hacks only, not over every previous record', () => {
    const prev = [rec(1, { v: gate('A') }), rec(2, { v: gate('B') }), rec(3, { v: gate('B') })]
    const carry = (r: HackRecord): HackRecord => ({ ...r, carried: true })
    const cur = [prev[0]!, carry(prev[1]!), carry(prev[2]!)]
    expect(diffRuns(prev, cur).blockerMoves).toEqual([])
  })

  it('counts carried records and says so in the tracking body', () => {
    const prev = [rec(1, { maps: okR }), rec(2, { maps: okR }), rec(3, { maps: okR })]
    const cur = [prev[0]!, ...prev.slice(1).map((r): HackRecord => ({ ...r, carried: true }))]
    const d = diffRuns(prev, cur)
    expect(d.carried).toBe(2)
    expect(trackingIssueBody(d, 's')).toContain('2 carried')
  })
})

describe('pickBatch', () => {
  // The cursor is the next smwc_id to sweep, so a changed store cannot move it onto another hack.
  const index = [5, 1, 3, 2, 4].map(smwc_id => ({ smwc_id }))
  const ids = (b: { smwc_id: number }[]): number[] => b.map(h => h.smwc_id)

  it('takes the next n in id order from the cursor and returns the next id', () => {
    const r = pickBatch(index, 2, 2)
    expect(ids(r.batch)).toEqual([2, 3])
    expect(r.next).toBe(4)
  })
  it('wraps past the end', () => {
    const r = pickBatch(index, 4, 3)
    expect(ids(r.batch)).toEqual([4, 5, 1])
    expect(r.next).toBe(2)
  })
  it('covers every hack once when n is at or past the total', () => {
    for (const n of [5, 6, 100]) {
      const r = pickBatch(index, 3, n)
      expect(ids(r.batch).sort()).toEqual([1, 2, 3, 4, 5])
      expect(r.next).toBe(3)
    }
  })
  it('returns nothing for an empty index', () => {
    expect(pickBatch([], 7, 3)).toEqual({ batch: [], next: 0 })
  })
  it('starts over from the first hack when the cursor is past every id', () => {
    expect(ids(pickBatch(index, 99, 1).batch)).toEqual([1])
    expect(ids(pickBatch(index, -4, 1).batch)).toEqual([1])
  })
  it('does not skip the next hack when the hack before the cursor is removed', () => {
    const store = [1, 3, 4].map(smwc_id => ({ smwc_id }))
    expect(ids(pickBatch(store, 3, 2).batch)).toEqual([3, 4])
  })
  it('does not re-sweep a hack when one is added before the cursor', () => {
    const store = [0, 1, 2, 3, 4].map(smwc_id => ({ smwc_id }))
    expect(ids(pickBatch(store, 3, 2).batch)).toEqual([3, 4])
  })
  it('visits every hack across successive runs', () => {
    let cursor = 0
    const seen = new Set<number>()
    for (let run = 0; run < 3; run++) {
      const r = pickBatch(index, cursor, 2)
      ids(r.batch).forEach(i => seen.add(i))
      cursor = r.next
    }
    expect(seen.size).toBe(5)
  })
})

describe('trackingIssueBody', () => {
  it('names the changes and embeds the summary; a first run says there is nothing to compare', () => {
    const d = diffRuns([rec(1, { maps: okR })], [rec(1, { maps: crashR })])
    const body = trackingIssueBody(d, '# Hack sweep\n')
    expect(body).toContain('1 hack1 / maps: ok -> crash')
    expect(body).toContain('# Hack sweep')
    expect(trackingIssueBody(null, 's')).toContain('First run')
  })
})

describe('carry-forward across batches smaller than the store', () => {
  const store = [1, 2, 3, 4].map(smwc_id => ({ smwc_id }))
  const sweep = (ids: number[], view: Readers['v']): HackRecord[] =>
    ids.map(id => rec(id, { maps: view }))

  it('does not report a carried record as changed, whatever its verdict differs by', () => {
    const prev = sweep([1, 2], okR)
    const cur = [rec(1, { maps: crashR }), { ...rec(2, { maps: crashR }), carried: true as const }]
    const d = diffRuns(prev, cur)
    expect(d.compared).toBe(1)
    expect(d.newCrashes).toEqual(['1 hack1 / maps'])
    expect(d.removed).toEqual([])
  })

  it('two runs of batch 2 over 4 hacks: the second diffs its own two and carries the first two', () => {
    const run1 = sweep([1, 2], okR)
    const b = pickBatch(store, 3, 2)
    const swept = sweep(
      b.batch.map(h => h.smwc_id),
      crashR,
    )
    const run2 = mergeCarried(run1, swept, [1, 2, 3, 4])
    expect(run2.map(r => [r.smwcId, !!r.carried])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ])
    const d = diffRuns(run1, run2)
    expect(d.added).toEqual(['3 hack3', '4 hack4'])
    expect(d.removed).toEqual([])
    expect(d.compared).toBe(0)
  })

  it('a re-swept hack replaces its carried record and is diffed against it', () => {
    const run1 = mergeCarried(sweep([1, 2], okR), sweep([3], okR), [1, 2, 3])
    const run2 = mergeCarried(run1, sweep([1], crashR), [1, 2, 3])
    expect(run2.find(r => r.smwcId === 1)?.carried).toBeUndefined()
    expect(run2.find(r => r.smwcId === 3)?.carried).toBe(true)
    expect(diffRuns(run1, run2).newCrashes).toEqual(['1 hack1 / maps'])
  })

  it('summarize says how many records were carried', () => {
    const md = summarize(mergeCarried(sweep([1, 2], okR), sweep([3], okR), [1, 2, 3]))
    expect(md).toContain('1 swept this run, 2 carried')
  })

  it('drops a hack no longer in the store and lists it as removed', () => {
    const run1 = sweep([1, 2, 3], okR)
    const run2 = mergeCarried(run1, sweep([1], okR), [1, 3])
    expect(run2.map(r => r.smwcId)).toEqual([1, 3])
    expect(diffRuns(run1, run2).removed).toEqual(['2 hack2'])
    expect(summarize(run2)).toContain('2 hacks.')
  })
})
