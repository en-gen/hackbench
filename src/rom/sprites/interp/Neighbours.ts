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
 * Whether the level loader leaves list id `id` in a slot. Ids to $C8 load as slot sprites. $C9-$CA shooters
 * and $CB-$D9 generators set a shooter or generator, not a slot (bank_02.asm:5336-5346, 5364-5367). $DA-$DD
 * and $DF load as status-9 slot sprites (5348-5362; ShellSprites.ts reads the mapping). $DE, $E0 and $E1+
 * run their own loaders (5312-5334, 5349-5358), no slot.
 */
function isSlotSprite(id: number): boolean {
  return id <= 0xc8 || (id >= 0xda && id <= 0xdd) || id === 0xdf
}

/**
 * Entries of `list` on the sprite's screen or the screen either side of it, nearest first, up to
 * the free slots. The sprite itself and ids the loader does not put in a slot are left out.
 */
export function neighboursOf(
  list: readonly LevelSprite[],
  s: LevelSprite,
  px: (e: LevelSprite) => { x: number; y: number },
): NonNullable<SpriteSeed['neighbours']> {
  const at = px(s)
  return list
    .filter(
      e => e.index !== s.index && isSlotSprite(e.spriteId) && Math.abs(e.screen - s.screen) <= 1,
    )
    .map(e => ({ id: e.spriteId, ...px(e) }))
    .sort(
      (a, b) =>
        Math.abs(a.x - at.x) + Math.abs(a.y - at.y) - (Math.abs(b.x - at.x) + Math.abs(b.y - at.y)),
    ) // prettier-ignore
    .slice(0, MAX_NEIGHBOURS - 1)
}
