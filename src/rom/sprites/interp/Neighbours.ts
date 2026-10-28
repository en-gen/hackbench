/**
 * Neighbours.ts -- which of a map's other list sprites a run puts in the other slots when the sprite's own code
 * scans the slot tables (#841; $9C looks for a $9B, bank_02.asm:12118-12129). Derived from the list, not traced.
 */
import type { LevelSprite } from '../../LevelParser'
import type { SpriteSeed } from './SpriteSeed'

/** The scan covers slots 0-9; the sprite under test takes one of them. */
const MAX_NEIGHBOURS = 10

/**
 * Whether list id `id` loads into a slot: ids to $C8, and the status-9 shells $DA-$DD and $DF (ShellSprites.ts).
 * Shooters and generators ($C9-$D9) set no slot (bank_02.asm:5336-5367); $DE and $E0 fill several slots with another
 * id and are left out as a scope choice; $E1 and up are cluster sprites.
 */
function isSlotSprite(id: number): boolean {
  return id <= 0xc8 || (id >= 0xda && id <= 0xdd) || id === 0xdf
}

/**
 * Entries of `list` on the sprite's screen or either side of it, nearest first, up to the free slots; not itself.
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
    .map(e => ({ id: e.spriteId, ...px(e), index: e.index }))
    .sort(
      (a, b) =>
        Math.abs(a.x - at.x) + Math.abs(a.y - at.y) - (Math.abs(b.x - at.x) + Math.abs(b.y - at.y)),
    ) // prettier-ignore
    .slice(0, MAX_NEIGHBOURS - 1)
}
