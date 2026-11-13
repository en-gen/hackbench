/**
 * The Objects the map view found (#1237): the hovered one with a faint dashed outline and a very light
 * tint, the selected one with ONE solid outline in a light highlight and a light tint, never a box per
 * tile. In MAP pixels so it follows the zoom by scaling, like the refused overlay; it takes no pointer
 * events, the strip does.
 *
 * Test hooks: `data-control="object-overlay"`; per drawn Object `data-control="object"` with
 * `data-object` (key) and `data-state` hover or selected; inside it `object-tint` (one path),
 * `object-outline` (the boundary the Object draws) and `object-outline-covered` (boundary where a covered
 * cell bounds it, dashed); and `object-segment` with `data-segment`, `data-kind` straight or slope and
 * `data-state` hover or selected for the segments of the selected Object.
 */
import * as React from '@theia/core/shared/react'
import type { ObjectDto } from '../../../../src/rom/objects/Describe'
import { NO_PAD, TILE, type Pad } from './off-map-extent'
import type { ObjectHover, ObjectSelection } from './object-selection'

/** One path for all of an Object's cells (row runs), so a tint is one element, not one per tile. */
export function tintPath(o: ObjectDto): string {
  return o.runs
    .map(r => `M${r.col * TILE} ${r.row * TILE}h${r.len * TILE}v${TILE}h${-r.len * TILE}z`)
    .join('')
}

export function ObjectOverlay(props: {
  objects: readonly ObjectDto[]
  selection: ObjectSelection
  hover: ObjectHover
  /** The whole strip, in map pixels. */
  width: number
  height: number
  zoom: number
  pad?: Pad
}): React.ReactElement | null {
  const { objects, selection, hover } = props
  const drawn = objects.filter(o => o.key === selection.object || o.key === hover.object)
  if (drawn.length === 0) return null
  const pad = props.pad ?? NO_PAD
  const [w, h] = [props.width + pad.left + pad.right, props.height + pad.top + pad.bottom]
  return (
    <svg
      className="hb-map-objects"
      data-control="object-overlay"
      width={w * props.zoom}
      height={h * props.zoom}
      viewBox={`${-pad.left} ${-pad.top} ${w} ${h}`}
    >
      {drawn.map(o => {
        const selected = o.key === selection.object
        const state = selected ? 'selected' : 'hover'
        return (
          <g key={o.key} data-control="object" data-object={o.key} data-state={state}>
            <path data-control="object-tint" className="hb-map-object-tint" d={tintPath(o)} />
            {o.visiblePath && (
              <path
                data-control="object-outline"
                className="hb-map-object-outline"
                d={o.visiblePath}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {o.coveredPath && (
              <path
                data-control="object-outline-covered"
                className="hb-map-object-outline hb-map-object-covered"
                d={o.coveredPath}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {selected &&
              o.segments.map(s => {
                const on = selection.segments.has(s.id)
                const over = hover.object === o.key && hover.segment === s.id
                if (!on && !over) return null
                return (
                  <polyline
                    key={s.id}
                    className="hb-map-object-segment"
                    data-control="object-segment"
                    data-segment={s.id}
                    data-kind={s.kind}
                    data-state={on ? 'selected' : 'hover'}
                    points={s.points.join(' ')}
                    fill="none"
                    vectorEffect="non-scaling-stroke"
                  />
                )
              })}
          </g>
        )
      })}
    </svg>
  )
}
