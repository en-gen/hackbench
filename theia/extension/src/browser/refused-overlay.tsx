/**
 * Marks the Layer 1 objects the map could not draw (#816): one hatched cell
 * each, in MAP pixel coordinates so it follows the zoom by scaling, like the
 * collision overlay. Always shown when any exist (an undrawn object must never
 * look like empty space); nothing is rendered when there are none.
 *
 * Test hooks: `data-control="refused-overlay"`, and per cell
 * `data-control="refused-cell"` with `data-x`, `data-y` (map tiles) and
 * `data-object` (index). The reason is both the native tooltip (SVG <title>)
 * and the aria-label.
 */
import * as React from '@theia/core/shared/react'
import type { MapRefusedCellDto } from '../common/project-protocol'

const CELL = 16
/** Orange on a translucent fill reads on both themes and on any tile art. */
const WARN = '#ff9800'

export const refusedTooltip = (c: MapRefusedCellDto): string =>
  `Object ${c.objectIndex} (${c.objectType}): ${c.why}`

export function RefusedOverlay(props: {
  cells: readonly MapRefusedCellDto[]
  /** The whole strip, in map pixels. */
  width: number
  height: number
  zoom: number
  /** Distinguishes this tab's pattern id from another open map's. */
  owner: string
}): React.ReactElement | null {
  if (props.cells.length === 0) return null
  const hatch = `hb-refused-hatch-${props.owner.replace(/[^\w-]/g, '_')}`
  return (
    <svg
      className="hb-map-refused"
      data-control="refused-overlay"
      width={props.width * props.zoom}
      height={props.height * props.zoom}
      viewBox={`0 0 ${props.width} ${props.height}`}
    >
      <defs>
        <pattern
          id={hatch}
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="4" stroke={WARN} strokeWidth="1" />
        </pattern>
      </defs>
      {props.cells.map(c => (
        <g
          key={`${c.objectIndex}-${c.handler}`}
          data-control="refused-cell"
          data-x={c.x}
          data-y={c.y}
          data-object={c.objectIndex}
          aria-label={refusedTooltip(c)}
        >
          <title>{refusedTooltip(c)}</title>
          <rect
            x={c.x * CELL}
            y={c.y * CELL}
            width={CELL}
            height={CELL}
            fill={`url(#${hatch})`}
            stroke={WARN}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </svg>
  )
}
