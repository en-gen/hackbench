/**
 * The probe's air shortcut is exact (en-gen/hackbench#435): a run that never read the probed cell's bytes is the
 * same for every tile, so a tile's sweep takes those positions from a level of air and runs only the rest. This
 * runs every Map16 id (all 512) both ways on the tilesets of maps $105, $10A and $111 and demands identical
 * results. Slow by design (the unshortcut half is the old probe), so each tileset is its own case.
 *
 * Evidence scope: vanilla US ROM, tilesets 7, 3 and 1, one machine. It proves the equivalence there, not for a
 * hack whose block routine reads other state before the cell.
 *
 * It can fail: `shortcutMismatches` is also run on an air table that lies about touching (a planted defect in the
 * shortcut), and must name tiles.
 */
import { describe, it, expect } from 'vitest'
import {
  calibrate,
  measureTile,
  probeAir,
  Probe,
  type AirRuns,
} from '../../../src/rom/collision/TileProbe'
import { freshRom, hasRom, VANILLA } from '../support/corpus'

/** The ids whose sweep differs with and without `air`. */
function shortcutMismatches(p: Probe, ids: readonly number[], air: AirRuns): number[] {
  const cal = calibrate(p)
  return ids.filter(
    id => JSON.stringify(measureTile(p, id, cal, air)) !== JSON.stringify(measureTile(p, id, cal)),
  )
}
const ALL = Array.from({ length: 0x200 }, (_, i) => i)

describe.skipIf(!hasRom(VANILLA))('the air shortcut equals the full sweep (vanilla ROM)', () => {
  for (const [level, tileset] of [
    [0x105, 7],
    [0x10a, 3],
    [0x111, 1],
  ] as const) {
    it(`all 512 ids on tileset ${tileset} (map $${level.toString(16)})`, () => {
      const p = new Probe(freshRom(), level)
      expect(p.tileset).toBe(tileset)
      const air = probeAir(p)
      expect([...air.values()].filter(r => !r.touched).length).toBeGreaterThan(air.size / 4) // it skips real work
      expect(shortcutMismatches(p, ALL, air)).toEqual([])
    }, 400_000)
  }

  it('goes red when the shortcut skips positions that touch the cell', () => {
    const p = new Probe(freshRom(), 0x105)
    const air = probeAir(p)
    // Planted defect: claim every second touching position never read the cell.
    let n = 0
    const lie: AirRuns = new Map(
      [...air].map(([k, r]) => [k, r.touched && n++ % 2 === 0 ? { ...r, touched: false } : r]),
    )
    expect(shortcutMismatches(p, [0x130, 0x1aa, 0x1c8, 0x159, 0x100], lie).length).toBeGreaterThan(
      0,
    )
    expect(shortcutMismatches(p, [0x130, 0x1aa, 0x1c8, 0x159, 0x100], air)).toEqual([])
  }, 120_000)
})
