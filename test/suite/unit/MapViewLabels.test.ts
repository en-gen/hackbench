/** The map tab's layer wording (#562): pure, so it runs without a Theia shell. */
import { describe, it, expect } from 'vitest'
import { romMissingMessage } from '../../../theia/extension/src/browser/map-view-messages'
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

describe('missing base ROM message (#786)', () => {
  it('names the ROM and the next step, with the real menu label', () => {
    const m = romMissingMessage('X')
    expect(m).toContain('The base ROM X is not on this machine.')
    expect(m).toContain('File > Project Properties...')
    expect(m).toContain('locate it again')
  })
})
