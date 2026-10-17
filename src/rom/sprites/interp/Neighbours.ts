/**
 * Neighbours.ts -- which of a level's other list sprites a run puts in the other slots when the
 * sprite's own code scans the slot tables (#841; $9C looks for a $9B, bank_02.asm:12118-12129).
 * A derivation from the list, not a trace of the loader: the real slots depend on load order and on
 * which sprites were loaded when, which this does not model.
 */
import type { LevelSprite } from '../../LevelParser'
import type { SpriteSeed } from './SpriteSeed'

/** The scan covers slots 0-9; the sprite under test takes one of them. */
const MAX_NEIGHBOURS = 10

/**
 * Entries of `list` on the sprite's screen or the screen either side of it, nearest first, up to
 * the free slots. Ids above $C8 are left out, as is the sprite itself: $C9+ shooters and $CB-$D9 generators
 * set a shooter or generator, not a slot (bank_02.asm:5336-5346, 5364-5367). $DA-$DD and $DF do load as
 * status-9 slot sprites (5348-5362); leaving them out is a scope choice, not a claim that they are not slots.
 */
export function neighboursOf(
  list: readonly LevelSprite[],
  s: LevelSprite,
  px: (e: LevelSprite) => { x: number; y: number },
): NonNullable<SpriteSeed['neighbours']> {
  const at = px(s)
  return list
    .filter(e => e.index !== s.index && e.spriteId <= 0xc8 && Math.abs(e.screen - s.screen) <= 1)
    .map(e => ({ id: e.spriteId, ...px(e) }))
    .sort(
      (a, b) =>
        Math.abs(a.x - at.x) + Math.abs(a.y - at.y) - (Math.abs(b.x - at.x) + Math.abs(b.y - at.y)),
    ) // prettier-ignore
    .slice(0, MAX_NEIGHBOURS - 1)
}
