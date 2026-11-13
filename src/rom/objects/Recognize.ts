/**
 * Finds the saved Objects of a Layer 1 map (#1237), read-only. Pure: no ROM, no shell.
 *
 * An Object is a connected patch of one definition tiles (#1234 round 1 call 1). Two sources:
 *  1. stored pieces, through the footprint every piece wrote: this finds a covered Object whole and
 *     keeps touching Objects apart (the pieces say which tiles belong together);
 *  2. visible tiles, for what the pieces do not explain.
 * docs/architecture/objects-on-map.md has the diagram and the ties.
 */
import type { Footprint, OwnerGrid, TileGrid } from '../objectHandlers/cursor'

/** An Object definition as the finder reads it (#1236 file, src/project/ObjectDefinitions*.ts). */
export interface FinderDefinition {
  id: string
  name: string
  tileset: number
  edge: readonly number[]
  fill: readonly number[]
}

export interface ObjectCell {
  row: number
  col: number
  tile: number
  /** True when the Object own piece is the last writer of the cell; false when something covers it. */
  visible: boolean
}

export interface FoundObject {
  definitionId: string
  name: string
  /** Front-to-back: a larger order is drawn later, so it is in front. -1 when no stored piece is involved. */
  order: number
  cells: ObjectCell[]
}

export interface RecognizeInput {
  /** The visible Map16 grid. */
  grid: TileGrid
  /** Last writer of each cell (the stored piece index in the level list). */
  owners: OwnerGrid
  /** Every tile any stored piece wrote, in write order. */
  footprint: Footprint
  /** The level header foreground tileset: definitions of any other never match. */
  tileset: number
}

/** Steps a test can switch off to prove the step is load-bearing (#1237 acceptance 10). */
export interface RecognizeOptions {
  /** Default true. False merges every touching piece into one group, as a visible-only scan would. */
  splitPieces?: boolean
}

const key = (row: number, col: number): number => row * 4096 + col
const rowOf = (k: number): number => Math.floor(k / 4096)
const colOf = (k: number): number => k % 4096
const NEIGHBORS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]

interface Cell {
  tile: number
  /** The stored piece whose tile this is. */
  piece: number
}
interface Group {
  pieces: Set<number>
  /** Cell key to the latest group piece tile there. */
  cells: Map<number, Cell>
  /** A visible tile contradicts the rule here (#1234: it blocks the match): the group yields nothing. */
  broken?: boolean
}
type PieceCells = Map<number, Map<number, number>>

/**
 * Whether some edge tile in the shape has shape cells on all four sides (round 1 call 1: that edge tile
 * is inside the patch and breaks the match). `tileAt` is a shape cell tile, undefined outside it.
 */
function hasSurroundedEdge(
  shape: Iterable<number>,
  tileAt: (k: number) => number | undefined,
  isEdge: (tile: number) => boolean,
): boolean {
  for (const k of shape) {
    const t = tileAt(k)
    if (t === undefined || !isEdge(t)) continue
    const r = rowOf(k)
    const c = colOf(k)
    if (NEIGHBORS.every(([dr, dc]) => tileAt(key(r + dr, c + dc)) !== undefined)) return true
  }
  return false
}

/** Per stored piece, in list order: cell key to the piece last tile there. */
function piecesOf(footprint: Footprint): PieceCells {
  const byPiece: PieceCells = new Map()
  for (const f of footprint) {
    let m = byPiece.get(f.owner)
    if (!m) byPiece.set(f.owner, (m = new Map()))
    m.set(key(f.row, f.col), f.tile)
  }
  return new Map([...byPiece].sort((a, b) => a[0] - b[0]))
}

/** Every Object of the definitions tileset on this map, back to front. */
export function recognizeObjects(
  input: RecognizeInput,
  definitions: readonly FinderDefinition[],
  options: RecognizeOptions = {},
): FoundObject[] {
  const found: FoundObject[] = []
  const pieces = piecesOf(input.footprint)
  for (const def of definitions) {
    // A tile number means different art on another tileset, so a definition never crosses over.
    if (def.tileset !== input.tileset || def.edge.length === 0) continue
    found.push(...recognizeOne(input, def, pieces, options.splitPieces !== false))
  }
  // Stable: a tie keeps definition order, then discovery order.
  return found.sort((a, b) => a.order - b.order)
}

