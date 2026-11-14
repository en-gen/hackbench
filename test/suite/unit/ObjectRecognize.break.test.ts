/**
 * Breaking, touching and mending Objects through stored pieces (#1237 review rounds 2 and 3, rule R).
 * Every map is built with `stamp`, so the footprint, owners and grid agree, as on a real map; a "change" is
 * a piece added, and an "undo" is the same map without it.
 */
import { describe, it, expect } from 'vitest'
import { recognizeObjects, type FoundObject } from '../../../src/rom/objects/Recognize'
import { describeObjects } from '../../../src/rom/objects/Describe'
import { buildOutline } from '../../../src/rom/objects/Outline'
import { def, stamp, type Piece } from '../support/objectMaps'

const [TL, WL, TR, WR, FTOP, DIRT] = [11, 12, 13, 14, 15, 16]
const D = def({ edge: [TL, WL, TR, WR], fill: [FTOP, DIRT] })

/** A platform of three pieces: left edge, interior, right edge, each `h` tall. */
function plat(x: number, y: number, w: number, h: number): Piece[] {
  return [
    { x, y, w: 1, h, tile: (r: number) => (r === y ? TL : WL) },
    { x: x + 1, y, w: w - 2, h, tile: (r: number) => (r === y ? FTOP : DIRT) },
    { x: x + w - 1, y, w: 1, h, tile: (r: number) => (r === y ? TR : WR) },
  ]
}
const rectKeys = (x: number, y: number, w: number, h: number) =>
  new Set(Array.from({ length: w * h }, (_, i) => `${y + Math.floor(i / w)},${x + (i % w)}`))
const keys = (f: FoundObject) => new Set(f.cells.map(c => `${c.row},${c.col}`))
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(k => b.has(k))
const cellsOutside = (found: FoundObject[], inside: Set<string>) =>
  found.flatMap(f => f.cells).filter(c => inside.has(`${c.row},${c.col}`))

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

describe('touching Objects stay two (stored pieces keep them apart)', () => {
  // Side by side, no overlap, edge beside edge: the walls pair up only if nothing says they belong to different
  // Objects, and two whole platforms (each with an edge and a fill piece) do say it, at every height.
  for (let w = 4; w <= 8; w++)
    for (let h = 1; h <= 5; h++)
      for (const dy of [-1, 0, 1])
        it(`${w} x ${h}, second platform ${dy} rows off: two Objects, in 6 piece orders`, () => {
          for (let n = 0; n < 6; n++) {
            const pieces = shuffled([...plat(2, 4, w, h), ...plat(2 + w, 4 + dy, w, h)], 7 + n)
            const found = recognizeObjects(stamp(pieces, 30, 14), [D])
            expect(found, `order ${n}`).toHaveLength(2)
            expect(found.map(f => f.cells.length).sort()).toEqual([w * h, w * h])
          }
        })

  // One platform above another, the same width or one tile off, meets it wall on wall and fill on fill: that is
  // not side by side, so nothing refuses the link (it is how a ledge and the continuation of its walls stay one
  // Object). With bodies 3 rows or more the merged walls are surrounded and the two stay apart; with 1 or 2 rows
  // they merge. The exact counts, for w 4-8, dx -1/0/1 and 6 orders (90 cases per height), are pinned.
  const ONE_OBJECT: Record<number, number> = { 1: 90, 2: 90, 3: 0, 4: 0, 5: 0 }
  for (let h = 1; h <= 5; h++)
    it(`one platform above another, ${h} tall: ${ONE_OBJECT[h]} of 90 cases merge into one Object`, () => {
      let merged = 0
      for (let w = 4; w <= 8; w++)
        for (const dx of [-1, 0, 1])
          for (let n = 0; n < 6; n++) {
            const pieces = shuffled([...plat(3, 4, w, h), ...plat(3 + dx, 4 + h, w, h)], 7 + n)
            const found = recognizeObjects(stamp(pieces, 30, 20), [D])
            if (found.length === 1) merged++
            else expect(found).toHaveLength(2)
          }
      expect(merged).toBe(ONE_OBJECT[h])
    })
})

