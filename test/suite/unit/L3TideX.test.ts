import { describe, it, expect } from 'vitest'
import { tideBgX } from '../../../src/rom/L3TideX'
import {
  classifyL3Routine,
  computeL3ScrollRange,
  L3_TILEMAP_COLS,
  L3_TILEMAP_ROWS,
} from '../../../src/rom/L3Loader'

// All synthetic: no ROM needed (#808).
describe('tideBgX (bank_05.asm:5624-5629)', () => {
  it('adds one per frame with a still camera', () => {
    expect(tideBgX(0, 0, 0)).toBe(0x100)
    expect(tideBgX(0, 1, 0)).toBe(0x101)
    expect(tideBgX(0, 40, 0)).toBe(0x128)
  })
  it('adds a positive camera step on top', () => {
    expect(tideBgX(0, 10, 3)).toBe(0x10d)
  })
  it('subtracts a negative camera step', () => {
    expect(tideBgX(0x20, 5, -9)).toBe(0x11c)
    expect(tideBgX(0, 0, -1)).toBe(0x1ff)
  })
  it('wraps the low byte at 256 and keeps the high byte at 1', () => {
    expect(tideBgX(0xff, 1, 0)).toBe(0x100)
    expect(tideBgX(0, 256, 0)).toBe(0x100)
    expect(tideBgX(0, 502, 0)).toBe(0x1f6)
    for (let n = 0; n < 700; n += 7) expect(tideBgX(5, n, n % 3) >> 8).toBe(1)
  })
})

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
    it(`byte $${byte.toString(16).padStart(2, '0')}: kind tide with the $100-$1FF phase`, () => {
      const r = rangeFor(byte)
      expect(r.kind).toBe('tide')
      expect(r.xPhase).toEqual({ min: 0x100, max: 0x1ff })
    })
  }
  it('byte $01 keeps the Y sweep lines; $02 has none (Y is static)', () => {
    expect(rangeFor(0x01).yHighTide).toBeDefined()
    expect(rangeFor(0x02).yHighTide).toBeUndefined()
    expect(rangeFor(0x02).yMax).toBeGreaterThan(rangeFor(0x02).yMin)
  })
  it('a non-tide range carries no phase', () => {
    expect(rangeFor(0x80).xPhase).toBeUndefined()
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