/**
 * Links stored pieces into groups, the piece path of the finder.
 *
 * Two pieces are linked by contact: 4-adjacent cells where at least one is an edge tile. Fill beside
 * fill proves nothing (ground under a platform interior is not part of the platform). Links are
 * taken best first (the share of the longer piece the contact line covers, then contact cells, then
 * list order), and only when the contact covers half of the smaller piece. A link is refused when
 *  - both groups already hold an edge tile and some piece of one overlaps some piece of the other:
 *    overlapping pieces are one drawn over another, so they are stacked Objects, not one; or
 *  - the merged shape has an edge tile inside it (`holds`, round 1 call 1).
 * With `split` off every touch or overlap links, as a visible-only scan would see it.
 */
function groupPieces(
  allPieces: PieceCells,
  defTiles: ReadonlySet<number>,
  isEdge: (tile: number) => boolean,
  split: boolean,
  holds: (g: Group) => boolean,
  holdsByPieces: (g: Group) => boolean,
): Group[] {
  const pieces = new Map<number, Map<number, Cell>>()
  const coverers = new Map<number, number[]>()
  for (const [index, cells] of allPieces) {
    const mine = new Map<number, Cell>()
    for (const [k, t] of cells) if (defTiles.has(t)) mine.set(k, { tile: t, piece: index })
    if (mine.size === 0) continue
    pieces.set(index, mine)
    for (const k of mine.keys()) {
      const list = coverers.get(k)
      if (list) list.push(index)
      else coverers.set(k, [index])
    }
  }
  const overlaps = new Map<number, Set<number>>()
  interface Link {
    p: number
    q: number
    w: number
    /** Contact cells side by side (the contact line is vertical). */
    side: number
  }
  const links = new Map<number, Link>()
  const link = (p: number, q: number, w: number, side = 0) => {
    const id = p * 1e6 + q
    const have = links.get(id)
    if (have) {
      have.w += w
      have.side += side
    } else links.set(id, { p, q, w, side })
  }
  for (const [p, mine] of pieces) {
    for (const [k, c] of mine) {
      for (const q of coverers.get(k)!) {
        if (q <= p) continue
        if (!overlaps.has(p)) overlaps.set(p, new Set())
        if (!overlaps.has(q)) overlaps.set(q, new Set())
        overlaps.get(p)!.add(q)
        overlaps.get(q)!.add(p)
        if (!split) link(p, q, 1)
      }
      for (const [dr, dc] of NEIGHBORS) {
        const n = key(rowOf(k) + dr, colOf(k) + dc)
        for (const q of coverers.get(n) ?? []) {
          if (q <= p) continue
          // A cell both pieces cover is overlap, not contact: its neighbors say nothing about joining.
          if (coverers.get(k)!.includes(q) || coverers.get(n)!.includes(p)) continue
          if (!split || isEdge(c.tile) || isEdge(pieces.get(q)!.get(n)!.tile)) link(p, q, 1, dr === 0 ? 1 : 0) // prettier-ignore
        }
      }
    }
  }
  const groupOf = new Map<number, Group>()
  for (const [p, mine] of pieces) groupOf.set(p, { pieces: new Set([p]), cells: new Map(mine) })
  const hasEdge = (g: Group) => [...g.cells.values()].some(c => isEdge(c.tile))
  const stacked = (a: Group, b: Group) =>
    [...a.pieces].some(p => [...(overlaps.get(p) ?? [])].some(q => b.pieces.has(q)))
  // A link is a real join only when the contact covers at least half of the smaller piece: a platform
  // wall resting on the ground touches one cell of it, an interior beside its edge touches them all.
  const strong = (l: Link) =>
    !split || l.w * 2 >= Math.min(pieces.get(l.p)!.size, pieces.get(l.q)!.size)
  // How much of the longer piece the contact line covers: an edge beside the interior that runs the
  // same rows beats one beside an interior that runs on past it.
  const span = (index: number, vertical: boolean): number => {
    const ks = [...pieces.get(index)!.keys()].map(k => (vertical ? rowOf(k) : colOf(k)))
    return Math.max(...ks) - Math.min(...ks) + 1
  }
  const score = (l: Link): number => {
    const vertical = l.side * 2 >= l.w
    return l.w / Math.max(span(l.p, vertical), span(l.q, vertical))
  }
  const ordered = [...links.values()]
    .filter(strong)
    .map(l => ({ ...l, score: score(l) }))
    .sort((a, b) => b.score - a.score || b.w - a.w || a.p - b.p || a.q - b.q)
  for (const { p, q } of ordered) {
    const a = groupOf.get(p)!
    const b = groupOf.get(q)!
    if (a === b) continue
    if (split && hasEdge(a) && hasEdge(b) && stacked(a, b)) continue
    const merged: Group = { pieces: new Set([...a.pieces, ...b.pieces]), cells: new Map(a.cells) }
    for (const [k, c] of b.cells) {
      const have = merged.cells.get(k)
      if (!have || c.piece > have.piece) merged.cells.set(k, c)
    }
    // The pieces alone decide what is one Object. A merge the pieces allow but the visible tiles contradict
    // is still one Object, a broken one: it yields nothing, and does not fall apart into fragments.
    if (split && !holdsByPieces(merged)) continue
    merged.broken = a.broken || b.broken || (split && !holds(merged))
    for (const m of merged.pieces) groupOf.set(m, merged)
  }
  return [...new Set(groupOf.values())]
}

