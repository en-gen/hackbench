/**
 * Finding saved Objects on a map (#1237): the recognizer over synthetic maps, no ROM.
 * Acceptance 1-5 and 10 of the issue; the corpus check (8) is ObjectRecognize.corpus.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { recognizeObjects, type FoundObject } from '../../../src/rom/objects/Recognize'
import { def, EMPTY, stamp, visibleOnly, type Piece } from '../support/objectMaps'

const TOP = 1
const LS = 2
const RS = 3
const FILL = 4
const GROUND = def({ edge: [TOP, LS, RS], fill: [FILL] })

/** A hill: a flat top, a slope tile on each side one row down, fill beneath, `h` rows tall. */
function hill(grid: number[][], x0: number, w: number, h: number, y0 = 1): void {
  for (let c = 1; c < w - 1; c++) grid[y0]![x0 + c] = TOP
  for (let r = 1; r < h; r++)
    for (let c = 0; c < w; c++) {
      grid[y0 + r]![x0 + c] = r === 1 && c === 0 ? LS : r === 1 && c === w - 1 ? RS : FILL
    }
}
const blank = (rows = 14, cols = 60) => Array.from({ length: rows }, () => new Array<number>(cols).fill(EMPTY)) // prettier-ignore

describe('acceptance 1: one Object per hill, swept over widths and heights', () => {
  for (let w = 3; w <= 12; w++) {
    for (let h = 2; h <= 9; h++) {
      it(`a ${w} x ${h} hill is one Object, two hills with a gap are two`, () => {
        const one = blank()
        hill(one, 2, w, h)
        const found = recognizeObjects(visibleOnly(one), [GROUND])
        expect(found).toHaveLength(1)
        // Top row (w - 2 tiles) plus h - 1 rows of w: every cell of the hill, no others.
        expect(found[0]!.cells).toHaveLength(w - 2 + (h - 1) * w)
        const two = blank()
        hill(two, 2, w, h)
        hill(two, 2 + w + 1, w, h)
        expect(recognizeObjects(visibleOnly(two), [GROUND])).toHaveLength(2)
      })
    }
  }
})

describe('acceptance 2: the matching rule', () => {
  it('a patch of fill tiles alone is not an Object', () => {
    const g = blank()
    for (let r = 2; r < 6; r++) for (let c = 2; c < 8; c++) g[r]![c] = FILL
    expect(recognizeObjects(visibleOnly(g), [GROUND])).toEqual([])
  })

  it('an edge tile with patch cells on all four sides breaks the match', () => {
    const g = blank()
    for (let r = 2; r < 5; r++) for (let c = 2; c < 5; c++) g[r]![c] = FILL
    g[3]![3] = TOP
    expect(recognizeObjects(visibleOnly(g), [GROUND])).toEqual([])
    g[3]![3] = FILL
    g[2]![2] = TOP
    expect(recognizeObjects(visibleOnly(g), [GROUND])).toHaveLength(1)
  })

  it('fill on the outline still matches', () => {
    const g = blank()
    for (let c = 2; c < 9; c++) g[3]![c] = FILL
    g[3]![2] = LS
    expect(recognizeObjects(visibleOnly(g), [GROUND])).toHaveLength(1)
  })

  it('a definition with no edge tile matches nothing', () => {
    const g = blank()
    g[3]![3] = FILL
    expect(recognizeObjects(visibleOnly(g), [def({ edge: [], fill: [FILL] })])).toEqual([])
  })
})

