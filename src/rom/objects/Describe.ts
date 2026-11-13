/**
 * What the map view needs of a found Object (#1237): its cells as row runs (hit test and tint), its
 * outline as SVG path data, and its edge segments. Plain data, so it crosses the RPC unchanged.
 */
import { buildOutline, type Segment, type SlopeOf } from './Outline'
import type { FoundObject } from './Recognize'

export type { Segment } from './Outline'

/** One row run of cells: `len` cells from (`row`, `col`) to the right. */
export interface CellRun {
  row: number
  col: number
  len: number
}

export interface ObjectDto {
  /** Stable while the Object keeps its place, so a selection survives a refetch. */
  key: string
  definitionId: string
  name: string
  /** Front-to-back: a larger order is in front. */
  order: number
  runs: CellRun[]
  /** Outline path data in map pixels, solid where the Object draws itself. */
  visiblePath: string
  /** Outline path data where a covered cell bounds the shape; drawn dashed. */
  coveredPath: string
  segments: Segment[]
}

/** Row runs of the cells, left to right, top to bottom. */
export function runsOfCells(cells: readonly { row: number; col: number }[]): CellRun[] {
  const sorted = [...cells].sort((a, b) => a.row - b.row || a.col - b.col)
  const runs: CellRun[] = []
  for (const c of sorted) {
    const last = runs[runs.length - 1]
    if (last && last.row === c.row && last.col + last.len === c.col) last.len++
    else runs.push({ row: c.row, col: c.col, len: 1 })
  }
  return runs
}

/** The DTO of one found Object. */
export function describeObject(found: FoundObject, slopeOf: SlopeOf): ObjectDto {
  const runs = runsOfCells(found.cells)
  const outline = buildOutline(found.cells, slopeOf)
  const top = runs[0]!
  return {
    key: `${found.definitionId}:${found.order}:${top.row}:${top.col}`,
    definitionId: found.definitionId,
    name: found.name,
    order: found.order,
    runs,
    visiblePath: outline.visiblePath,
    coveredPath: outline.coveredPath,
    segments: outline.segments,
  }
}