/** One definition: piece path, cut-short edges, then the visible path. */
function recognizeOne(
  input: RecognizeInput,
  def: FinderDefinition,
  allPieces: PieceCells,
  split: boolean,
): FoundObject[] {
  const edge = new Set(def.edge)
  const defTiles = new Set([...def.edge, ...def.fill])
  const isEdge = (t: number) => edge.has(t)
  const { grid, owners } = input
  const gridTile = (k: number) => grid[rowOf(k)]?.[colOf(k)]
  const ownerAt = (k: number) => owners[rowOf(k)]?.[colOf(k)] ?? -2
  const showsVisibly = (g: Group, k: number) => g.pieces.has(ownerAt(k))

  /**
   * The shape a group draws, for the rule: a visibly owned cell shows its grid tile (out of the shape
   * when that is not a definition tile), a covered one the group own tile.
   */
  const shapeOf = (g: Group, useGrid = true): Map<number, number> => {
    const out = new Map<number, number>()
    for (const [k, c] of g.cells) {
      const t = useGrid && showsVisibly(g, k) ? gridTile(k) : c.tile
      if (t !== undefined && defTiles.has(t)) out.set(k, t)
    }
    return out
  }
  /** The merge-time half of the rule: no surrounded edge tile. At least one edge waits for a whole group. */
  const holds = (g: Group): boolean => {
    const shape = shapeOf(g)
    return !hasSurroundedEdge(shape.keys(), k => shape.get(k), isEdge)
  }
  /** The same test on what the pieces wrote, ignoring the grid: false means the pieces themselves stack. */
  const holdsByPieces = (g: Group): boolean => {
    const shape = shapeOf(g, false)
    return !hasSurroundedEdge(shape.keys(), k => shape.get(k), isEdge)
  }

  // 1. Piece path: stored pieces are linked into groups, strongest contact first.
  const groups = groupPieces(allPieces, defTiles, isEdge, split, holds, holdsByPieces)
  // 2. Edges the list cut short are extended to the extent of the pieces beside them, under what covers them.
  const coveredByOther = (g: Group, k: number) => {
    const o = ownerAt(k)
    return o >= 0 && !g.pieces.has(o)
  }
  for (const g of groups) extendCutShort(g, edge, coveredByOther)

  // The shapes that pass the rule whole.
  const out: FoundObject[] = []
  const shown = new Set<number>()
  const broken = new Set<number>()
  for (const g of groups) {
    const shape = shapeOf(g)
    if (g.broken || hasSurroundedEdge(shape.keys(), k => shape.get(k), isEdge)) {
      // Broken: nothing is offered for these pieces, and the patch scan below does not resurrect them.
      for (const p of g.pieces) broken.add(p)
      continue
    }
    if (![...shape.values()].some(isEdge)) continue
    const cells: ObjectCell[] = []
    for (const [k, tile] of shape) {
      const visible = showsVisibly(g, k)
      cells.push({ row: rowOf(k), col: colOf(k), tile, visible })
      if (visible) shown.add(k)
    }
    out.push({ definitionId: def.id, name: def.name, order: Math.max(...g.pieces), cells })
  }

  // 3. Visible path: definition tiles no piece group shows, as 4-connected patches.
  const seen = new Set<number>()
  const free = (k: number): boolean => {
    const t = gridTile(k)
    // A broken Object's own cells are not offered again as a patch.
    return t !== undefined && defTiles.has(t) && !shown.has(k) && !broken.has(ownerAt(k))
  }
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!
    for (let c = 0; c < row.length; c++) {
      const start = key(r, c)
      if (seen.has(start) || !free(start)) continue
      const patch = new Map<number, number>()
      const queue = [start]
      seen.add(start)
      while (queue.length > 0) {
        const k = queue.pop()!
        patch.set(k, gridTile(k)!)
        for (const [dr, dc] of NEIGHBORS) {
          const n = key(rowOf(k) + dr, colOf(k) + dc)
          if (seen.has(n) || !free(n)) continue
          seen.add(n)
          queue.push(n)
        }
      }
      if (![...patch.values()].some(isEdge)) continue
      if (hasSurroundedEdge(patch.keys(), k => patch.get(k), isEdge)) continue
      let order = -1
      const cells: ObjectCell[] = []
      for (const [k, tile] of patch) {
        order = Math.max(order, ownerAt(k))
        cells.push({ row: rowOf(k), col: colOf(k), tile, visible: true })
      }
      out.push({ definitionId: def.id, name: def.name, order, cells })
    }
  }
  return out
}

