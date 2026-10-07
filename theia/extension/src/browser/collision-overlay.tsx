/**
 * The map tab's collision overlay (#435): one SVG above the screens, in MAP
 * pixel coordinates, so it follows the zoom by scaling and never re-rasterises
 * (lines stay crisp). `vector-effect: non-scaling-stroke` keeps a line 2 CSS px
 * wide at every zoom while its position scales. Surfaces (floors, ceilings,
 * slopes) and walls are separate groups, so a split into two toggles stays a
 * CSS change. An unknown tile (a probe run that threw or ran past its budget)
 * is hatched, never left looking empty.
 *
 * Test hooks: `data-control="collision-overlay"`, `data-revision` (how many replies the tab has
 * taken, so a refetch is observable), `data-group`, `data-kind`.
 * Colors are the owner's from the spike's viewer, not theme tokens: they must
 * read on any map.
 */
import * as React from '@theia/core/shared/react'
import type { MapCollisionLineDto } from '../common/project-protocol'

export interface CollisionLayerView {
  width: number
  height: number
  lines: readonly MapCollisionLineDto[]
}

const SURFACE = '#ffeb3b'
const WALL = '#d500f9'
const UNKNOWN = '#ff9800'

const points = (p: readonly number[]): string =>
  p.reduce((s, v, i) => s + (i % 2 ? ',' : i ? ' ' : '') + v, '')

/** The lines alone, memoised on the layer so a zoom step does not rebuild hundreds of elements. */
const Lines = React.memo(function Lines(props: {
  lines: readonly MapCollisionLineDto[]
  hatch: string
}): React.ReactElement {
  const of = (...kinds: string[]) => props.lines.filter(l => kinds.includes(l.kind))
  const poly = (l: MapCollisionLineDto, i: number) => (
    <polyline key={i} data-kind={l.kind} points={points(l.points)} />
  )
  return (
    <>
      <g data-group="surfaces" stroke={SURFACE}>
        {of('floor', 'ceiling').map(poly)}
      </g>
      <g data-group="walls" stroke={WALL}>
        {of('wall').map(poly)}
      </g>
      <g data-group="unknown" fill={`url(#${props.hatch})`} stroke={UNKNOWN}>
        {of('unknown').map(poly)}
      </g>
    </>
  )
})

export function CollisionOverlay(props: {
  layer: CollisionLayerView
  zoom: number
  /** Distinguishes this tab's pattern id from another open map's. */
  owner: string
  /** Replies taken so far by this tab; only a test hook. */
  revision: number
}): React.ReactElement {
  const { width, height } = props.layer
  const hatch = `hb-collision-hatch-${props.owner.replace(/[^\w-]/g, '_')}`
  return (
    <svg
      className="hb-map-collision"
      data-control="collision-overlay"
      data-revision={props.revision}
      width={width * props.zoom}
      height={height * props.zoom}
      viewBox={`0 0 ${width} ${height}`}
    >
      <defs>
        <pattern
          id={hatch}
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="4" stroke={UNKNOWN} strokeWidth="1" />
        </pattern>
      </defs>
      <Lines lines={props.layer.lines} hatch={hatch} />
    </svg>
  )
}
