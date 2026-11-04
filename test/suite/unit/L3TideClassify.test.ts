import { describe, it, expect } from 'vitest'
import {
  classifyL3Routine,
  computeL3ScrollRange,
  L3_TILEMAP_COLS,
  L3_TILEMAP_ROWS,
} from '../../../src/rom/L3Loader'

// All synthetic, no ROM needed (#808). Settings bytes $01-$7F all run the tide
// X path (CODE_05C4EC, bank_05.asm:5624-5629); only $01 also moves Y.
const LEVEL_W = 1024

const rangeFor = (settingsByte: number) => {
  const tilemap = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
  tilemap[20 * L3_TILEMAP_COLS + 3] = 0x0123 // one gameplay-row cell
  return computeL3ScrollRange({
    tilemap,
    initialYPx: settingsByte === 1 ? 0x70 : 0x40,
    initialCameraYPx: 0,
    levelPixelW: LEVEL_W,
    settingsByte,
    tileset: 8,
  })
}

const classify = (b: number) => classifyL3Routine({ layer3Setting: 1, settingsByte: b, tileset: 0 })

const tideBytes = Array.from({ length: 0x7f }, (_, i) => i + 1) // $01..$7F

describe('classifyL3Routine tide bytes', () => {
  it('$01 is tide up/down at Y $70', () => {
    expect(classify(0x01)).toMatchObject({ kind: 'tide', isTideUpAndDown: true, initialYPx: 0x70 })
  })
  it.each(tideBytes.slice(1))('byte $%i (2..127) is a tide with static Y $40', b => {
    expect(classify(b)).toMatchObject({ kind: 'tide', isTideUpAndDown: false, initialYPx: 0x40 })
  })
  it('$00 and $80 stay fixed (no tide X path)', () => {
    expect(classify(0x00).kind).toBe('fixed')
    expect(classify(0x80).kind).toBe('fixed')
  })
})

describe('computeL3ScrollRange on a tide', () => {
  it.each(tideBytes)('byte %i: kind tide, span stays the full level width', b => {
    const r = rangeFor(b)
    expect(r.kind).toBe('tide')
    expect(r.xMin).toBe(0)
    expect(r.xMax).toBe(LEVEL_W)
    expect(r.yMax).toBeGreaterThan(r.yMin)
  })
  it('byte $01 has the Y sweep lines; $02-$7F have none (Y is static)', () => {
    expect(rangeFor(0x01).yHighTide).toBeDefined()
    for (const b of tideBytes.slice(1)) {
      expect(rangeFor(b).yHighTide).toBeUndefined()
      expect(rangeFor(b).yLowTide).toBeUndefined()
    }
  })
  it('$00 and $80 are not tides', () => {
    expect(rangeFor(0x80).kind).toBe('fixed')
  })
})
