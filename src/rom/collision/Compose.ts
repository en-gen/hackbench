/**
 * Compose.ts -- per-tile probe results into per-map lines in map pixel
 * coordinates (en-gen/hackbench#435). Pure functions; no ROM, no shell.
 *
 * Edges appear only where solidity changes, and slope slices join across tile
 * boundaries: the spike's rules (spikes/collision-probe/README.md) and the
 * ones the owner signed off on maps $105, $10A and $111.
 */
import type { TileProbe } from './TileProbe'

export type CollisionKind = 'floor' | 'ceiling' | 'wall' | 'unknown'
/** One line the overlay draws. Points are x0,y0,x1,y1,...; a wall has two points, an unknown cell is its closed outline. */
export interface CollisionLine {
  kind: CollisionKind
  points: number[]
}

const TILE = 16

/** Chains per-column surface samples into polylines: a sample joins the open chain whose last sample is within `step` px; collinear points merge. */
function chain(cols: Map<number, number[]>, width: number, step = 2): number[][] {
  const done: number[][] = []
  let open: { pts: number[]; y: number }[] = []
  for (let x = 0; x < width; x++) {
    const ys = [...(cols.get(x) ?? [])].sort((a, b) => a - b)
    const next: typeof open = []
    for (const y of ys) {
      const k = open.findIndex(o => Math.abs(o.y - y) <= step)
      if (k >= 0) {
        const o = open.splice(k, 1)[0]!
        o.pts.push(x + 0.5, y)
        o.y = y
        next.push(o)
      } else next.push({ pts: [x, y, x + 0.5, y], y })
    }
    // Chains that did not continue end at the previous column's right edge.
    done.push(...open.map(o => o.pts))
    open = next
    for (const o of next) {
      const continues =
        x + 1 < width && (cols.get(x + 1) ?? []).some(y => Math.abs(y - o.y) <= step)
      if (!continues) o.pts.push(x + 1, o.y)
    }
  }
  done.push(...open.map(o => o.pts))
  return done.map(simplify)
}

/** Drops points that lie on the line between their neighbours. */
function simplify(p: number[]): number[] {
  const out = [p[0]!, p[1]!]
  for (let i = 2; i < p.length - 2; i += 2) {
    const [ax, ay] = [out[out.length - 2]!, out[out.length - 1]!]
    if ((p[i + 2]! - ax) * (p[i + 1]! - ay) === (p[i]! - ax) * (p[i + 3]! - ay)) continue
    out.push(p[i]!, p[i + 1]!)
  }
  out.push(p[p.length - 2]!, p[p.length - 1]!)
  return out
}

/**
 * The map's lines from its Map16 grid (`grid[row][col]`, 16 px cells). A floor
 * sample is dropped when the cell above also has a floor in that column (it is
 * fill, not surface); a ceiling sample when the cell below has a ceiling; a
 * wall face when the neighbour blocks the opposite face. A tile `get` does not
 * know, or one that came out unknown, is an `unknown` cell and draws no edges.
 */
export function compose(
  grid: readonly (readonly number[])[],
  get: (id: number) => TileProbe | undefined,
): CollisionLine[] {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  const at = (c: number, r: number): TileProbe | null => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return null
    const m = get(grid[r]![c]!)
    return m && !m.unknown ? m : null
  }
  const floor = new Map<number, number[]>()
  const ceil = new Map<number, number[]>()
  const wall: CollisionLine[] = []
  const unknown: CollisionLine[] = []
  const push = (m: Map<number, number[]>, x: number, y: number) => {
    const a = m.get(x)
    if (a) a.push(y)
    else m.set(x, [y])
  }
  const has = (v: number | null | undefined): v is number => v !== null && v !== undefined
  // A vertical edge on consecutive rows is one line.
  const vert = (x: number, r: number) => {
    const l = wall.find(w => w.points[0] === x && w.points[3] === r * TILE)
    if (l) l.points[3] = (r + 1) * TILE
    else wall.push({ kind: 'wall', points: [x, r * TILE, x, (r + 1) * TILE] })
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const m = at(c, r)
      if (m === null) {
        const [x, y] = [c * TILE, r * TILE]
        const known = get(grid[r]![c]!)
        if (!known || known.unknown) {
          unknown.push({ kind: 'unknown', points: [x, y, x + TILE, y, x + TILE, y + TILE, x, y + TILE, x, y] }) // prettier-ignore
        }
        continue
      }
      const up = at(c, r - 1)
      const down = at(c, r + 1)
      for (let x = 0; x < TILE; x++) {
        const f = m.floor[x]
        const cl = m.ceil[x]
        if (has(f) && !has(up?.floor[x])) push(floor, c * TILE + x, r * TILE + f)
        if (has(cl) && !has(down?.ceil[x])) push(ceil, c * TILE + x, r * TILE + cl)
      }
      if (m.wallL && !at(c - 1, r)?.wallR) vert(c * TILE, r)
      if (m.wallR && !at(c + 1, r)?.wallL) vert((c + 1) * TILE, r)
    }
  }
  return [
    ...chain(floor, cols * TILE).map(points => ({ kind: 'floor' as const, points })),
    ...chain(ceil, cols * TILE).map(points => ({ kind: 'ceiling' as const, points })),
    ...wall,
    ...unknown,
  ]
}
