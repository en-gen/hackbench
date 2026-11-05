/**
 * The gutter after a map's far end (owner ruling #1228, replacing D48 part 2 and R24): one 256 px
 * screen of canvas beyond the map and beyond any off-map content, on the scroll axis, at the far end
 * ONLY (right of a horizontal map, bottom of a vertical one), where an "add screen" control will sit.
 * There is none before position 0: growing that way would move (0,0) and shift every tile. Kept in the
 * core so every consumer reads one number.
 */

/** Gutter width at a map's far end, in map pixels: one screen. */
export const GUTTER_PX = 256

/** The most screens a map can have: the header's screen-count field is 5 bits (`bank_05.asm:527-528`). */
export const MAX_SCREENS = 32

/**
 * The far-end gutter for a map of `screenCount` screens, in map pixels: none at the 32-screen ceiling
 * (the map cannot grow, so there is nothing to add into), otherwise one screen.
 */
export const farGutter = (screenCount: number): number =>
  screenCount >= MAX_SCREENS ? 0 : GUTTER_PX
