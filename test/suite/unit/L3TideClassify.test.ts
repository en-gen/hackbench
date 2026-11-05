import { describe, it, expect } from 'vitest'
import {
  classifyL3Routine,
  computeL3ScrollRange,
  L3_TILEMAP_COLS,
  L3_TILEMAP_ROWS,
  L3_TIDE_YPOS_MAX,
  L3_TIDE_YPOS_MIN,
} from '../../../src/rom/L3Loader'

// All synthetic, no ROM needed (#808). Settings bytes $01-$7F all run the tide
// X path (CODE_05C4EC, bank_05.asm:5624-5629); only $01 also moves Y.
const LEVEL_W = 1024

const CAM_Y = 192
const ROW = 20

/** One cell on gameplay row ROW; `initialYPx` is free so a hardcoded $40 cannot pass. */
const rangeFor = (settingsByte: number, initialYPx = 0x40, cam = CAM_Y) => {
  const tilemap = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
  tilemap[ROW * L3_TILEMAP_COLS + 3] = 0x0123
  return computeL3ScrollRange({
    tilemap,
    initialYPx,
    initialCameraYPx: cam,
    levelPixelW: LEVEL_W,
    settingsByte,
    tileset: 8,
  })
}

/** The routine summary for settings byte `b` on tileset 0, as the editor classifies it. */
const classify = (b: number) => classifyL3Routine({ layer3Setting: 1, settingsByte: b, tileset: 0 })

const tideBytes = Array.from({ length: 0x7f }, (_, i) => i + 1) // $01..$7F
/** [hex label, byte] rows, so a case title reads as the byte the ROM holds. */
const rows = (bytes: number[]) => bytes.map(b => [b.toString(16).padStart(2, '0'), b] as const)

describe('classifyL3Routine tide bytes', () => {
  it('$01 is tide up/down at Y $70', () => {
    expect(classify(0x01)).toMatchObject({ kind: 'tide', isTideUpAndDown: true, initialYPx: 0x70 })
  })
  it.each(rows(tideBytes.slice(1)))('byte 0x%s is a tide with static Y $40', (_h, b) => {
    expect(classify(b)).toMatchObject({ kind: 'tide', isTideUpAndDown: false, initialYPx: 0x40 })
  })
  it('$00 and $80 stay fixed (no tide X path)', () => {
    expect(classify(0x00).kind).toBe('fixed')
    expect(classify(0x80).kind).toBe('fixed')
  })
})

describe('computeL3ScrollRange on a tide', () => {
  it.each(rows(tideBytes))('byte 0x%s: kind tide, span stays the full level width', (_h, b) => {
    const r = rangeFor(b)
    expect(r.kind).toBe('tide')
    expect(r.xMin).toBe(0)
    expect(r.xMax).toBe(LEVEL_W)
  })
  it.each(rows(tideBytes.slice(1)))(
    'byte 0x%s: static Y, exact bounds, no sweep lines',
    (_h, b) => {
      const initialYPx = 0x38 + (b % 5) // never the real $40 on every byte
      const r = rangeFor(b, initialYPx)
      expect(r.yMin).toBe(ROW * 8 - initialYPx + CAM_Y)
      expect(r.yMax).toBe((ROW + 1) * 8 - initialYPx + CAM_Y)
      expect(r.yHighTide).toBeUndefined()
      expect(r.yLowTide).toBeUndefined()
    },
  )
  it('byte $01 sweeps: the Y bounds come from the sweep limits, with lines', () => {
    const r = rangeFor(0x01, 0x70)
    expect(r.yHighTide).toBe(ROW * 8 - L3_TIDE_YPOS_MAX + CAM_Y)
    expect(r.yLowTide).toBe(ROW * 8 - L3_TIDE_YPOS_MIN + CAM_Y)
  })
  it('$00 and $80 are fixed, not tides, with the same static-Y arithmetic', () => {
    for (const b of [0x00, 0x80]) {
      const r = rangeFor(b, 0x44)
      expect(r.kind).toBe('fixed')
      expect(r.yMin).toBe(ROW * 8 - 0x44 + CAM_Y)
      expect(r.yMax).toBe((ROW + 1) * 8 - 0x44 + CAM_Y)
    }
  })
})
