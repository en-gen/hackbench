import { describe, it, expect } from 'vitest'
import { CONTROLLER_SVG } from '../../../theia/extension/src/browser/controller-art'
import {
  DEFAULT_ASSIGNMENTS,
  assignKeyboard,
  assignPad,
  localeRegion,
  parseControllerSettings,
  resolveRegion,
  resolveScheme,
  schemeForRegion,
  SCHEME_COLORS,
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

describe('resolveRegion: OS country, then languages, then unknown', () => {
  it('the OS country wins over the languages', () => {
    expect(resolveRegion('US', ['ja-JP'])).toBe('US')
  })
  it('an empty or missing country falls back to the languages', () => {
    expect(resolveRegion('', ['en-CA'])).toBe('CA')
    expect(resolveRegion(undefined, ['es-MX'])).toBe('MX')
  })
  it('with neither it is unknown, which draws PAL', () => {
    expect(resolveRegion('', ['en'])).toBeUndefined()
    expect(schemeForRegion(resolveRegion(undefined, []))).toBe('pal')
  })
  it('the full chain: JP country with US language is PAL; empty country with US language is NA', () => {
    expect(schemeForRegion(resolveRegion('JP', ['en-US']))).toBe('pal')
    expect(schemeForRegion(resolveRegion('', ['en-US']))).toBe('na')
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

describe('scheme colors', () => {
  const artFallbacks = Object.fromEntries(
    [...CONTROLLER_SVG.matchAll(/var\((--hb-pad-[a-z0-9-]+),(#[0-9a-f]{6})\)/g)].map(m => [
      m[1],
      m[2],
    ]),
  )

  it('PAL is exactly the source art colors, for every property both define', () => {
    expect(SCHEME_COLORS.pal).toEqual(artFallbacks)
  })

  it('both schemes set the same properties', () => {
    expect(Object.keys(SCHEME_COLORS.na).sort()).toEqual(Object.keys(SCHEME_COLORS.pal).sort())
  })

  it.each([
    ['--hb-pad-track', '#b9b9be', '#f4f4f1'],
    ['--hb-pad-track-stroke', '#c4c4c9', '#fdfdfa'],
    ['--hb-pad-dish-a', '#bdbdc2', '#dcdcdc'],
    ['--hb-pad-dish-b', '#c9c9ce', '#eeeee9'],
    ['--hb-pad-a', '#4e3a86', '#ff4856'],
    ['--hb-pad-b', '#4e3a86', '#ffbb58'],
    ['--hb-pad-x', '#b4a7d8', '#0075fa'],
    ['--hb-pad-y-1', '#a99bd0', '#00dea5'],
    ['--hb-pad-face', '#7a7a82', '#777f82'],
  ])('%s is %s North American and %s PAL', (name, na, pal) => {
    expect(SCHEME_COLORS.na[name]).toBe(na)
    expect(SCHEME_COLORS.pal[name]).toBe(pal)
  })
})

describe('parseControllerSettings: exclusivity and bounds', () => {
  it('a contested keyboard and pad stay with the first player', () => {
    const p = parseControllerSettings({
      players: [
        { keyboard: true, pad: 0 },
        { keyboard: true, pad: 0 },
      ],
    })
    expect(p.players).toEqual([
      { keyboard: true, pad: 0 },
      { keyboard: false, pad: undefined },
    ])
  })

  it('keeps pad 3 and drops pad 4 (literals, not the constant)', () => {
    const p = parseControllerSettings({
      players: [
        { keyboard: false, pad: 3 },
        { keyboard: false, pad: 4 },
      ],
    })
    expect(p.players.map(a => a.pad)).toEqual([3, undefined])
  })

  it('needs exactly two players', () => {
    for (const n of [0, 1, 3]) {
      const players = Array.from({ length: n }, () => ({ keyboard: false, pad: 2 }))
      expect(parseControllerSettings({ players }).players).toEqual(DEFAULT_ASSIGNMENTS)
    }
  })
})

describe('assignKeyboard off', () => {
  it('turning it off for one player leaves the other as it was', () => {
    const both = [
      { keyboard: true, pad: undefined },
      { keyboard: true, pad: undefined },
    ]
    expect(assignKeyboard(both, 0, false).map(a => a.keyboard)).toEqual([false, true])
  })
})
