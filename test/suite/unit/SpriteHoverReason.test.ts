/** #1083: a marker's hover says which sprite it is and why it is a marker, in plain words. Synthetic rows, no ROM. */
import { describe, expect, it } from 'vitest'
import { spriteName } from '../../../theia/extension/src/browser/map-view-model'
import { notDrawnText } from '../../../theia/extension/src/browser/sprite-props'

const REASONS = [
  'extraBits', 'noParts', 'charsNotLoaded', 'noDescriptor', 'unrevealed', 'customHandler',
  'refused: INIT: id $e6 is past the 201-entry pointer table', 'drew no tiles in 64 passes',
  'some-future-engine-code', undefined,
] // prettier-ignore
const row = (name: string, reason: string | undefined) => ({
  id: 0x9b,
  name,
  status: 'placeholder' as const,
  reason,
})

describe('the hover of a marker', () => {
  for (const reason of REASONS) {
    it(`names the sprite and gives plain words for ${reason ?? 'no reason'}`, () => {
      expect(spriteName(row('Hammer Brother', reason))).toBe(
        `Hammer Brother (sprite $9B): ${notDrawnText(reason)}`,
      )
      const nameless = spriteName(row('', reason))
      expect(nameless).toBe(`Sprite $9B: ${notDrawnText(reason)}`)
      expect(nameless).not.toMatch(/OAM|passes|refused:|extraBits|noParts|INIT/)
    })
  }

  it('keeps the name alone for a drawn sprite and the reveal text for a revealed one', () => {
    expect(spriteName({ id: 1, name: 'Koopa', status: 'drawn' })).toBe('Koopa')
    expect(spriteName({ id: 1, name: '', status: 'drawn' })).toBeUndefined()
    const revealed = { id: 1, name: 'Koopa', status: 'placeholder' as const, reason: 'unrevealed' }
    expect(spriteName({ ...revealed, reveal: 'a touch' })).toBe('Koopa: a touch')
  })
})