describe('any visible edge tile with the body on all four sides stops the match', () => {
  const X = 2
  const Y = 2
  for (let w = 5; w <= 9; w++)
    for (let h = 4; h <= 6; h++) {
      const base = plat(X, Y, w, h)
      const whole = rectKeys(X, Y, w, h)
      const platformOnly = (f: FoundObject[]) => f.filter(o => same(keys(o), whole))
      it(`${w} x ${h}: a column of edge tiles through the body breaks it, whatever its length; undo restores it`, () => {
        const before = recognizeObjects(stamp(base, 16, 12), [D])
        expect(platformOnly(before)).toHaveLength(1)
        for (let len = 1; len <= h - 2; len++) {
          const edit: Piece = { x: X + 2, y: Y + 1, w: 1, h: len, tile: WL }
          const after = recognizeObjects(stamp([...base, edit], 16, 12), [D])
          // Only the edit's own cells are offered, as an Object of their own.
          expect(cellsOutside(after, whole).filter(c => !(c.col === X + 2 && c.row >= Y + 1 && c.row < Y + 1 + len)), `len ${len}`).toEqual([]) // prettier-ignore
          expect(after.every(f => f.cells.length <= len)).toBe(true)
          // Undo: the map built again from scratch without the piece is the map before, and the edit did change it.
          expect(after).not.toEqual(before)
          expect(recognizeObjects(stamp(plat(X, Y, w, h), 16, 12), [D])).toEqual(before)
        }
      })

      it(`${w} x ${h}: a row of edge tiles through the body breaks it`, () => {
        const edit: Piece = { x: X + 2, y: Y + 1, w: w - 4, h: 1, tile: WL }
        const after = recognizeObjects(stamp([...base, edit], 16, 12), [D])
        expect(platformOnly(after)).toEqual([])
        expect(after.every(f => f.cells.length <= w - 4)).toBe(true)
      })

      it(`${w} x ${h}: a column of edge tiles that ends on the bottom outline still breaks it (one tile of it is surrounded)`, () => {
        const edit: Piece = { x: X + 2, y: Y + h - 2, w: 1, h: 2, tile: WL }
        const after = recognizeObjects(stamp([...base, edit], 16, 12), [D])
        expect(platformOnly(after)).toEqual([])
        expect(after.every(f => f.cells.length <= 2)).toBe(true)
        expect(recognizeObjects(stamp(base, 16, 12), [D])).toHaveLength(1)
      })

      it(`${w} x ${h}: an edge tile on the bottom outline does not break it`, () => {
        const edit: Piece = { x: X + 2, y: Y + h - 1, w: 1, h: 1, tile: WL }
        const after = recognizeObjects(stamp([...base, edit], 16, 12), [D])
        expect(platformOnly(after)).toHaveLength(1)
      })

      it(`${w} x ${h}: a piece that starts inside the body and runs out through the wall into the sky breaks it`, () => {
        const edit: Piece = { x: X + w - 2, y: Y + 1, w: 2, h: 1, tile: WL }
        const after = recognizeObjects(stamp([...base, edit], 16, 12), [D])
        expect(platformOnly(after)).toEqual([])
      })
    }
})

describe('a lone edge tile dropped into the four-platform stack breaks only the platform directly behind it', () => {
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
  const rectOf = (k: number) => rectKeys(PL[k]!.x, PL[k]!.y, PL[k]!.w, 24 - PL[k]!.y)
  const isWhole = (f: FoundObject[], k: number) => f.some(o => same(keys(o), rectOf(k)))

  it('every definition cell of the stack, one at a time', () => {
    const m0 = stamp(base, 40, 28)
    const before = recognizeObjects(m0, [D])
    expect(before).toHaveLength(4)
    const bad: string[] = []
    let probed = 0
    let alone = 0
    for (let r = 9; r <= 23; r++)
      for (let c = 3; c <= 13; c++) {
        if (![TL, WL, TR, WR, FTOP, DIRT].includes(m0.grid[r]![c]!)) continue
        probed++
        const m = stamp([...base, { x: c, y: r, w: 1, h: 1, tile: WL }], 40, 28)
        const found = recognizeObjects(m, [D])
        // The tile stays a lone Object of one cell, or it links to an edge it touches and joins that platform.
        const lone = found.some(
          o => o.cells.length === 1 && o.cells[0]!.row === r && o.cells[0]!.col === c,
        )
        if (lone) alone++
        // The platform that shows the cell now, and whether the cell and its four sides are all in its shape.
        const owner = m0.owners[r]![c]!
        const vis = owner <= 0 ? -1 : Math.floor(ORDER[owner - 1]! / 3)
        const around = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].every(([dr, dc]) => vis >= 0 && rectOf(vis).has(`${r + dr!},${c + dc!}`)) // prettier-ignore
        const want = [0, 1, 2, 3].map(k => !(around && k === vis))
        const got = [0, 1, 2, 3].map(k => isWhole(found, k))
        if (lone && want.join() !== got.join())
          bad.push(`${r},${c}: want ${want.join()} got ${got.join()}`)
        // And the platforms that stay keep the order they had.
        if (lone)
          for (const k of [0, 1, 2, 3].filter(k => want[k] && got[k])) {
            const was = before.find(o => same(keys(o), rectOf(k)))!
            const now = found.find(o => same(keys(o), rectOf(k)))!
            if (was.order !== now.order)
              bad.push(`${r},${c}: platform ${k} order ${was.order} -> ${now.order}`)
          }
      }
    // Only where the tile stays alone is the oracle exact; where it links into a neighbor's edge it is that
    // platform's edge tile and nothing is lost (see the round 3 report for the count).
    console.info(`stack sweep: ${probed} cells, the tile stays alone in ${alone}`)
    // At least the 94 cells where the tile stays alone (48 more link into a neighbor: see the known limit).
    expect(alone).toBeGreaterThanOrEqual(94)
    expect(probed).toBe(142)
    expect(bad).toEqual([])
  })
})

