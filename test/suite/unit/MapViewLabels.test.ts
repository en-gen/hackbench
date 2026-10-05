/** The map tab's layer wording (#562): pure, so it runs without a Theia shell. */
import { describe, it, expect } from 'vitest'
import { layer2Label } from '../../../theia/extension/src/browser/map-layer-labels'

describe('layer 2 role tooltip', () => {
  it('Foreground only when layer 2 is interactive', () => {
    expect(layer2Label({ layer2Interactive: true })).toBe('Layer 2 · Foreground')
    expect(layer2Label({ layer2Interactive: false })).toBe('Layer 2 · Background')
  })
  it('Background while the map is still loading', () => {
    expect(layer2Label(undefined)).toBe('Layer 2 · Background')
  })
})
