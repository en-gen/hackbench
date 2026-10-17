/**
 * Pure parts of the refused-cell mark (#1005), kept free of React so a unit test can import them without a
 * Theia install: the tooltip text, the count label and the badge's place inside its 16 px cell.
 */
import type { MapRefusedCellDto } from '../common/project-protocol'

export const CELL = 16
export const BADGE_R = 4
export const BADGE_STROKE = 1

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
 * Circle centre, radius and font size in MAP pixels. The circle plus half its stroke sits 0.5 px inside the
 * cell's top-right corner on every side, so it never overhangs the dashed rect it marks.
 */
export function badgeGeometry(cellX: number, cellY: number, count: number) {
  const reach = BADGE_R + BADGE_STROKE / 2
  return {
    cx: cellX * CELL + CELL - reach - 0.5,
    cy: cellY * CELL + reach + 0.5,
    r: BADGE_R,
    fontSize: count > 9 ? 4.5 : 6.5,
  }
}
