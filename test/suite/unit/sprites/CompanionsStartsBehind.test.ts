/**
 * #840: `startsBehind` (D156, line-guided "never appears in play") reads what a spawn DRAWS, companions included. Run on
 * a synthetic cart (no ROM) with non-line-guided ids, since the function only runs the sprite and measures its pieces:
 * id 85 draws only through a companion, id 86 draws its own piece and a companion 96 px to its right, id 80 draws both
 * in one place. The cart's loader window is bytes built here and named by a digest of their own (`RunOptions.loader`).
 */
import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../../src/rom/Fingerprint'
import { startsBehind } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const TABLES = 0x02a7f6
const word = (v: number) => [v & 255, 0, (v >> 8) & 255]
const X = 0x1090
/** A left window whose camera lies past the map's end, so only the scroll-right spawn is run (an 8-bit OAM X wraps a piece 256 px away back into view). */
const FAR = -0x2000

/** startsBehind for `id` placed at X with the loader window `left` (scrolling left/up) and `right` (right/down). */
function behind(id: number, left: number, right: number): boolean | undefined {
  const rom = buildSyntheticRom()
  const [l, r] = [word(left), word(right)]
  rom.writeAt(TABLES, [l[0]!, 0, r[0]!, l[2]!, 0, r[2]!])
  const loader = { at: TABLES, len: 6, sha: fingerprint(rom.readAt(TABLES, 6))! }
  const seed = withSeed({ slot: 3, sprite: { x: X, y: X }, level: { screenMode: 0, screens: 32 } }, SPRITE_SEED) // prettier-ignore
  return startsBehind(rom, id, seed, { loader }, { x: X, y: X })
}

describe('startsBehind counts companions', () => {
  it('a spawner that draws only through its companion is seen: it is not "never appears" (the find)', () => {
    // Scrolling right it stands at +$20, in view.
    expect(behind(85, FAR, 0x20)).toBe(false)
  })

  it("a companion's extent decides: own piece behind the scroll, companion in view (the extent)", () => {
    // Scrolling right the own piece is at -$40 (behind), the companion 96 px to its right at +$20 (in view).
    expect(behind(86, FAR, -0x40)).toBe(false)
  })

  it('control: own piece and companion in one place, both behind the scroll: never appears', () => {
    expect(behind(80, FAR, -0x40)).toBe(true)
  })
})
