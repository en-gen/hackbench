/**
 * Pins the Foreground data gate's committed roster (en-gen/hackbench#205):
 * 143 maps, no duplicates, disjoint from the 18 named empty-Layer-1 maps,
 * and together they make the 161 `layers_v5` maps with viewer data. Needs
 * no ROM and no capture on disk - this is a property of the committed
 * lists themselves, not of anything on this machine.
 */
import { describe, it, expect } from 'vitest'
import { EMPTY_FOREGROUND_MAPS, FG_GATE_MAPS } from '../../../tools/scripts/fgGateMaps'

describe('FG_GATE_MAPS / EMPTY_FOREGROUND_MAPS', () => {
  it('has exactly 143 entries, no duplicates', () => {
    expect(FG_GATE_MAPS.length).toBe(143)
    expect(new Set(FG_GATE_MAPS).size).toBe(143)
  })

  it('has exactly 18 empty-Layer-1 maps, no duplicates', () => {
    expect(EMPTY_FOREGROUND_MAPS.length).toBe(18)
    expect(new Set(EMPTY_FOREGROUND_MAPS).size).toBe(18)
  })

  it('is disjoint from the empty-Layer-1 maps', () => {
    const empty = new Set(EMPTY_FOREGROUND_MAPS)
    expect(FG_GATE_MAPS.filter(id => empty.has(id))).toEqual([])
  })

  it('together with the empty maps makes exactly 161 (the layers_v5 capture count)', () => {
    expect(new Set([...FG_GATE_MAPS, ...EMPTY_FOREGROUND_MAPS]).size).toBe(161)
  })
})
