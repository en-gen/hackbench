/**
 * Detection over the corpus (#755): vanilla records $0D, every ROM's scan time
 * is measured, and the 300 ms progress-view threshold is checked. Needs the
 * corpus; the synthetic suite proves the logic where CI runs.
 */
import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
import { RomFile } from '../../../src/rom/RomFile'
import { locateObjectCodeBank } from '../../../src/rom/DataBanks'
import { CORPUS, VANILLA, hasRom, hasRoms, romPath } from '../support/corpus'

const THRESHOLD_MS = 300

describe.skipIf(!hasRom(VANILLA))('vanilla', () => {
  it('records $0D for the layer 1 object code bank', () => {
    expect(locateObjectCodeBank(RomFile.load(romPath(VANILLA)))).toEqual({ bank: 0x0d })
  })
})

describe.skipIf(!hasRoms())('scan time over the corpus', () => {
  it('stays under the threshold on every ROM; prints median and max', () => {
    const times: number[] = []
    const found: Record<string, number> = {}
    for (const name of CORPUS) {
      const rom = RomFile.load(romPath(name)) // the load is not the scan: it is timed apart
      const t0 = performance.now()
      const r = locateObjectCodeBank(rom)
      times.push(performance.now() - t0)
      const key = 'bank' in r ? '$' + r.bank.toString(16).toUpperCase() : 'notFound'
      found[key] = (found[key] ?? 0) + 1
    }
    times.sort((a, b) => a - b)
    const median = times[Math.floor(times.length / 2)]
    const max = times[times.length - 1]
    process.stderr.write(
      `data-bank scan: ${times.length} ROMs, median ${median.toFixed(3)} ms, max ${max.toFixed(3)} ms, results ${JSON.stringify(found)}
`,
    )
    expect(times.length).toBe(CORPUS.length)
    expect(max).toBeLessThan(THRESHOLD_MS)
  })
})