// Four stacked platforms drawn the way a real level draws them: a left edge, an interior and a right
// edge per platform, an edge cut short where a later platform covers it, interiors running down under
// everything, a ground fill piece under the lot with the same tiles, and the pieces in no platform order.
const [TL, WL, TR, WR, FTOP, DIRT] = [11, 12, 13, 14, 15, 16]
const STACK_DEF = def({ edge: [TL, WL, TR, WR], fill: [FTOP, DIRT] })
const BOTTOM = 23
interface Platform {
  x: number
  y: number
  w: number
  /** Rows the left and right edge pieces are drawn: shorter than the platform where covered. */
  leftRows: number
  rightRows: number
}
const PLATFORMS: Platform[] = [
  { x: 8, y: 9, w: 6, leftRows: 3, rightRows: 15 },
  { x: 5, y: 12, w: 5, leftRows: 4, rightRows: 8 },
  { x: 3, y: 16, w: 5, leftRows: 8, rightRows: 4 },
  { x: 5, y: 20, w: 6, leftRows: 3, rightRows: 4 },
]
/** The three stored pieces of one platform. */
function platformPieces(p: Platform): { left: Piece; mid: Piece; right: Piece } {
  return {
    left: { x: p.x, y: p.y, w: 1, h: p.leftRows, tile: (r: number) => (r === p.y ? TL : WL) },
    mid: { x: p.x + 1, y: p.y, w: p.w - 2, h: BOTTOM - p.y + 1, tile: (r: number) => (r === p.y ? FTOP : DIRT) }, // prettier-ignore
    right: { x: p.x + p.w - 1, y: p.y, w: 1, h: p.rightRows, tile: (r: number) => (r === p.y ? TR : WR) }, // prettier-ignore
  }
}
const GROUND_PIECE: Piece = { x: 1, y: 24, w: 20, h: 3, tile: (r: number) => (r === 24 ? FTOP : DIRT) } // prettier-ignore

/** Pieces in the given order (indexes into platform-major left, mid, right), the ground first as on a real map. */
function stackPieces(order: number[]): Piece[] {
  const all = PLATFORMS.flatMap(p => Object.values(platformPieces(p)))
  return [GROUND_PIECE, ...order.map(i => all[i]!)]
}
const DEFAULT_ORDER = [4, 5, 1, 8, 9, 2, 11, 3, 0, 7, 6, 10]

/** The rectangle a platform covers: its top to the bottom, edge pieces extended over what covers them. */
const rectOf = (p: Platform): Set<string> => {
  const want = new Set<string>()
  for (let r = p.y; r <= BOTTOM; r++) for (let c = p.x; c < p.x + p.w; c++) want.add(`${r},${c}`)
  return want
}
const shapeOf = (f: FoundObject): Set<string> => new Set(f.cells.map(c => `${c.row},${c.col}`))
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(k => b.has(k))
/** The Object that is exactly this platform whole, if there is one. */
const wholeOf = (found: readonly FoundObject[], p: Platform) => found.find(f => sameSet(shapeOf(f), rectOf(p))) // prettier-ignore

