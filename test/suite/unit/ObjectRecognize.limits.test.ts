/**
 * The known limit of the Object finder, asserted exactly (docs/architecture/objects-on-map.md, "Limits, stated"):
 * what happens when one edge tile is dropped into layered Objects. These tests pin today's numbers so the doc
 * cannot drift from the code; they are not a claim that the numbers are right (the owner rules on the edit).
 * Every map is built with `stamp`.
 */
import { describe, it, expect } from 'vitest'
import { recognizeObjects, type FoundObject } from '../../../src/rom/objects/Recognize'
import { def, stamp, type Piece } from '../support/objectMaps'

const [TL, WL, TR, WR, FTOP, DIRT] = [11, 12, 13, 14, 15, 16]
const D = def({ edge: [TL, WL, TR, WR], fill: [FTOP, DIRT] })
const keys = (f: FoundObject) => new Set(f.cells.map(c => `${c.row},${c.col}`))
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(k => b.has(k))
const rect = (x: number, y: number, w: number, h: number) =>
  new Set(Array.from({ length: w * h }, (_, i) => `${y + Math.floor(i / w)},${x + (i % w)}`))
const plat = (x: number, y: number, w: number, h: number): Piece[] => [
  { x, y, w: 1, h, tile: (r: number) => (r === y ? TL : WL) },
  { x: x + 1, y, w: w - 2, h, tile: (r: number) => (r === y ? FTOP : DIRT) },
  { x: x + w - 1, y, w: 1, h, tile: (r: number) => (r === y ? TR : WR) },
]

