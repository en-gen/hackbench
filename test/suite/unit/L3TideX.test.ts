import { describe, it, expect } from 'vitest'
import {
  classifyL3Routine,
  computeL3ScrollRange,
  L3_TILEMAP_COLS,
  L3_TILEMAP_ROWS,
} from '../../../src/rom/L3Loader'

// All synthetic: no ROM needed (#808).
const rangeFor = (settingsByte: number) => {
  const tilemap = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
  tilemap[20 * L3_TILEMAP_COLS + 3] = 0x0123 // one gameplay-row cell
  return computeL3ScrollRange({
    tilemap,
    initialYPx: settingsByte === 1 ? 0x70 : 0x40,
    initialCameraYPx: 0,
    levelPixelW: 1024,
    settingsByte,
    tileset: 8,
  })
}

describe('computeL3ScrollRange on a tide states the X rule, not 1:1', () => {
  for (const byte of [0x01, 0x02, 0x7f]) {
    it(`byte $${byte.toString(16).padStart(2, '0')}: kind tide`, () => {
      const r = rangeFor(byte)
      expect(r.kind).toBe('tide')
    })
  }
  it('byte $01 keeps the Y sweep lines; $02 has none (Y is static)', () => {
    expect(rangeFor(0x01).yHighTide).toBeDefined()
    expect(rangeFor(0x02).yHighTide).toBeUndefined()
    expect(rangeFor(0x02).yMax).toBeGreaterThan(rangeFor(0x02).yMin)
  })
})

describe('classifyL3Routine tide bytes', () => {
  const kind = (b: number) => classifyL3Routine({ layer3Setting: 1, settingsByte: b, tileset: 0 })
  it('$01 is tide up/down; $02 and $7F are tide with static Y', () => {
    expect(kind(0x01)).toMatchObject({ kind: 'tide', isTideUpAndDown: true, initialYPx: 0x70 })
    for (const b of [0x02, 0x7f]) {
      expect(kind(b)).toMatchObject({ kind: 'tide', isTideUpAndDown: false, initialYPx: 0x40 })
    }
  })
  it('$00 and $80 stay fixed (no tide X path)', () => {
    expect(kind(0x00).kind).toBe('fixed')
    expect(kind(0x80).kind).toBe('fixed')
  })
})