describe('an Object in front with fill of its own is not a disagreement; edge tiles alone are', () => {
  for (let bw = 8; bw <= 12; bw += 2)
    for (let bh = 6; bh <= 9; bh += 3)
      for (let fh = 2; fh <= 3; fh++) {
        const back = plat(2, 2, bw, bh)
        const whole = rectKeys(2, 2, bw, bh)
        it(`back ${bw} x ${bh}, front ${fh} tall: 2 wide (edges only) breaks the back one, 3 wide (with fill) leaves it`, () => {
          const front2 = plat(5, 4, 2, fh).filter((_, i) => i !== 1) // left and right only
          const two = recognizeObjects(stamp([...back, ...front2], 20, 14), [D])
          expect(two.filter(o => same(keys(o), whole))).toEqual([])
          const three = recognizeObjects(stamp([...back, ...plat(5, 4, 3, fh)], 20, 14), [D])
          expect(three.filter(o => same(keys(o), whole))).toHaveLength(1)
          expect(three).toHaveLength(2)
          expect(three.map(o => o.cells.length).sort((a, b) => a - b)).toEqual([3 * fh, bw * bh])
        })
      }
})

describe('twin Objects with identical cells have different keys, whatever order they are listed in', () => {
  // Two Objects with the same cells can both be listed (each shows a different cell of them); the stored pieces
  // that make them tell them apart. They cannot come from one stamped map (the later would hide the earlier).
  for (let w = 2; w <= 6; w++)
    for (let h = 1; h <= 3; h++)
      it(`${w} x ${h} cells, pieces [3] and [5]`, () => {
        const cells = Array.from({ length: w * h }, (_, i) => ({ row: 2 + Math.floor(i / w), col: 2 + (i % w), tile: TL, visible: true })) // prettier-ignore
        const a: FoundObject = { definitionId: 'd', name: 'G', order: 3, cells, pieces: [3] }
        const b: FoundObject = { definitionId: 'd', name: 'G', order: 5, cells, pieces: [5] }
        const keyOf = (list: FoundObject[]) => new Map(describeObjects(list, () => null).map((d, i) => [list[i]!.pieces.join(), d.key])) // prettier-ignore
        const ab = keyOf([a, b])
        expect(new Set(ab.values()).size).toBe(2)
        expect(keyOf([b, a])).toEqual(ab)
      })
})

describe('mending: identical visible grids give identical Objects', () => {
  for (let w = 5; w <= 8; w++)
    for (let h = 4; h <= 6; h++)
      it(`${w} x ${h}: a mended platform equals the clean one, and a strip below it stays out`, () => {
        const parts = plat(2, 2, w, h)
        const mid = parts[1]!
        const bad: Piece = { ...mid, tile: (r: number, c: number) => (r === 3 && c === 4 ? WL : (mid.tile as (r: number) => number)(r)) } // prettier-ignore
        const strip: Piece = { x: 4, y: 3, w: 1, h: h + 4, tile: DIRT } // runs on below the platform
        const mended = recognizeObjects(stamp([parts[0]!, bad, parts[2]!, strip], 16, 16), [D])
        const clean = recognizeObjects(stamp([...parts, strip], 16, 16), [D])
        expect(mended).toHaveLength(1)
        expect(clean).toHaveLength(1)
        expect(same(keys(mended[0]!), keys(clean[0]!))).toBe(true)
        expect(mended[0]!.cells).toHaveLength(w * h)
      })
})

