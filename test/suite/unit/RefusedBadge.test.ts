/**
 * The refused-cell tooltip and count badge (#1005), pure parts only: no React, no Theia, no ROM.
 */
import { describe, it, expect } from 'vitest'
import {
  BADGE_STROKE,
  CELL,
  badgeGeometry,
  badgeLabel,
  refusedTooltip,
} from '../../../theia/extension/src/browser/refused-badge'

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
  it('the circle and its whole stroke lie inside the 16 px cell, for every cell and count size', () => {
    for (let x = 0; x < 100; x += 7)
      for (let y = 0; y < 60; y += 5)
        for (const n of [2, 9, 10]) {
          const g = badgeGeometry(x, y, n)
          const ext = g.r + BADGE_STROKE / 2
          expect(g.cx - ext).toBeGreaterThanOrEqual(x * CELL)
          expect(g.cx + ext).toBeLessThanOrEqual(x * CELL + CELL)
          expect(g.cy - ext).toBeGreaterThanOrEqual(y * CELL)
          expect(g.cy + ext).toBeLessThanOrEqual(y * CELL + CELL)
        }
  })

  it('sits in the top-right quadrant, clear of the bottom-left "!"', () => {
    const g = badgeGeometry(2, 3, 2)
    expect(g.cx).toBeGreaterThan(2 * CELL + CELL / 2)
    expect(g.cy).toBeLessThan(3 * CELL + CELL / 2)
  })
})