/** Four Objects, each exactly one platform whole. */
function expectFourPlatforms(found: readonly FoundObject[]): void {
  if (found.length !== 4) throw new Error(`expected 4 Objects, found ${found.length}`)
  for (const p of PLATFORMS)
    if (!wholeOf(found, p)) throw new Error(`no Object is the whole platform at ${p.x},${p.y}`)
}
describe('acceptance 3: four stacked platforms', () => {
  it('finds all four, each with its whole shape, covered parts included', () => {
    const m = stamp(stackPieces(DEFAULT_ORDER), 40, 28)
    const found = recognizeObjects(m, [STACK_DEF])
    expectFourPlatforms(found)
    // The ground is plain fill with no edge of its own: it is not an Object.
    expect(found.every(f => f.cells.every(c => c.row <= BOTTOM))).toBe(true)
  })

  it('covered cells are marked covered, and every Object still shows something', () => {
    const found = recognizeObjects(stamp(stackPieces(DEFAULT_ORDER), 40, 28), [STACK_DEF])
    const top = wholeOf(found, PLATFORMS[0]!)!
    expect(top.cells.some(c => !c.visible)).toBe(true)
    expect(top.cells.some(c => c.visible)).toBe(true)
    expect(found.every(f => f.cells.some(c => c.visible))).toBe(true)
  })

  it('orders them by their stored pieces, later in the list in front', () => {
    const found = recognizeObjects(stamp(stackPieces(DEFAULT_ORDER), 40, 28), [STACK_DEF])
    const orders = found.map(f => f.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    // Each platform is as far forward as its latest piece (piece 0 is the ground).
    const latest = (k: number) => Math.max(...[0, 1, 2].map(i => 1 + DEFAULT_ORDER.indexOf(k * 3 + i))) // prettier-ignore
    expect(orders).toEqual(PLATFORMS.map((_, k) => latest(k)).sort((a, b) => a - b))
  })

  it('does not depend on the order the pieces are in', () => {
    // Seeded shuffles of the twelve pieces: one fixed order proves little.
    let seed = 12345
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let n = 0; n < 60; n++) {
      const order = [...DEFAULT_ORDER]
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[order[i], order[j]] = [order[j]!, order[i]!]
      }
      const m = stamp(stackPieces(order), 40, 28)
      const found = recognizeObjects(m, [STACK_DEF])
      // A platform every cell of which a later piece covers has nothing to select: it is not offered (N8).
      const shown = PLATFORMS.filter(
        (_, k) =>
        m.owners.some((row, r) => row.some((o, c) => [0, 1, 2].some(i => o === 1 + order.indexOf(k * 3 + i)) && r >= PLATFORMS[k]!.y && c >= PLATFORMS[k]!.x && c < PLATFORMS[k]!.x + PLATFORMS[k]!.w)), // prettier-ignore
      )
      expect(found, order.join()).toHaveLength(shown.length)
      for (const p of shown) expect(wholeOf(found, p), order.join()).toBeDefined()
    }
  })
})

describe('acceptance 4: a changed visible tile breaks the match, and undoing restores it', () => {
  it('on a hill drawn tile by tile', () => {
    const g = blank()
    hill(g, 2, 6, 5)
    expect(recognizeObjects(visibleOnly(g), [GROUND])).toHaveLength(1)
    g[3]![4] = RS // an edge tile now inside the patch
    expect(recognizeObjects(visibleOnly(g), [GROUND])).toHaveLength(0)
    g[3]![4] = FILL // undo
    expect(recognizeObjects(visibleOnly(g), [GROUND])).toHaveLength(1)
  })
})

describe('acceptance 5: another tileset never matches', () => {
  it('the same tile numbers on a map of another tileset find nothing', () => {
    const g = blank()
    hill(g, 2, 6, 4)
    const d = def({ edge: [TOP, LS, RS], fill: [FILL], tileset: 1 })
    expect(recognizeObjects(visibleOnly(g, 0), [d])).toEqual([])
    expect(recognizeObjects(visibleOnly(g, 1), [d])).toHaveLength(1)
  })

  it('two definitions with identical tiles on two tilesets match only on their own', () => {
    const g = blank()
    hill(g, 2, 6, 4)
    const a = def({ id: 'a', edge: [TOP, LS, RS], fill: [FILL], tileset: 0 })
    const b = def({ id: 'b', edge: [TOP, LS, RS], fill: [FILL], tileset: 3 })
    expect(recognizeObjects(visibleOnly(g, 3), [a, b]).map(f => f.definitionId)).toEqual(['b'])
  })
})

describe('acceptance 10: the stored-piece split is what keeps stacked platforms apart', () => {
  it('with the split dropped the stacked platforms merge and acceptance 3 goes red', () => {
    const m = stamp(stackPieces(DEFAULT_ORDER), 40, 28)
    expect(() => expectFourPlatforms(recognizeObjects(m, [STACK_DEF]))).not.toThrow()
    const merged = recognizeObjects(m, [STACK_DEF], { splitPieces: false })
    expect(merged.length).toBeLessThan(4)
    expect(() => expectFourPlatforms(merged)).toThrow()
  })

  it('a visible-only scan of the same map cannot tell them apart either', () => {
    const m = stamp(stackPieces(DEFAULT_ORDER), 40, 28)
    const flat = recognizeObjects(visibleOnly(m.grid), [STACK_DEF])
    expect(() => expectFourPlatforms(flat)).toThrow()
  })
})