describe('an Object nothing of which shows is not offered', () => {
  for (let w = 5; w <= 8; w++) {
    it(`${w} wide: a lone edge tile covered again by fill is gone from the list`, () => {
      const parts = plat(2, 2, w, 4)
      const lone: Piece = { x: 4, y: 5, w: 1, h: 1, tile: WL } // on the bottom outline: a valid Object of its own
      const cover: Piece = { x: 4, y: 5, w: 1, h: 1, tile: DIRT }
      expect(recognizeObjects(stamp([...parts, lone], 16, 12), [D])).toHaveLength(2)
      const hidden = recognizeObjects(stamp([...parts, lone, cover], 16, 12), [D])
      expect(hidden).toHaveLength(1)
      expect(hidden.every(f => f.cells.some(c => c.visible))).toBe(true)
    })

    it(`${w} wide: the same tile covered by a tile that is not in the definition leaves one Object, not a hidden second`, () => {
      const parts = plat(2, 2, w, 4)
      const lone: Piece = { x: 4, y: 5, w: 1, h: 1, tile: WL }
      const cover: Piece = { x: 4, y: 5, w: 1, h: 1, tile: 0x99 }
      const hidden = recognizeObjects(stamp([...parts, lone, cover], 16, 12), [D])
      expect(hidden).toHaveLength(1)
      expect(hidden[0]!.cells.every(c => !(c.row === 5 && c.col === 4 && c.visible))).toBe(true)
      expect(hidden.every(f => f.cells.some(c => c.visible))).toBe(true)
    })
  }
})

describe('a ledge drawn in two parts, one under the other, stays one Object', () => {
  // The first part is a whole ledge (top row, walls, fill); the second is a continuation: the same walls and
  // fill with no top row. Their walls meet edge on edge above and below, and the grid is identical to one tall
  // ledge. The wall link stays whole whenever it covers half of the smaller part (a part 1 or 2 rows tall);
  // between two parts 3 rows tall or more it does not, and they are two Objects.
  for (let w = 3; w <= 7; w++)
    for (let h1 = 1; h1 <= 4; h1++)
      for (let h2 = 1; h2 <= 4; h2++)
        it(`${w} wide, parts ${h1} and ${h2} rows: ${h1 >= 3 && h2 >= 3 ? 'two Objects' : 'one Object'}, in 6 piece orders`, () => {
          const first = plat(2, 2, w, h1)
          const below = 2 + h1
          const rest: Piece[] = [
            { x: 2, y: below, w: 1, h: h2, tile: WL },
            { x: 3, y: below, w: w - 2, h: h2, tile: DIRT },
            { x: 1 + w, y: below, w: 1, h: h2, tile: WR },
          ]
          const tall = stamp(plat(2, 2, w, h1 + h2), 14, 14)
          for (let n = 0; n < 6; n++) {
            const m = stamp(shuffled([...first, ...rest], 11 + n), 14, 14)
            expect(m.grid, 'the grid is that of one tall ledge').toEqual(tall.grid)
            const found = recognizeObjects(m, [D])
            if (h1 >= 3 && h2 >= 3) expect(found, `order ${n}`).toHaveLength(2)
            else {
              expect(found, `order ${n}`).toHaveLength(1)
              expect(found[0]!.cells).toHaveLength(w * (h1 + h2))
            }
          }
        })
})

describe('a lone edge tile beside a whole Object joins it', () => {
  for (let w = 4; w <= 8; w++)
    for (let h = 1; h <= 5; h++)
      for (const row of ['top', 'bottom'] as const)
        it(`${w} x ${h}: a tile left of the ${row} row of the left wall is part of the one Object`, () => {
          const y = 4
          const tile: Piece = {
            x: 1,
            y: row === 'top' ? y : y + h - 1,
            w: 1,
            h: 1,
            tile: row === 'top' ? TL : WL,
          }
          // Listed after the platform and before it: either group may be the first of the link.
          for (const pieces of [
            [...plat(2, y, w, h), tile],
            [tile, ...plat(2, y, w, h)],
          ]) {
            const found = recognizeObjects(stamp(pieces, 14, 14), [D])
            expect(found).toHaveLength(1)
            expect(found[0]!.cells).toHaveLength(w * h + 1)
          }
        })
})

