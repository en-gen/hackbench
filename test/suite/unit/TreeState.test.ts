/**
 * What an explorer keeps across a per-edit rebuild (#576). Synthetic keys:
 * a kept row survives in its saved order, a vanished one is dropped and never
 * replaced by another.
 */
import { describe, it, expect } from 'vitest'
import { surviving } from '../../../theia/extension/src/browser/tree-state'

describe('surviving', () => {
  it('keeps saved keys the rebuilt tree still has, in saved order', () => {
    expect(surviving(['c', 'a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b'])
  })

  it('drops a vanished key and does not substitute a neighbour', () => {
    expect(surviving(['gone'], ['a', 'b'])).toEqual([])
    expect(surviving(['a', 'gone', 'b'], ['b', 'a'])).toEqual(['a', 'b'])
  })

  it('an empty saved state stays empty however much the tree holds', () => {
    expect(surviving([], ['a', 'b'])).toEqual([])
  })

  it('accepts a Set and numeric slots, as the Maps explorer keeps them', () => {
    expect(surviving(new Set([0x22, 0x99]), [0x22, 0x23])).toEqual([0x22])
  })
})