// Review round 1 of #1237: the cases the first suite let through.
describe('cut-short edges are extended only under something that covers them (review, major 2)', () => {
  const cellsOf = (f: FoundObject) => new Set(f.cells.map(c => `${c.row},${c.col}`))

  it('a top strip over a wider body does not grow into the sky beside it', () => {
    // Body (fill with slope-like edge corners) rows 3-6, cols 1-7; the top strip row 2, cols 3-5.
    const body: Piece = { x: 1, y: 3, w: 7, h: 4, tile: (r: number, c: number) => (c === 1 || c === 7 ? (r === 3 ? TL : WL) : r === 3 ? FTOP : DIRT) } // prettier-ignore
    const strip: Piece = { x: 3, y: 2, w: 3, h: 1, tile: TL }
    const found = recognizeObjects(stamp([body, strip], 12, 10), [STACK_DEF])
    expect(found).toHaveLength(1)
    const got = cellsOf(found[0]!)
    for (const sky of ['2,1', '2,2', '2,6', '2,7']) expect(got.has(sky), sky).toBe(false)
    expect(got.size).toBe(28 + 3)
  })

  it('a short left edge beside a taller interior does not run down over empty sky', () => {
    const left: Piece = { x: 2, y: 2, w: 1, h: 2, tile: (r: number) => (r === 2 ? TL : WL) }
    const mid: Piece = { x: 3, y: 2, w: 4, h: 5, tile: (r: number) => (r === 2 ? FTOP : DIRT) }
    const found = recognizeObjects(stamp([left, mid], 12, 10), [STACK_DEF])
    expect(found).toHaveLength(1)
    expect(found[0]!.cells).toHaveLength(2 + 20)
    expect(found[0]!.cells.every(c => !(c.col === 2 && c.row >= 4))).toBe(true)
  })

  it('does still extend under a piece that covers the edge', () => {
    const left: Piece = { x: 2, y: 2, w: 1, h: 2, tile: (r: number) => (r === 2 ? TL : WL) }
    const mid: Piece = { x: 3, y: 2, w: 4, h: 5, tile: (r: number) => (r === 2 ? FTOP : DIRT) }
    const cover: Piece = { x: 0, y: 4, w: 4, h: 3, tile: 1 } // some other Object's tiles over the missing edge
    const found = recognizeObjects(stamp([left, mid, cover], 12, 10), [STACK_DEF])
    expect(found).toHaveLength(1)
    expect(found[0]!.cells).toHaveLength(5 + 20)
  })
})

/** One platform as three stored pieces, in every order the sweeps ask for. */
function platformOf(x: number, y: number, w: number, h: number) {
  return {
    left: { x, y, w: 1, h, tile: (r: number) => (r === y ? TL : WL) } as Piece,
    mid: { x: x + 1, y, w: w - 2, h, tile: (r: number) => (r === y ? FTOP : DIRT) } as Piece,
    right: { x: x + w - 1, y, w: 1, h, tile: (r: number) => (r === y ? TR : WR) } as Piece,
  }
}
const ORDERS: ('left' | 'mid' | 'right')[][] = [
  ['left', 'mid', 'right'],
  ['left', 'right', 'mid'],
  ['mid', 'left', 'right'],
  ['mid', 'right', 'left'],
  ['right', 'left', 'mid'],
  ['right', 'mid', 'left'],
]
const rect = (x: number, y: number, w: number, h: number) =>
  new Set(Array.from({ length: w * h }, (_, i) => `${y + Math.floor(i / w)},${x + (i % w)}`))
