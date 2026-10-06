// Per-tile probe results -> per-map polylines in map pixel coordinates. Pure functions; no ROM.
import type { TileProbe } from './engine.ts'

export type Cat = 'unknown' | 'passable' | 'hazard' | 'solid' | 'ledge' | 'slope' | 'ceiling slope' | 'partial'
export type Pts = number[] // x0,y0,x1,y1,...
export interface Lines { floor: Pts[]; ceiling: Pts[]; wall: Pts[]; unknown: [number, number][] }

const has = (a: (number | null)[]) => a.some((v) => v !== null)
const flat = (a: (number | null)[]) => a.every((v) => v === a[0])
/** A tile's kind from what the probe measured, not from its id. */
export function categorize(m: TileProbe): Cat {
  if (m.unknown) return 'unknown'
  const f = has(m.floor), c = has(m.ceil), w = m.wallL || m.wallR
  if (m.hurt) return 'hazard'
  if (!f && !c && !w) return 'passable'
  if (f && c && w && m.floor.every((v) => v === 0) && m.ceil.every((v) => v === 16)) return 'solid'
  if (f && !c && !w) return m.floor.every((v) => v === 0) ? 'ledge' : 'slope'
  if (c && !f && !w && !flat(m.ceil)) return 'ceiling slope'
  return 'partial'
}

/** Chains per-column surface samples into polylines: a sample joins the open chain whose last sample is within `step` px; collinear points merge. */
function chain(cols: Map<number, number[]>, width: number, step = 2): Pts[] {
  const done: Pts[] = []
  let open: { pts: number[]; y: number }[] = []
  for (let x = 0; x < width; x++) {
    const ys = [...(cols.get(x) ?? [])].sort((a, b) => a - b)
    const next: typeof open = []
    for (const y of ys) {
      const k = open.findIndex((o) => Math.abs(o.y - y) <= step)
      if (k >= 0) { const o = open.splice(k, 1)[0]!; o.pts.push(x + 0.5, y); o.y = y; next.push(o) } else next.push({ pts: [x, y, x + 0.5, y], y })
    }
    done.push(...open.map((o) => o.pts)) // chains that did not continue end at the previous column's right edge
    open = next
    for (const o of next) if (!(x + 1 < width && (cols.get(x + 1) ?? []).some((y) => Math.abs(y - o.y) <= step))) { o.pts.push(x + 1, o.y) }
  }
  done.push(...open.map((o) => o.pts))
  return done.map(simplify)
}
/** Drops points that lie on the line between their neighbours. */
function simplify(p: Pts): Pts {
  const out: Pts = [p[0]!, p[1]!]
  for (let i = 2; i < p.length - 2; i += 2) {
    const [ax, ay] = [out[out.length - 2]!, out[out.length - 1]!]
    if ((p[i + 2]! - ax) * (p[i + 1]! - ay) === (p[i]! - ax) * (p[i + 3]! - ay)) continue
    out.push(p[i]!, p[i + 1]!)
  }
  out.push(p[p.length - 2]!, p[p.length - 1]!)
  return out
}

/**
 * Edges only where solidity changes: a floor sample is dropped when the cell above also has a floor in that
 * column (it is fill, not surface); a ceiling sample when the cell below has a ceiling; a wall face when the
 * neighbour blocks the opposite face. Chains cross tile boundaries, so slope slices join.
 */
export function compose(grid: number[][], get: (id: number) => TileProbe | undefined, T = 16): Lines {
  const rows = grid.length, cols = grid[0]?.length ?? 0
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? null : get(grid[r]![c]!) ?? null)
  const floor = new Map<number, number[]>(), ceil = new Map<number, number[]>(), wall: Pts[] = [], unknown: [number, number][] = []
  const push = (m: Map<number, number[]>, x: number, y: number) => { const a = m.get(x); a ? a.push(y) : m.set(x, [y]) }
  const vert = (x: number, r: number) => { const l = wall.find((w) => w[0] === x && w[3] === r * T); l ? (l[3] = (r + 1) * T) : wall.push([x, r * T, x, (r + 1) * T]) }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const m = at(c, r)
    if (m === null) { if (get(grid[r]![c]!) === undefined) unknown.push([c, r]); continue }
    const up = at(c, r - 1), down = at(c, r + 1)
    for (let x = 0; x < T; x++) {
      const f = m.floor[x], cl = m.ceil[x]
      if (f !== null && f !== undefined && !(up && up.floor[x] !== null && up.floor[x] !== undefined)) push(floor, c * T + x, r * T + f)
      if (cl !== null && cl !== undefined && !(down && down.ceil[x] !== null && down.ceil[x] !== undefined)) push(ceil, c * T + x, r * T + cl)
    }
    if (m.wallL && !at(c - 1, r)?.wallR) vert(c * T, r)
    if (m.wallR && !at(c + 1, r)?.wallL) vert((c + 1) * T, r)
  }
  return { floor: chain(floor, cols * T), ceiling: chain(ceil, cols * T), wall, unknown }
}
