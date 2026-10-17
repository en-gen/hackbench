/**
 * The refused-cell tooltip and count badge (#1005), pure parts only: no React, no Theia, no ROM.
 */
import { describe, it, expect } from 'vitest'
import {
  BADGE_INSET,
  BADGE_STROKE,
  CELL,
  badgeGeometry,
  badgeLabel,
  bangGeometry,
  refusedTooltip,
} from '../../../theia/extension/src/browser/refused-badge'
import { gateReason } from '../../../src/rom/model/RefusedCells'
import { formatRefusedLine } from '../../../src/rom/objectHandlers/interpretedGate'

describe('refusedTooltip (#1005)', () => {
  it('one reason is the heading plus that one line', () => {
    expect(refusedTooltip({ objectIndex: 3, objectType: 'type 9', reasons: ['A.'] })).toBe(
      'Object 3 (type 9)\nA.',
    )
  })

  it('every reason appears, one per line, after the heading', () => {
    const reasons = ['first.', 'second.', 'third.']
    const lines = refusedTooltip({ objectIndex: 1, objectType: 'extended type 5', reasons }).split('\n') // prettier-ignore
    expect(lines[0]).toBe('Object 1 (extended type 5)')
    expect(lines.slice(1)).toEqual(reasons.map(r => `- ${r}`))
  })
})

describe('badgeLabel', () => {
  it('shows the number up to 9 and 9+ beyond', () => {
    expect([1, 2, 9, 10, 40].map(badgeLabel)).toEqual(['1', '2', '9', '9+', '9+'])
  })
})

describe('badgeGeometry (#1005)', () => {
  const cells: [number, number][] = []
  for (let x = 0; x < 100; x++) for (let y = 0; y < 60; y++) cells.push([x, y])

  it('circle plus whole stroke sits exactly BADGE_INSET inside the cell top and right, for cells 0..99 x 0..59, counts 2, 9, 10', () => {
    for (const [x, y] of cells)
      for (const n of [2, 9, 10]) {
        const g = badgeGeometry(x, y, n)
        const ext = g.r + BADGE_STROKE / 2
        expect(g.cx + ext).toBeCloseTo(x * CELL + CELL - BADGE_INSET, 9)
        expect(g.cy - ext).toBeCloseTo(y * CELL + BADGE_INSET, 9)
        expect(g.cx - ext).toBeGreaterThan(x * CELL)
        expect(g.cy + ext).toBeLessThan(y * CELL + CELL)
      }
  })

  it('the "!" box, taken generously as 0.6 x 0.9 of its font size, stays clear of the circle', () => {
    for (const [x, y] of [
      [0, 0],
      [7, 3],
      [99, 59],
    ]) {
      const g = badgeGeometry(x, y, 2)
      const b = bangGeometry(x, y, true)
      const hw = 0.3 * b.fontSize
      const hh = 0.45 * b.fontSize
      const nx = Math.max(b.x - hw, Math.min(g.cx, b.x + hw))
      const ny = Math.max(b.y - hh, Math.min(g.cy, b.y + hh))
      expect(Math.hypot(nx - g.cx, ny - g.cy)).toBeGreaterThan(g.r + BADGE_STROKE / 2)
      expect(b.x - hw).toBeGreaterThanOrEqual(x * CELL)
      expect(b.y + hh).toBeLessThanOrEqual(y * CELL + CELL)
    }
  })

  it('an unbadged cell keeps the centred 12 px "!"', () => {
    expect(bangGeometry(2, 3, false)).toEqual({ x: 2 * CELL + 8, y: 3 * CELL + 8, fontSize: 12 })
  })
})

describe('gateReason wording (#1005)', () => {
  const formatJsr = 'Handler $0DB49E refused: the JSR at $0DB4B1 calls $0D8000, not $0DA000 as the port assumes, so the object is not drawn.' // prettier-ignore
  it('leads with words and ends in hex, per kind of refusal', () => {
    const call = formatRefusedLine(0x0db49e, 0x0db4b1, 0x20, 0x00)
    expect(gateReason(call)).toBe(
      'Its drawing code was changed where HackBench expects a call (byte $0DB4B1 is $00).',
    )
    expect(gateReason(formatRefusedLine(0x0db49e, 0x0db4b1, 0x4c, 0x20))).toContain(
      'expects a jump',
    )
    expect(gateReason(formatRefusedLine(0x0db49e, 0x0db4b1, 0x20, null))).toContain(
      'there is no byte at $0DB4B1',
    )
    expect(gateReason('Handler $0DB49E refused: the required operand span at $0DB4B2 is outside the ROM, so the object is not drawn.')).toBe('Its drawing code runs past the end of the ROM (at $0DB4B2).') // prettier-ignore
    expect(gateReason('Handler $0DB49E refused: the operand at $0DB4B2 is $05, not the $04 the port assumes, so the object is not drawn.')).toContain('a value HackBench relies on (byte $0DB4B2 is $05)') // prettier-ignore
    expect(gateReason(formatJsr)).toBe('Its drawing code calls somewhere HackBench does not expect (call at $0DB4B1).') // prettier-ignore
    expect(gateReason('Handler $0DB49E refused: odd, so the object is not drawn.')).toContain(
      '(odd)',
    )
  })
})