const cellKeys = (f: FoundObject) => new Set(f.cells.map(c => `${c.row},${c.col}`))
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(k => b.has(k))

// The fixes of review rounds 1 and 2. Every case is built with `stamp`, so the footprint, owners and grid
// agree, as on a real map; the platform is 5-9 wide and 3-6 tall, its pieces in all six orders.
describe('a broken match leaves no fragments (review, major 3 and A)', () => {
  for (let w = 5; w <= 9; w++)
    for (let h = 3; h <= 6; h++)
      it(`${w} x ${h}: a piece that writes an edge tile inside its own body breaks the whole platform, in every piece order`, () => {
        // prettier-ignore
        for (const order of ORDERS) {
          const parts = platformOf(2, 2, w, h)
          const mid = { ...parts.mid, tile: (r: number, c: number) => (r === 3 && c === 4 ? WL : (parts.mid.tile as (r: number) => number)(r)) } as Piece // prettier-ignore
          const pieces = order.map(k => (k === 'mid' ? mid : parts[k]))
          const found = recognizeObjects(stamp(pieces, 14, 12), [STACK_DEF])
          const inside = found.flatMap(f => f.cells).filter(c => c.row >= 2 && c.row < 2 + h && c.col >= 2 && c.col < 2 + w) // prettier-ignore
          expect(inside, order.join()).toEqual([])
        }
      })

  for (let w = 5; w <= 9; w++)
    for (let h = 3; h <= 6; h++)
      it(`${w} x ${h}: a later fill piece over that edge tile mends it, and the platform is one whole Object`, () => {
        // prettier-ignore
        for (const order of ORDERS) {
          const parts = platformOf(2, 2, w, h)
          const mid = { ...parts.mid, tile: (r: number, c: number) => (r === 3 && c === 4 ? WL : (parts.mid.tile as (r: number) => number)(r)) } as Piece // prettier-ignore
          const mend: Piece = { x: 4, y: 3, w: 1, h: 1, tile: DIRT }
          const pieces = [...order.map(k => (k === 'mid' ? mid : parts[k])), mend]
          const found = recognizeObjects(stamp(pieces, 14, 12), [STACK_DEF])
          expect(found, order.join()).toHaveLength(1)
          expect(same(cellKeys(found[0]!), rect(2, 2, w, h)), order.join()).toBe(true)
        }
      })
})

describe('acceptance 4 through a real edit: a later piece that makes a visible tile disagree (review, major B)', () => {
  for (let w = 5; w <= 9; w++)
    for (let h = 3; h <= 6; h++)
      it(`${w} x ${h}: appending an edge tile inside the body stops the match; removing it brings the whole Object back`, () => {
        // prettier-ignore
        for (const order of ORDERS) {
          const parts = platformOf(2, 2, w, h)
          const base = order.map(k => parts[k])
          const before = recognizeObjects(stamp(base, 14, 12), [STACK_DEF])
          expect(before, order.join()).toHaveLength(1)
          expect(same(cellKeys(before[0]!), rect(2, 2, w, h))).toBe(true)
          const edit: Piece = { x: 4, y: 3, w: 1, h: 1, tile: WL }
          const after = recognizeObjects(stamp([...base, edit], 14, 12), [STACK_DEF])
          // Nothing of the platform is offered; only the lone edge tile, by the ordinary rule.
          expect(after.flatMap(f => f.cells).filter(c => !(c.row === 3 && c.col === 4)), order.join()).toEqual([]) // prettier-ignore
          expect(recognizeObjects(stamp(base, 14, 12), [STACK_DEF])).toEqual(before)
        }
      })
})

