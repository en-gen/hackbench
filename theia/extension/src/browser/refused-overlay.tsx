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
import { NO_PAD, TILE, type Pad } from './off-map-extent'

/** Red, dashed and marked with "!": the collision overlay's unknown cells are orange and hatched, so the two never read alike. */
const WARN = 'var(--theia-editorError-foreground, #f44336)'

export const refusedTooltip = (c: MapRefusedCellDto): string =>
  `Object ${c.objectIndex} (${c.objectType}): ${c.why}`

/**
 * The marks of the Layer 1 objects the drawer refused, as one SVG in map pixels. It spans the padded strip
 * with its origin at the MAP's origin, so a mark the data places off the map is drawn there (#1004).
 */
export function RefusedOverlay(props: {
  cells: readonly MapRefusedCellDto[]
  /** The whole strip, in map pixels. */
  width: number
  height: number
  zoom: number
  /**
   * The gutter around the map (#1004): the svg covers the padded strip and its user space
   * keeps the MAP's origin, so a cell the data places in the gutter lands there, at its own x,y.
   */
  pad?: Pad
}): React.ReactElement | null {
  if (props.cells.length === 0) return null
  const pad = props.pad ?? NO_PAD
  const [w, h] = [props.width + pad.left + pad.right, props.height + pad.top + pad.bottom]
  return (
    <svg
      className="hb-map-refused"
      data-control="refused-overlay"
      width={w * props.zoom}
      height={h * props.zoom}
      viewBox={`${-pad.left} ${-pad.top} ${w} ${h}`}
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
            x={c.x * TILE}
            y={c.y * TILE}
            width={TILE}
            height={TILE}
            style={{ fill: WARN, stroke: WARN }}
            strokeWidth="2"
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
          <text
            x={c.x * TILE + TILE / 2}
            y={c.y * TILE + TILE / 2}
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
