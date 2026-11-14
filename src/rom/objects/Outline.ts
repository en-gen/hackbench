/**
 * The outline of an Object and its edge segments (#1237). Pure geometry on tile cells, in pixels.
 *
 * The outline follows tile cells: a staircase along a slope (#1234 round 1 call 4). It is split into
 * segments where it turns a corner, except that a run of slope tiles at one angle is one segment.
 * A boundary unit owned by a covered cell goes to the covered path (drawn dashed).
 */
import type { ObjectCell } from './Recognize'

export const TILE_PX = 16

export interface Segment {
  /** Stable within one Object: its place in the outline. */
  id: string
  kind: 'straight' | 'slope'
  /** x0,y0,x1,y1,... in pixels from the map origin. */
  points: number[]
}

export interface Outline {
  /** SVG path data (pixel units): the boundary the Object draws itself. */
  visiblePath: string
  /** SVG path data for boundary units owned by a covered cell. */
  coveredPath: string
  segments: Segment[]
}

/** The angle class of a tile: null for a flat or non-slope tile. */
export type SlopeOf = (tile: number) => number | null

interface Unit {
  x0: number
  y0: number
  x1: number
  y1: number
  visible: boolean
  /** Angle class of the owning cell, or null. */
  slope: number | null
}

const vkey = (x: number, y: number): number => y * 65536 + x

/** Every boundary unit of the shape, directed so the shape is on the right-hand side (clockwise on screen). */
function boundaryUnits(cells: readonly ObjectCell[], slopeOf: SlopeOf): Unit[] {
  const have = new Set(cells.map(c => c.row * 4096 + c.col))
  const out: Unit[] = []
  for (const c of cells) {
    const slope = slopeOf(c.tile)
    const add = (x0: number, y0: number, x1: number, y1: number) =>
      out.push({ x0, y0, x1, y1, visible: c.visible, slope })
    const { row: r, col: k } = c
    if (!have.has((r - 1) * 4096 + k)) add(k, r, k + 1, r)
    if (!have.has(r * 4096 + k + 1)) add(k + 1, r, k + 1, r + 1)
    if (!have.has((r + 1) * 4096 + k)) add(k + 1, r + 1, k, r + 1)
    if (!have.has(r * 4096 + k - 1)) add(k, r + 1, k, r)
  }
  return out
}

/** Closed loops of units: at a vertex two loops share, the sharper right turn wins, so loops stay simple. */
function traceLoops(units: Unit[]): Unit[][] {
  const from = new Map<number, Unit[]>()
  for (const u of units) {
    const k = vkey(u.x0, u.y0)
    const l = from.get(k)
    if (l) l.push(u)
    else from.set(k, [u])
  }
  const used = new Set<Unit>()
  const loops: Unit[][] = []
  for (const first of units) {
    if (used.has(first)) continue
    const loop: Unit[] = []
    let u: Unit | undefined = first
    while (u && !used.has(u)) {
      used.add(u)
      loop.push(u)
      const dx = u.x1 - u.x0
      const dy = u.y1 - u.y0
      const next: Unit[] = (from.get(vkey(u.x1, u.y1)) ?? []).filter(n => !used.has(n))
      // Preference: right turn, straight, left turn (screen coordinates, y down).
      const rank = (n: Unit) => {
        const ex = n.x1 - n.x0
        const ey = n.y1 - n.y0
        if (ex === -dy && ey === dx) return 0
        if (ex === dx && ey === dy) return 1
        return 2
      }
      next.sort((a, b) => rank(a) - rank(b))
      u = next[0]
    }
    loops.push(loop)
  }
  return loops
}

interface Run {
  units: Unit[]
  slope: number | null
}

/** Consecutive units that share a direction and an angle class, starting at a corner so none wraps. */
function runsOf(loop: Unit[]): Run[] {
  const same = (a: Unit, b: Unit) =>
    a.x1 - a.x0 === b.x1 - b.x0 && a.y1 - a.y0 === b.y1 - b.y0 && a.slope === b.slope
  let start = loop.findIndex((u, i) => !same(loop[(i + loop.length - 1) % loop.length]!, u))
  if (start < 0) start = 0
  const ordered = [...loop.slice(start), ...loop.slice(0, start)]
  const runs: Run[] = []
  for (const u of ordered) {
    const last = runs[runs.length - 1]
    if (last && same(last.units[last.units.length - 1]!, u)) last.units.push(u)
    else runs.push({ units: [u], slope: u.slope })
  }
  return runs
}

