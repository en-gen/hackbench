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
  /** The definition and the Object top-left cell, not its order, so a selection survives an edit earlier in the list. */
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
    key: `${found.definitionId}:${top.row}:${top.col}`,
    definitionId: found.definitionId,
    name: found.name,
    order: found.order,
    runs,
    visiblePath: outline.visiblePath,
    coveredPath: outline.coveredPath,
    segments: outline.segments,
  }
}

/**
 * The DTOs of every found Object. Two Objects of one definition can share a top-left cell (stacked, one
 * covering the other's corner); they are told apart by their shape (the sorted cell list), never by their
 * place in the list, so an edit that reorders them does not move a selection to the other one.
 */
export function describeObjects(found: readonly FoundObject[], slopeOf: SlopeOf): ObjectDto[] {
  const dtos = found.map(f => ({ dto: describeObject(f, slopeOf), shape: shapeSignature(f) }))
  const twins = new Map<string, string[]>()
  for (const { dto, shape } of dtos) twins.set(dto.key, [...(twins.get(dto.key) ?? []), shape])
  return dtos.map(({ dto, shape }) => {
    const list = twins.get(dto.key)!
    if (list.length === 1) return dto
    const n = [...list].sort().indexOf(shape)
    return n === 0 ? dto : { ...dto, key: `${dto.key}#${n}` }
  })
}

/** The cells of an Object as one comparable string. */
function shapeSignature(f: FoundObject): string {
  return f.cells
    .map(c => c.row * 4096 + c.col)
    .sort((a, b) => a - b)
    .join(',')
}
