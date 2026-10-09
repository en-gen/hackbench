/** The sweep's state handling with no ROM: a fake sweeper stands in for the readers. */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { HackRecord } from '../../../tools/scripts/hackSweepReport'
import { runSweep } from '../../../tools/scripts/hackSweepRun'

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

  it('rejects a results.json that parses but has the wrong shape', () => {
    const dir = fresh()
    writeFileSync(join(dir, 'results.json'), '[]')
    expect(() => run(dir, okRec)).toThrow(/results\.json/)
  })
})
