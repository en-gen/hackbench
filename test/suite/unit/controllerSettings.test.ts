import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ASSIGNMENTS,
  assignKeyboard,
  assignPad,
  localeRegion,
  parseControllerSettings,
  resolveScheme,
  schemeForRegion,
} from '../../../theia/extension/src/browser/controller-settings'

describe('region to controller scheme', () => {
  it.each([
    ['US', 'na'],
    ['CA', 'na'],
    ['MX', 'na'],
    ['JP', 'pal'],
    ['GB', 'pal'],
    ['', 'pal'],
    [undefined, 'pal'],
  ] as const)('%s -> %s', (region, scheme) => {
    expect(schemeForRegion(region)).toBe(scheme)
  })

  it('is case-insensitive', () => {
    expect(schemeForRegion('us')).toBe('na')
  })
})

describe('localeRegion', () => {
  it('takes the first language that names a region', () => {
    expect(localeRegion(['en', 'fr-CA', 'de-DE'])).toBe('CA')
  })
  it('is undefined for region-less or malformed tags', () => {
    expect(localeRegion(['en', 'fr'])).toBeUndefined()
    expect(localeRegion(['not a tag!!'])).toBeUndefined()
    expect(localeRegion([])).toBeUndefined()
  })
})

describe('resolveScheme: override beats the region', () => {
  it('auto follows the region', () => {
    expect(resolveScheme('auto', 'US')).toBe('na')
    expect(resolveScheme('auto', 'JP')).toBe('pal')
    expect(resolveScheme('auto', undefined)).toBe('pal')
  })
  it('an explicit choice ignores the region', () => {
    expect(resolveScheme('pal', 'US')).toBe('pal')
    expect(resolveScheme('na', 'JP')).toBe('na')
  })
})

describe('assignments', () => {
  it('default to P1 keyboard + pad 0 and P2 pad 1', () => {
    expect(DEFAULT_ASSIGNMENTS).toEqual([
      { keyboard: true, pad: 0 },
      { keyboard: false, pad: 1 },
    ])
  })

  it('the keyboard belongs to one player at a time', () => {
    const next = assignKeyboard(DEFAULT_ASSIGNMENTS, 1, true)
    expect(next.map(a => a.keyboard)).toEqual([false, true])
  })

  it('a pad belongs to one player at a time', () => {
    const next = assignPad(DEFAULT_ASSIGNMENTS, 1, 0)
    expect(next.map(a => a.pad)).toEqual([undefined, 0])
  })

  it('does not mutate its input', () => {
    assignPad(DEFAULT_ASSIGNMENTS, 1, 0)
    expect(DEFAULT_ASSIGNMENTS[0].pad).toBe(0)
  })
})

describe('parseControllerSettings', () => {
  it('falls back to defaults for anything unusable', () => {
    for (const raw of [undefined, null, 5, 'x', {}, { players: 'no' }, { players: [1, 2] }]) {
      expect(parseControllerSettings(raw)).toEqual({
        players: DEFAULT_ASSIGNMENTS,
        style: 'auto',
      })
    }
  })

  it('round-trips a saved value and rejects a bad style', () => {
    const saved = {
      players: [{ keyboard: false, pad: 2 }, { keyboard: true }],
      style: 'na',
    }
    expect(parseControllerSettings(saved)).toEqual({
      players: [
        { keyboard: false, pad: 2 },
        { keyboard: true, pad: undefined },
      ],
      style: 'na',
    })
    expect(parseControllerSettings({ ...saved, style: 'ntsc' }).style).toBe('auto')
  })

  it('drops a pad index that is not a small non-negative integer', () => {
    const p = parseControllerSettings({
      players: [
        { keyboard: true, pad: -1 },
        { keyboard: false, pad: 1.5 },
      ],
    })
    expect(p.players.map(a => a.pad)).toEqual([undefined, undefined])
  })
})
