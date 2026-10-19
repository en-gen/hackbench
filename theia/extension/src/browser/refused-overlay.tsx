/**
 * Marks the Layer 1 objects the map could not draw (#816): one red dashed cell
 * marked "!" each, in MAP pixel coordinates so it follows the zoom by scaling, like the
 * collision overlay. Always shown when any exist (an undrawn object must never
 * look like empty space); nothing is rendered when there are none.
 *
 * Test hooks: `data-control="refused-overlay"`, and per cell
 * `data-control="refused-cell"` with `data-x`, `data-y` (map tiles) and
 * `data-object` (index) and `data-count` (issues on that object). The reasons are both the native tooltip
 * (SVG <title>) and the aria-label. A cell with 2+ issues also holds `data-control="refused-badge"`, a count
 * badge inside its top-right corner (#1005).
 */
import * as React from '@theia/core/shared/react'
import type { MapRefusedCellDto } from '../common/project-protocol'
import { CELL, badgeGeometry, badgeLabel, bangGeometry, refusedTooltip } from './refused-badge'

/** Red, dashed and marked with "!": the collision overlay's unknown cells are orange and hatched, so the two never read alike. */
const WARN = 'var(--theia-editorError-foreground, #f44336)'
/** Theia's on-colour for filled controls, white by default; used for the "!" and the badge on the red. */
const ON_WARN = 'var(--theia-button-foreground, #fff)'

/** The red dashed "!" cells over the map strip, each with a count badge when it has 2+ issues (#1005). */
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
      {props.cells.map(c => {
        const n = c.reasons.length
        const b = badgeGeometry(c.x, c.y, n)
        const bang = bangGeometry(c.x, c.y, n > 1)
        return (
          <g
            key={c.objectIndex}
            data-control="refused-cell"
            data-x={c.x}
            data-y={c.y}
            data-object={c.objectIndex}
            data-count={n}
            aria-label={n > 1 ? `${n} issues. ${refusedTooltip(c)}` : refusedTooltip(c)}
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
              x={bang.x}
              y={bang.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={bang.fontSize}
              fontWeight="bold"
              style={{ fill: ON_WARN, pointerEvents: 'none' }}
            >
              !
            </text>
            {n > 1 && (
              <g data-control="refused-badge" style={{ pointerEvents: 'none' }}>
                <circle cx={b.cx} cy={b.cy} r={b.r} style={{ fill: WARN }} />
                <text
                  x={b.cx}
                  y={b.cy}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={b.fontSize}
                  fontWeight="bold"
                  style={{ fill: ON_WARN, pointerEvents: 'none' }}
                >
                  {badgeLabel(n)}
                </text>
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}
