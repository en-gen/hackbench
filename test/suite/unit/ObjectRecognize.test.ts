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
  { x: 5, y: 12, w: 5, leftRows: 3, rightRows: 8 },
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
      const found = recognizeObjects(stamp(stackPieces(order), 40, 28), [STACK_DEF])
      expect(found, order.join()).toHaveLength(4)
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

  it('on a platform found through its stored pieces', () => {
    const m = stamp(stackPieces(DEFAULT_ORDER), 40, 28)
    const before = recognizeObjects(m, [STACK_DEF])
    expect(before).toHaveLength(4)
    // A visible interior cell of the front platform (row 21, written by its own interior piece).
    const cell = m.grid[21]![7]!
    expect(m.owners[21]![7]).toBeGreaterThanOrEqual(0)
    m.grid[21]![7] = WL
    const broken = recognizeObjects(m, [STACK_DEF])
    // The front platform no longer matches; the three behind it still do, whole.
    expect(wholeOf(broken, PLATFORMS[3]!)).toBeUndefined()
    expect(PLATFORMS.slice(0, 3).every(p => wholeOf(broken, p))).toBe(true)
    m.grid[21]![7] = cell
    expect(recognizeObjects(m, [STACK_DEF])).toEqual(before)
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
