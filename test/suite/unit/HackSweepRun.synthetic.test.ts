/** The sweep's state handling with no ROM: a fake sweeper stands in for the readers. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { HackRecord } from '../../../tools/scripts/hackSweepReport'
import { batchSize, runSweep, writeAtomic } from '../../../tools/scripts/hackSweepRun'

type Entry = { smwc_id: number; name: string }
const index: Entry[] = [1, 2, 3, 4].map(smwc_id => ({ smwc_id, name: `hack${smwc_id}` }))
const okRec = (h: Entry): HackRecord => ({
  smwcId: h.smwc_id,
  name: h.name,
  romSha256: null,
  romSize: null,
  readers: { maps: { verdict: 'ok', summary: 's' } },
  interop: { verdict: 'unchecked', reason: 'x' },
})
const crashed = { verdict: 'crash', error: 'E: x', frame: 'at f' } as const
const fresh = (): string => mkdtempSync(join(tmpdir(), 'hb-sweeprun-'))
const read = (dir: string, f: string): string => readFileSync(join(dir, f), 'utf8')
const run = (dir: string, sweep: (h: Entry) => HackRecord, size = 2): void =>
  runSweep({ outDir: dir, index, size, sweep, log: () => {} })

describe('runSweep', () => {
  it('rotates two batches over four hacks, carries the first, and diffs only the second', () => {
    const dir = fresh()
    run(dir, okRec)
    expect(JSON.parse(read(dir, 'results.json')).cursor).toBe(3)
    run(dir, okRec)
    const state = JSON.parse(read(dir, 'results.json'))
    expect(state.cursor).toBe(1)
    expect(state.records.map((r: HackRecord) => [r.smwcId, !!r.carried])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ])
    expect(read(dir, 'tracking-issue.md')).toContain('2 carried')
    expect(JSON.parse(read(dir, 'results.prev.json')).cursor).toBe(3)
  })

  it('refuses a truncated results.json before sweeping, and leaves the previous run alone', () => {
    const dir = fresh()
    run(dir, okRec)
    run(dir, okRec)
    const good = read(dir, 'results.prev.json')
    writeFileSync(join(dir, 'results.json'), read(dir, 'results.json').slice(0, 40))
    let swept = 0
    expect(() => run(dir, h => (swept++, okRec(h)))).toThrow(/results\.json/)
    expect(swept).toBe(0)
    expect(read(dir, 'results.prev.json')).toBe(good)
  })

  it('a sweep that dies mid-run changes no state file, so the batch is retried', () => {
    const dir = fresh()
    run(dir, okRec)
    const before = read(dir, 'results.json')
    const dying = (h: Entry): HackRecord => {
      if (h.smwc_id === 4) throw new Error('killed')
      return okRec(h)
    }
    expect(() => run(dir, dying)).toThrow('killed')
    expect(read(dir, 'results.json')).toBe(before)
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('a second run diffs against the first, never against itself', () => {
    const dir = fresh()
    run(dir, okRec, 4)
    const crash = (h: Entry): HackRecord => ({
      ...okRec(h),
      readers: { maps: { verdict: 'crash', error: 'E: x', frame: 'at f' } },
    })
    run(dir, crash, 4)
    expect(read(dir, 'tracking-issue.md')).toContain('1 hack1 / maps: ok -> crash')
  })

  it('rejects an object with no numeric cursor, and one with no records', () => {
    for (const text of ['{"records":[]}', '{"cursor":"1","records":[]}', '{"cursor":1}', '3']) {
      const dir = fresh()
      writeFileSync(join(dir, 'results.json'), text)
      expect(() => run(dir, okRec)).toThrow(/results\.json/)
    }
  })

  it('accepts a legacy bare array as the start of the store, and the next write converts it', () => {
    const dir = fresh()
    const legacy = [okRec(index[0]!), { ...okRec(index[1]!), readers: { maps: crashed } }]
    writeFileSync(join(dir, 'results.json'), JSON.stringify(legacy))
    run(dir, okRec)
    expect(read(dir, 'tracking-issue.md')).toContain('2 hacks compared')
    expect(read(dir, 'tracking-issue.md')).toContain('2 hack2 / maps: crash -> ok')
    expect(JSON.parse(read(dir, 'results.prev.json'))).toEqual(JSON.parse(JSON.stringify(legacy)))
    expect(JSON.parse(read(dir, 'results.json')).cursor).toBe(3)
  })

  it('does not carry a hack that left the index, and lists it as removed', () => {
    const dir = fresh()
    run(dir, okRec)
    const shrunk = index.filter(h => h.smwc_id !== 2)
    runSweep({ outDir: dir, index: shrunk, size: 1, sweep: okRec, log: () => {} })
    const ids = JSON.parse(read(dir, 'results.json')).records.map((r: HackRecord) => r.smwcId)
    expect(ids).toEqual([1, 3])
    expect(read(dir, 'tracking-issue.md')).toContain('2 hack2')
    expect(read(dir, 'tracking-issue.md')).toMatch(/Removed from the store\s+- 2 hack2/)
  })

  it('writes results.json last: a write that fails earlier leaves it untouched', () => {
    const dir = fresh()
    run(dir, okRec)
    const before = read(dir, 'results.json')
    let n = 0
    const write = (path: string, text: string): void => {
      if (++n === 2) throw new Error('disk full')
      writeAtomic(path, text)
    }
    expect(() =>
      runSweep({ outDir: dir, index, size: 2, sweep: okRec, write, log: () => {} }),
    ).toThrow('disk full')
    expect(read(dir, 'results.json')).toBe(before)
  })

  it('summary.md counts the swept and the carried records', () => {
    const dir = fresh()
    run(dir, okRec)
    run(dir, okRec)
    expect(read(dir, 'summary.md')).toContain('4 hacks. 2 swept this run, 2 carried')
  })
})

describe('writeAtomic', () => {
  it('goes through a temp file and a rename, so a failed write leaves the old file', () => {
    const dir = fresh()
    const path = join(dir, 'f.json')
    writeFileSync(path, 'old')
    mkdirSync(`${path}.tmp`)
    expect(() => writeAtomic(path, 'new')).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('old')
  })
  it('replaces the file and leaves no temp file', () => {
    const dir = fresh()
    const path = join(dir, 'f.json')
    writeFileSync(path, 'old')
    writeAtomic(path, 'new')
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['f.json'])
  })
})

describe('batchSize', () => {
  it('defaults to 50 and parses a positive integer', () => {
    expect(batchSize(undefined)).toBe(50)
    expect(batchSize('7')).toBe(7)
  })

  it.each(['', '0', '-3', '2.5', 'abc', '50abc', '1e2'])('refuses %j', raw => {
    expect(() => batchSize(raw)).toThrow(/HACKBENCH_SWEEP_BATCH/)
  })
})
