/**
 * The fixed gutter beside a horizontal map (owner ruling D48 part 2, #1004): half a 256 px
 * screen on the left and right, always, whatever the map holds. Kept in the core so the node
 * side (which places refused-object marks) and the Theia view agree on one number. Vertical
 * maps and the space above or below a horizontal map have no gutter (pending D145).
 */

/** Gutter width on each end of a horizontal map, in map pixels. */
export const GUTTER_PX = 128

/** The gutter in 16 px map tiles. */
export const GUTTER_TILES = GUTTER_PX / 16