const px = (n: number): number => n * TILE_PX

const dirOf = (r: Run): string =>
  `${r.units[0]!.x1 - r.units[0]!.x0},${r.units[0]!.y1 - r.units[0]!.y0}`

/**
 * Whether a run continues a slope chain: the same angle, and still one monotone staircase, which turns
 * between two directions only (so it never reverses in x or in y). A third direction (down a wall, round a
 * corner, across the loop seam) starts a new segment. A single run is a chain: a lone slope tile is one segment.
 */
function chainable(chain: readonly Run[], run: Run): boolean {
  if (run.slope === null || chain[chain.length - 1]!.slope !== run.slope) return false
  const dirs = new Set(chain.map(dirOf))
  dirs.add(dirOf(run))
  return dirs.size <= 2 && dirOf(chain[chain.length - 1]!) !== dirOf(run)
}

/** The outline and segments of a shape (cells in tile coordinates). */
export function buildOutline(cells: readonly ObjectCell[], slopeOf: SlopeOf): Outline {
  // Sorted, so the loops and the segment ids do not depend on the order the cells arrive in.
  const ordered = [...cells].sort((a, b) => a.row - b.row || a.col - b.col)
  const loops = traceLoops(boundaryUnits(ordered, slopeOf))
  const visible: string[] = []
  const covered: string[] = []
  const segments: Segment[] = []
  loops.forEach(loop => {
    const runs = runsOf(loop)
    // Draw: a path piece per run and visibility, so a dashed stretch is only the covered stretch.
    for (const run of runs) {
      let part: Unit[] = []
      const flush = () => {
        if (part.length === 0) return
        const a = part[0]!
        const b = part[part.length - 1]!
        const d = `M${px(a.x0)} ${px(a.y0)}L${px(b.x1)} ${px(b.y1)}`
        ;(a.visible ? visible : covered).push(d)
        part = []
      }
      for (const u of run.units) {
        if (part.length > 0 && part[0]!.visible !== u.visible) flush()
        part.push(u)
      }
      flush()
    }
    // Segments: a slope chain of equal angle is one; every other run is one.
    const chains: Run[][] = []
    for (const run of runs) {
      const last = chains[chains.length - 1]
      if (last && run.slope !== null && chainable(last, run)) last.push(run)
      else chains.push([run])
    }
    // The loop starts at a corner, not at the start of a staircase: the last chain takes as many of the first
    // chain's runs as still make it one staircase (the seam between them is not a corner of its own).
    if (chains.length > 1) {
      const tail = chains[chains.length - 1]!
      const first = chains[0]!
      while (first.length > 0 && tail[0]!.slope !== null && chainable(tail, first[0]!))
        tail.push(first.shift()!)
      if (first.length === 0) chains.shift()
    }
    chains.forEach(chain => {
      const slope = chain[0]!.slope !== null
      const pts: number[] = []
      const units = chain.flatMap(r => r.units)
      pts.push(px(units[0]!.x0), px(units[0]!.y0))
      if (slope) {
        // The staircase: each run end is a vertex.
        for (const r of chain) {
          const e = r.units[r.units.length - 1]!
          pts.push(px(e.x1), px(e.y1))
        }
      } else {
        const e = units[units.length - 1]!
        pts.push(px(e.x1), px(e.y1))
      }
      // Named by where it runs, so it keeps its name when something unrelated changes elsewhere.
      const id = `${pts[0]},${pts[1]}:${pts[pts.length - 2]},${pts[pts.length - 1]}`
      segments.push({ id, kind: slope ? 'slope' : 'straight', points: pts })
    })
  })
  return { visiblePath: visible.join(''), coveredPath: covered.join(''), segments }
}