function shuffled<T>(list: T[], seed: number): T[] {
  let s = seed
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('a lone edge tile dropped into the four-platform stack, one cell at a time', () => {
  const PL = [
    { x: 8, y: 9, w: 6, left: 3, right: 15 },
    { x: 5, y: 12, w: 5, left: 4, right: 8 },
    { x: 3, y: 16, w: 5, left: 8, right: 4 },
    { x: 5, y: 20, w: 6, left: 3, right: 4 },
  ]
  const pieces = PL.flatMap((p): Piece[] => [
    { x: p.x, y: p.y, w: 1, h: p.left, tile: (r: number) => (r === p.y ? TL : WL) },
    { x: p.x + 1, y: p.y, w: p.w - 2, h: 24 - p.y, tile: (r: number) => (r === p.y ? FTOP : DIRT) },
    { x: p.x + p.w - 1, y: p.y, w: 1, h: p.right, tile: (r: number) => (r === p.y ? TR : WR) },
  ])
  const ORDER = [4, 5, 1, 8, 9, 2, 11, 3, 0, 7, 6, 10]
  const ground: Piece = { x: 1, y: 24, w: 20, h: 3, tile: (r: number) => (r === 24 ? FTOP : DIRT) }
  const base = [ground, ...ORDER.map(i => pieces[i]!)]
  const rectOf = (k: number) => rect(PL[k]!.x, PL[k]!.y, PL[k]!.w, 24 - PL[k]!.y)

  it('the exact tally of what becomes of the platforms (142 cells)', () => {
    const m0 = stamp(base, 40, 28)
    const tally = { probed: 0, alone: 0, linked: 0, allWhole: 0, plusTile: 0, grows: 0, ground: 0, drops: 0, platformsMissingInDrops: 0, shouldBreak: 0, shouldBreakAndDoesNot: 0 } // prettier-ignore
    const dropCells: string[] = []
    for (let r = 9; r <= 23; r++)
      for (let c = 3; c <= 13; c++) {
        if (![TL, WL, TR, WR, FTOP, DIRT].includes(m0.grid[r]![c]!)) continue
        tally.probed++
        const f = recognizeObjects(stamp([...base, { x: c, y: r, w: 1, h: 1, tile: WL }], 40, 28), [
          D,
        ])
        const owner = m0.owners[r]![c]!
        const vis = owner <= 0 ? -1 : Math.floor(ORDER[owner - 1]! / 3)
        const around = vis >= 0 && [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].every(([dr, dc]) => rectOf(vis).has(`${r + dr!},${c + dc!}`)) // prettier-ignore
        const whole = [0, 1, 2, 3].filter(k => f.some(o => same(keys(o), rectOf(k))))
        if (f.some(o => o.cells.length === 1 && o.cells[0]!.row === r && o.cells[0]!.col === c)) {
          tally.alone++
          continue
        }
        tally.linked++
        if (around) {
          tally.shouldBreak++
          if (whole.includes(vis)) tally.shouldBreakAndDoesNot++
        }
        if (whole.length === 4) {
          tally.allWhole++
          continue
        }
        const missing = [0, 1, 2, 3].filter(k => !whole.includes(k))
        const onGround = (o: FoundObject) => [...keys(o)].some(x => /^2[4-6],/.test(x))
        const pulled = f.some(onGround) ? missing : []
        const plus = missing.filter(k => f.some(o => keys(o).size === rectOf(k).size + 1 && [...rectOf(k)].every(x => keys(o).has(x)))) // prettier-ignore
        const grown = missing.filter(k => !plus.includes(k) && f.some(o => !onGround(o) && keys(o).size > rectOf(k).size && [...rectOf(k)].every(x => keys(o).has(x)))) // prettier-ignore
        const dropped = missing.filter(
          k => !plus.includes(k) && !grown.includes(k) && !pulled.includes(k),
        )
        if (pulled.length) tally.ground++
        else if (dropped.length) {
          tally.drops++
          tally.platformsMissingInDrops += missing.length
          dropCells.push(`${r},${c}`)
        } else if (grown.length) tally.grows++
        else tally.plusTile++
      }
    expect(tally).toEqual({
      probed: 142, alone: 94, linked: 48, allWhole: 30, plusTile: 6, grows: 4, ground: 4, drops: 4,
      platformsMissingInDrops: 10, shouldBreak: 29, shouldBreakAndDoesNot: 25,
    }) // prettier-ignore
    expect(dropCells).toEqual(['12,10', '20,4', '20,11', '22,4'])
  })
})

describe('a lone edge tile dropped into the body of a platform drawn in front of another', () => {
  it('back 14 x 10, front 3-5 wide and 2-4 tall at (6,4), a tile at each of the 756 back-interior cells outside the front', () => {
    const t = { total: 0, ok: 0, keepBack: 0, lostBoth: 0 }
    for (let fw = 3; fw <= 5; fw++)
      for (let fh = 2; fh <= 4; fh++) {
        const back = plat(2, 2, 14, 10)
        const front = plat(6, 4, fw, fh)
        for (let r = 3; r <= 10; r++)
          for (let c = 3; c <= 14; c++) {
            if (r >= 4 && r < 4 + fh && c >= 6 && c < 6 + fw) continue
            t.total++
            const f = recognizeObjects(stamp([...back, ...front, { x: c, y: r, w: 1, h: 1, tile: WL }], 20, 16), [D]) // prettier-ignore
            const backWhole = f.some(o => same(keys(o), rect(2, 2, 14, 10)))
            const frontWhole = f.some(o => same(keys(o), rect(6, 4, fw, fh)))
            if (backWhole) t.keepBack++
            else if (frontWhole) t.ok++
            else t.lostBoth++
          }
      }
    expect(t).toEqual({ total: 756, ok: 648, keepBack: 84, lostBoth: 24 })
  })
})

describe('a piece that holds fill but changes one visible tile', () => {
  it('is shielded as a whole Object in front: the platform still matches, in 240 of 240 horizontal and 180 of 180 vertical cases', () => {
    const t = { horizontal: 0, horizontalWhole: 0, vertical: 0, verticalWhole: 0 }
    for (let w = 6; w <= 10; w++)
      for (let h = 5; h <= 7; h++) {
        const whole = rect(2, 2, w, h)
        const base = plat(2, 2, w, h)
        const stillWhole = (piece: Piece) => recognizeObjects(stamp([...base, piece], 20, 14), [D]).some(o => same(keys(o), whole)) // prettier-ignore
        // The body is cols 3..w and rows 3..h: the walls (cols 2 and w + 1), the top row (row 2) and the bottom row
        // (row h + 1) are outside it. Along a row: fill, edge,
        // fill, the middle tile changing; down a column the same.
        for (let r = 3; r <= h; r++)
          for (let c = 4; c <= w - 1; c++) {
            t.horizontal++
            if (stillWhole({ x: c - 1, y: r, w: 3, h: 1, tile: (_r: number, cc: number) => (cc === c ? WL : DIRT) })) t.horizontalWhole++ // prettier-ignore
          }
        for (let c = 3; c <= w; c++)
          for (let r = 4; r <= h - 1; r++) {
            t.vertical++
            if (stillWhole({ x: c, y: r - 1, w: 1, h: 3, tile: (rr: number) => (rr === r ? WL : DIRT) })) t.verticalWhole++ // prettier-ignore
          }
      }
    expect(t).toEqual({ horizontal: 240, horizontalWhole: 240, vertical: 180, verticalWhole: 180 })
  })
})

describe('a narrow Object beside a ledge: the rows that close need three columns', () => {
  // A row closes only with edge, fill and edge in it, which needs 3 columns. A 2-wide Object (a pipe, say) never
  // closes, so beside a ledge it still merges at 1 and 2 rows. The exact counts (w 4-8, offsets -1/0/1, 6 orders:
  // 90 cases per height; the Object on the right of the ledge) are pinned; at 3 columns the two stay two.
  const wall = (x: number, y: number, ww: number, h: number, allEdge: boolean): Piece => ({
    x,
    y,
    w: ww,
    h,
    tile: (r: number, c: number) => (allEdge ? (r === y ? (c === x ? TL : TR) : c === x ? WL : WR) : r === y ? (c === x ? TL : c === x + ww - 1 ? TR : FTOP) : c === x ? WL : c === x + ww - 1 ? WR : DIRT), // prettier-ignore
  })
  const merged = (h: number, ww: number, tall: number, allEdge: boolean) => {
    let m = 0
    for (let w = 4; w <= 8; w++)
      for (const dy of [-1, 0, 1])
        for (let n = 0; n < 6; n++) {
          const pieces = shuffled(
            [...plat(2, 4, w, h), wall(2 + w, 4 + dy, ww, tall, allEdge)],
            81 + n,
          )
          if (recognizeObjects(stamp(pieces, 30, 14), [D]).length === 1) m++
        }
    return m
  }
  it('a one-piece Object 2 wide: 30 of 90 merge at 1 row, 90 of 90 at 2 rows; 3 wide: none', () => {
    expect([merged(1, 2, 1, false), merged(2, 2, 2, false), merged(1, 3, 1, false), merged(2, 3, 2, false)]).toEqual([30, 90, 0, 0]) // prettier-ignore
  })
  it('a 2-wide pipe of edge tiles, 2 rows taller than the ledge: 30 of 90 merge at 1 and at 2 rows', () => {
    expect([merged(1, 2, 3, true), merged(2, 2, 4, true)]).toEqual([30, 30])
  })
})
