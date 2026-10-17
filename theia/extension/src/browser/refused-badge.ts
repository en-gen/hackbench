/**
 * Pure parts of the refused-cell mark (#1005), kept free of React so a unit test can import them without a
 * Theia install: the tooltip text, the count label and the badge's place inside its 16 px cell.
 */
import type { MapRefusedCellDto } from '../common/project-protocol'

export const CELL = 16
export const BADGE_R = 5
export const BADGE_STROKE = 1
/** Gap kept between the badge's outer edge and the cell's, so antialiasing never leaks into the neighbour. */
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
 * Circle centre, radius and font size in MAP pixels. Circle plus half its stroke sits BADGE_INSET inside
 * the cell's top-right corner on the right and top, so it never overhangs the dashed rect it marks.
 */
export function badgeGeometry(cellX: number, cellY: number, count: number) {
  const reach = BADGE_R + BADGE_STROKE / 2 + BADGE_INSET
  return {
    cx: cellX * CELL + CELL - reach,
    cy: cellY * CELL + reach,
    r: BADGE_R,
    fontSize: count > 9 ? 6 : 8,
  }
}

/**
 * The "!" in map pixels (text-anchor middle, central baseline). Badged cells shrink it into the lower left,
 * clear of the circle: a badge that big would otherwise sit on the glyph.
 */
export function bangGeometry(cellX: number, cellY: number, badged: boolean) {
  return badged
    ? { x: cellX * CELL + 3.2, y: cellY * CELL + 12.5, fontSize: 7 }
    : { x: cellX * CELL + CELL / 2, y: cellY * CELL + CELL / 2, fontSize: 12 }
}
