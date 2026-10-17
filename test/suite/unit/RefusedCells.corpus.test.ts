/**
 * The vanilla ROM draws every Layer 1 object it holds (#816): a refused-cell
 * mark on a stock map would be a regression. Skipped without the corpus.
 */
import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildL1Inputs } from '../../../src/rom/model/L1Model'
import { hasRom, romPath, VANILLA } from '../support/corpus'

const FLAGS = { yellow: false, green: false, red: false, blue: false }

describe.skipIf(!hasRom(VANILLA))('vanilla refusals (#816)', () => {
  it('no stock slot refuses an object', () => {
    const rom = SmwRom.open(romPath(VANILLA))
    const refused: string[] = []
    let swept = 0
    for (let slot = 0; slot < 0x200; slot++) {
      if (!rom.getLevelRawData(slot)) continue
      const r = buildL1Inputs(rom, slot, FLAGS)
      // A boss arena or an unreadable slot has no L1 to refuse from.
      if (!r.ok) continue
      swept++
      for (const c of r.inputs.refusedCells ?? [])
        refused.push(`${slot.toString(16)}:${c.objectIndex}`)
      expect(r.inputs.refusals.length, `slot ${slot.toString(16)}`).toBe(r.inputs.refusedCells?.length) // prettier-ignore
    }
    console.log(`swept ${swept} slots, ${refused.length} refusals`)
    expect(swept).toBeGreaterThan(300)
    expect(refused).toEqual([])
  }, 120_000)
})
