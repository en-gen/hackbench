/**
 * The depth metric load-maps.spec.cjs asserts with. Proven here because the
 * spec cannot run in CI's unit pass, and its inline predecessor scored a flat
 * list of N roots as N-1.
 */
import { describe, it, expect } from 'vitest'
import { maxDepth } from '../../../theia/browser-app/test/tree-depth.cjs'

const leaf = { children: [] }

describe('maxDepth', () => {
  it('is 0 for a flat list, however many roots', () => {
    expect(maxDepth([])).toBe(0)
    expect(maxDepth([leaf, leaf, leaf, leaf])).toBe(0)
  })

  it('counts nesting below the roots', () => {
    expect(maxDepth([leaf, { children: [leaf] }])).toBe(1)
    expect(maxDepth([leaf, leaf, { children: [{ children: [leaf] }] }])).toBe(2)
  })
})
