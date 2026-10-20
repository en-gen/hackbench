/**
 * Pure parts of the refused-cell mark (#1005), kept free of React so a unit test can import them without a
 * Theia install: the tooltip text, the count label and the badge's place inside its tile's top-right quadrant.
 */
import type { MapRefusedCellDto } from '../common/project-protocol'

export const CELL = 16
export const BADGE_R = 3.5
/** The badge owns only the tile's top-right quadrant, 8 x 8 map px (owner ruling, T26). */
export const QUADRANT = CELL / 2
/** Gap between the circle and the quadrant's edges, so antialiasing never leaks into the rest of the tile. */
export const BADGE_INSET = 0.5

/** First line names the object; with 2+ reasons each is bulleted so the lines read as separate issues. */
export function refusedTooltip(
  c: Pick<MapRefusedCellDto, 'objectIndex' | 'objectType' | 'reasons'>,
): string {
  const bullet = c.reasons.length > 1 ? '- ' : ''
  return [`Object ${c.objectIndex} (${c.objectType})`, ...c.reasons.map(r => bullet + r)].join('\n')
}

/** Over 9 the number would not fit the circle, so it reads "9+". */
export const badgeLabel = (n: number): string => (n > 9 ? '9+' : String(n))

/**
 * Circle center, radius and font size in MAP pixels, with no outline. The circle sits wholly inside the
 * tile's top-right quadrant, BADGE_INSET from its edges, so it scales with zoom and never reaches the "!".
 * Digit sizes are what fit r 3.5: "9+" is wider than one digit, so it gets the smaller font.
 */
export function badgeGeometry(cellX: number, cellY: number, count: number) {
  return {
    cx: cellX * CELL + CELL - BADGE_INSET - BADGE_R,
    cy: cellY * CELL + BADGE_INSET + BADGE_R,
    r: BADGE_R,
    fontSize: count > 9 ? 4.5 : 6,
  }
}

/**
 * The "!" in map pixels (text-anchor middle, central baseline). Badged cells move it left and down, out of
 * the badge's quadrant, so the circle never sits on the glyph while the glyph stays inside the tile.
 */
export function bangGeometry(cellX: number, cellY: number, badged: boolean) {
  return badged
    ? { x: cellX * CELL + 5, y: cellY * CELL + 10, fontSize: 10 }
    : { x: cellX * CELL + CELL / 2, y: cellY * CELL + CELL / 2, fontSize: 12 }
}