/**
 * An edge piece (one straight run of edge tiles) shorter than the group piece beside it is extended to
 * that piece extent along the shared side, repeating its end tile, but only through cells another piece
 * draws over (the list cut the edge short because another Object covers it; #1234 round 1 call 2; $103).
 * The new cells are covered.
 */
function extendCutShort(
  g: Group,
  edge: ReadonlySet<number>,
  coveredByOther: (g: Group, k: number) => boolean,
): void {
  const added = new Map<number, Cell>()
  for (const p of g.pieces) {
    const mine = [...g.cells].filter(([, c]) => c.piece === p)
    if (mine.length === 0 || !mine.every(([, c]) => edge.has(c.tile))) continue
    const rows = new Set(mine.map(([k]) => rowOf(k)))
    const cols = new Set(mine.map(([k]) => colOf(k)))
    const vertical = cols.size === 1
    if (!vertical && rows.size !== 1) continue
    // along runs with the edge piece, across is the axis it stands on.
    const along = (k: number) => (vertical ? rowOf(k) : colOf(k))
    const across = (k: number) => (vertical ? colOf(k) : rowOf(k))
    const cellAt = (a: number, x: number) => (vertical ? key(a, x) : key(x, a))
    const x0 = across(mine[0]![0])
    const alongs = mine.map(([k]) => along(k))
    const lo = Math.min(...alongs)
    const hi = Math.max(...alongs)
    const lowTile = g.cells.get(cellAt(lo, x0))!.tile
    const highTile = g.cells.get(cellAt(hi, x0))!.tile
    let nlo = lo
    let nhi = hi
    for (const [k, c] of g.cells) {
      if (c.piece === p || Math.abs(across(k) - x0) !== 1) continue
      nlo = Math.min(nlo, along(k))
      nhi = Math.max(nhi, along(k))
    }
    // Only under something else drawn there: over empty sky the list did not cut anything short.
    for (let a = lo - 1; a >= nlo && coveredByOther(g, cellAt(a, x0)); a--)
      added.set(cellAt(a, x0), { tile: lowTile, piece: p })
    for (let a = hi + 1; a <= nhi && coveredByOther(g, cellAt(a, x0)); a++)
      added.set(cellAt(a, x0), { tile: highTile, piece: p })
  }
  for (const [k, c] of added) if (!g.cells.has(k)) g.cells.set(k, c)
}
