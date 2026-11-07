/** #1083: a marker's hover says which sprite it is and why it is a marker, in plain words. Synthetic rows, no ROM. */
import { describe, expect, it } from 'vitest'
import { spriteName } from '../../../theia/extension/src/browser/map-view-model'

const REFUSED = "The app could not run this sprite's code."
const NO_TILES = 'Its code drew no tiles.'
/** Each reason the engine gives (or none), and the sentence the hover must carry: literals, not read from the code under test. */
const WORDS: [string | undefined, string][] = [
  [
    'extraBits',
    'It uses the extra-bits marker that custom sprites use, so vanilla art would be wrong.',
  ],
  ['noParts', NO_TILES],
  ['charsNotLoaded', 'Some of its graphics are not loaded on this map.'],
  ['noDescriptor', 'The app has no drawing rules for this sprite yet.'],
  ['unrevealed', 'It draws nothing at first, and the app could not tell what reveals it.'],
  [
    'customHandler',
    'This map runs different code for this sprite than the game does, so vanilla art would be wrong.',
  ],
  ['refused: INIT: id $e6 is past the 201-entry pointer table', REFUSED],
  ['drew no tiles in 64 passes', NO_TILES],
  ['some-future-engine-code', 'The app could not draw this sprite.'],
  [undefined, 'The app has no reason recorded for this.'],
]
const row = (name: string, reason: string | undefined) => ({
  id: 0x9b,
  name,
  status: 'placeholder' as const,
  reason,
})

describe('the hover of a marker', () => {
  for (const [reason, words] of WORDS) {
    it(`names the sprite and gives plain words for ${reason ?? 'no reason'}`, () => {
      expect(spriteName(row('Hammer Brother', reason))).toBe(
        `Hammer Brother (sprite $9B): ${words}`,
      )
      const nameless = spriteName(row('', reason))
      expect(nameless).toBe(`Sprite $9B: ${words}`)
      expect(nameless).not.toMatch(/OAM|passes|refused:|extraBits|noParts|INIT/)
    })
  }

  it('keeps the name alone for a drawn sprite and the reveal text for a revealed one', () => {
    expect(spriteName({ id: 1, name: 'Koopa', status: 'drawn' })).toBe('Koopa')
    expect(spriteName({ id: 1, name: '', status: 'drawn' })).toBeUndefined()
    expect(spriteName({ id: 1, name: 'Koopa', status: 'drawn', reveal: 'a touch' })).toBe(
      'Koopa: a touch',
    )
  })
})