describe('single-piece and fill cases (review, minors 7 and 8)', () => {
  for (let n = 4; n <= 8; n++)
    it(`${n} x ${n}: one stored piece with an edge tile surrounded by its own cells is not an Object`, () => {
      const piece: Piece = { x: 1, y: 1, w: n, h: n, tile: (r: number, c: number) => (r === 1 || (r === n - 1 && c === n - 1) ? TL : DIRT) } // prettier-ignore
      expect(recognizeObjects(stamp([piece], 14, 14), [STACK_DEF])).toEqual([])
    })

  for (let w = 3; w <= 7; w++)
    for (let ground = 1; ground <= 4; ground++)
      it(`fill beside fill is not part of an Object: ${w} wide ground, ${ground} rows, under a one-row platform`, () => {
        // Ground only under the interior, so it touches the interior along its whole length and no edge tile.
        const width = w + 2
        const left: Piece = { x: 2, y: 2, w: 1, h: 1, tile: TL }
        const mid: Piece = { x: 3, y: 2, w, h: 1, tile: FTOP }
        const right: Piece = { x: 3 + w, y: 2, w: 1, h: 1, tile: TR }
        const under: Piece = { x: 3, y: 3, w, h: ground, tile: DIRT }
        for (const order of [
          [under, left, mid, right],
          [left, mid, right, under],
          [mid, under, right, left],
        ]) {
          const found = recognizeObjects(stamp(order, width + 6, 10), [STACK_DEF])
          expect(found).toHaveLength(1)
          expect(found[0]!.cells).toHaveLength(w + 2)
        }
      })
})

describe('cut-short edges through sweeps (review, major 2, E and H)', () => {
  // The left edge piece is `edgeRows` tall beside an interior `bodyRows` tall; what is under the missing
  // rows decides whether the edge is extended. Sizes and both sides are swept.
  for (let bodyRows = 3; bodyRows <= 7; bodyRows++)
    for (let edgeRows = 1; edgeRows < bodyRows; edgeRows++)
      for (const side of ['low', 'high'] as const)
        it(`${side} side: an edge ${edgeRows} tall beside a body ${bodyRows} tall grows only under a covering piece`, () => {
          const top = 4
          const y = side === 'high' ? top : top + (bodyRows - edgeRows)
          const left: Piece = { x: 2, y, w: 1, h: edgeRows, tile: (r: number) => (r === top ? TL : WL) } // prettier-ignore
          const mid: Piece = { x: 3, y: top, w: 4, h: bodyRows, tile: (r: number) => (r === top ? FTOP : DIRT) } // prettier-ignore
          // The missing rows of column 2: empty sky first.
          const missing = bodyRows - edgeRows
          const sky = recognizeObjects(stamp([mid, left], 12, 14), [STACK_DEF])
          expect(sky).toHaveLength(1)
          expect(sky[0]!.cells).toHaveLength(4 * bodyRows + edgeRows)
          // Then something else drawn over exactly the missing rows: the edge runs under it.
          const lo = side === 'high' ? top + edgeRows : top
          const cover: Piece = { x: 0, y: lo, w: 3, h: missing, tile: 1 }
          const covered = recognizeObjects(stamp([mid, left, cover], 12, 14), [STACK_DEF])
          expect(covered).toHaveLength(1)
          expect(covered[0]!.cells).toHaveLength(4 * bodyRows + bodyRows)
        })

  it('stops at a cell the group itself owns, so a gap in the edge is not bridged', () => {
    const left: Piece = { x: 2, y: 2, w: 1, h: 2, tile: (r: number) => (r === 2 ? TL : WL) }
    const mid: Piece = { x: 3, y: 2, w: 4, h: 6, tile: (r: number) => (r === 2 ? FTOP : DIRT) }
    const own: Piece = { x: 2, y: 4, w: 1, h: 1, tile: DIRT } // a fill cell of the same Object in the column
    const cover: Piece = { x: 2, y: 5, w: 1, h: 3, tile: 1 } // something else under it
    const found = recognizeObjects(stamp([mid, left, own, cover], 12, 14), [STACK_DEF])
    expect(found).toHaveLength(1)
    expect(found[0]!.cells.some(c => c.col === 2 && c.row >= 5)).toBe(false)
  })
})
