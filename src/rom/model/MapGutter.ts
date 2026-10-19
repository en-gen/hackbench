/**
 * The gutter at each long end of a map (owner rulings D48 part 2 and D145, #1004): half a 256 px
 * screen of canvas beyond the map and beyond any off-map content, on the scroll axis, where an
 * "add screen" control will sit. Kept in the core so every consumer reads one number.
 */

/** Gutter width at each long end of a map, in map pixels. */
export const GUTTER_PX = 128
