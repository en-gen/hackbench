/**
 * Marks the Layer 1 objects the map could not draw (#816): one red dashed cell
 * marked "!" each, in MAP pixel coordinates so it follows the zoom by scaling, like the
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
/** Red, dashed and marked with "!": the collision overlay's unknown cells are orange and hatched, so the two never read alike. */
const WARN = 'var(--theia-editorError-foreground, #f44336)'

export const refusedTooltip = (c: MapRefusedCellDto): string =>
  `Object ${c.objectIndex} (${c.objectType}): ${c.why}`

export function RefusedOverlay(props: {
  cells: readonly MapRefusedCellDto[]
  /** The whole strip, in map pixels. */
  width: number
  height: number
  zoom: number
}): React.ReactElement | null {
  if (props.cells.length === 0) return null
  return (
    <svg
      className="hb-map-refused"
      data-control="refused-overlay"
      width={props.width * props.zoom}
      height={props.height * props.zoom}
      viewBox={`0 0 ${props.width} ${props.height}`}
    >
      {props.cells.map(c => (
        <g
          key={c.objectIndex}
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
            style={{ fill: WARN, stroke: WARN }}
            strokeWidth="2"
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
          <text
            x={c.x * CELL + CELL / 2}
            y={c.y * CELL + CELL / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="12"
            fontWeight="bold"
            style={{ fill: '#fff', pointerEvents: 'none' }}
          >
            !
          </text>
        </g>
      ))}
    </svg>
  )
}