describe('undoing an edit', () => {
  for (let w = 5; w <= 8; w++)
    for (let h = 4; h <= 6; h++)
      it(`${w} x ${h}: the map with the breaking piece taken out of the map that had it is the map before; leaving it in is not`, () => {
        const base = plat(2, 2, w, h)
        const edit: Piece = { x: 4, y: 3, w: 1, h: 1, tile: WL }
        const before = recognizeObjects(stamp(base, 16, 12), [D])
        const edited = [...base, edit]
        expect(recognizeObjects(stamp(edited, 16, 12), [D])).not.toEqual(before)
        const undone = edited.filter(p => p !== edit)
        expect(recognizeObjects(stamp(undone, 16, 12), [D])).toEqual(before)
        // A planted undo that leaves the piece in, or only changes its tile to another edge tile, stays broken.
        expect(recognizeObjects(stamp([...base, { ...edit, tile: WR }], 16, 12), [D])).not.toEqual(
          before,
        )
      })
})

describe('mending by a fill strip, swept', () => {
  // A strip links when its contact with an edge piece beside it covers half of the smaller piece (a post one
  // tile long beside the strip's last row does; a longer post touching one cell of it does not).
  for (let w = 5; w <= 8; w++)
    for (let h = 4; h <= 6; h++)
      it(`${w} x ${h}: a strip over the stray tile mends it; a one-tile post beside the strip below the platform makes it a linked piece, and the stray tile breaks the platform`, () => {
        const parts = plat(2, 2, w, h)
        const mid = parts[1]!
        const bad: Piece = { ...mid, tile: (r: number, c: number) => (r === 3 && c === 4 ? WL : (mid.tile as (r: number) => number)(r)) } // prettier-ignore
        const strip: Piece = { x: 4, y: 3, w: 1, h: h + 3, tile: DIRT }
        const post: Piece = { x: 5, y: 2 + h + 1, w: 1, h: 1, tile: WL }
        const cleanLinked = recognizeObjects(stamp([...parts, strip, post], 16, 16), [D])
        const mendedLinked = recognizeObjects(
          stamp([parts[0]!, bad, parts[2]!, strip, post], 16, 16),
          [D],
        )
        const whole = rectKeys(2, 2, w, h)
        expect(cleanLinked.some(f => same(keys(f), whole))).toBe(true)
        expect(mendedLinked.some(f => same(keys(f), whole))).toBe(false)
        const cleanFree = recognizeObjects(stamp([...parts, strip], 16, 16), [D])
        const mendedFree = recognizeObjects(stamp([parts[0]!, bad, parts[2]!, strip], 16, 16), [D])
        expect(mendedFree.map(f => keys(f).size)).toEqual(cleanFree.map(f => keys(f).size))
      })
})

describe('a slope tile of one run, swept', () => {
  const cell = (row: number, col: number, tile: number) => ({ row, col, tile, visible: true })
  for (let n = 3; n <= 7; n++)
    for (let i = 1; i < n - 1; i++)
      it(`a slope tile at ${i} of ${n} in a flat top row is one slope segment of its own top, 16 px long`, () => {
        const cells = Array.from({ length: n }, (_, c) => cell(0, c, c === i ? 9 : 1))
        for (let c = 0; c < n; c++) cells.push(cell(1, c, 4))
        const slope = buildOutline(cells, t => (t === 9 ? 1 : null)).segments.filter(
          s => s.kind === 'slope',
        )
        expect(slope).toHaveLength(1)
        expect(slope[0]!.points).toEqual([i * 16, 0, (i + 1) * 16, 0])
      })
})

describe('a broken Object beside a whole one costs only itself', () => {
  for (const side of ['left', 'right'] as const)
    for (let w = 5; w <= 7; w++)
      for (let h = 3; h <= 5; h++)
        it(`${side}, ${w} x ${h}: the platform with a stray edge tile in its body is gone, its neighbor is whole`, () => {
          const A = plat(2, 2, w, h)
          const mid = A[1]!
          const bad: Piece = { ...mid, tile: (r: number, c: number) => (r === 3 && c === 4 ? WL : (mid.tile as (r: number) => number)(r)) } // prettier-ignore
          const B = plat(2 + w, 2, w, h)
          const pieces = side === 'left' ? [A[0]!, bad, A[2]!, ...B] : [...B, A[0]!, bad, A[2]!]
          const found = recognizeObjects(stamp(pieces, 24, 12), [D])
          expect(found).toHaveLength(1)
          expect(same(keys(found[0]!), rectKeys(2 + w, 2, w, h))).toBe(true)
        })
})
