/**
 * drawSurfaces — "Show surfaces" overlay renderer.
 *
 * These tests lock the RENDERING behavior: given a tile with specific
 * Mario-collision fields already classified, drawSurfaces must emit the
 * right canvas path operations. The classify-time exclusion logic
 * (climbables, coins, spike, midway, checkpoint decoration, moon)
 * lives in `isMarioStandable` in `BlockBehaviorLoader.ts` and is
 * tested separately in `BlockBehaviorLoader.test.ts`. Tests here use
 * `marioFloor` / `marioCeiling` directly in fixtures.
 */

import { describe, expect, it } from 'vitest'
import { drawSurfaces, type SurfaceDrawCtx } from '../../../src/webview/mapEditor/overlays/drawSurfaces'
import type { SmwMap } from '../../../src/rom/model/SmwMap'
import { NO_COLLISION, type TileCollision } from '../../../src/rom/model/tiles/TileCollision'

type PathOp = { kind: 'move' | 'line'; x: number; y: number }

function makeCtx(): SurfaceDrawCtx & { ops: PathOp[]; strokeCount: number } {
  const ops: PathOp[] = []
  const ctx = {
    strokeStyle: '',
    lineWidth:   0,
    ops,
    strokeCount: 0,
    save()  {},
    restore() {},
    beginPath() {},
    moveTo(x: number, y: number) { ops.push({ kind: 'move', x, y }) },
    lineTo(x: number, y: number) { ops.push({ kind: 'line', x, y }) },
    stroke() { ctx.strokeCount++ },
  }
  return ctx
}

function makeMap(
  l1: (number | null)[][],
  tileCollisions: Map<number, TileCollision>,
): SmwMap {
  // Minimal duck-typed SmwMap — drawSurfaces only touches l1 + l1Tiles.
  // Each tile carries the id and its collision; drawSurfaces reads
  // `tile.id` for the switch-palace check and `tile.collision.mario*`
  // for rendering decisions.
  const l1Tiles = new Map<number, { id: number; collision: TileCollision }>()
  for (const [id, coll] of tileCollisions) l1Tiles.set(id, { id, collision: coll })
  return { l1, l1Tiles } as unknown as SmwMap
}

const FLOOR:         TileCollision = { ...NO_COLLISION, floor: true, marioFloor: true }
const CEILING:       TileCollision = { ...NO_COLLISION, ceiling: true, marioCeiling: true }
const FLOOR_CEILING: TileCollision = {
  ...NO_COLLISION,
  floor: true, ceiling: true,
  marioFloor: true, marioCeiling: true,
}

describe('drawSurfaces', () => {
  it('draws a line along the TOP edge for a marioFloor cell', () => {
    const map = makeMap([[1]], new Map([[1, FLOOR]]))
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0,  y: 0 },
      { kind: 'line', x: 16, y: 0 },
    ])
    expect(ctx.strokeCount).toBe(1)
  })

  it('draws a line along the BOTTOM edge for a marioCeiling cell', () => {
    const map = makeMap([[1]], new Map([[1, CEILING]]))
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0,  y: 16 },
      { kind: 'line', x: 16, y: 16 },
    ])
  })

  it('draws BOTH edges for a cell that is marioFloor AND marioCeiling', () => {
    const map = makeMap([[1]], new Map([[1, FLOOR_CEILING]]))
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0,  y: 0 },
      { kind: 'line', x: 16, y: 0 },
      { kind: 'move', x: 0,  y: 16 },
      { kind: 'line', x: 16, y: 16 },
    ])
  })

  it('draws nothing for a cell with neither mario flag', () => {
    const map = makeMap([[1]], new Map([[1, NO_COLLISION]]))
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([])
    expect(ctx.strokeCount).toBe(1) // beginPath/stroke still called — empty path is a no-op
  })

  it('draws nothing when only sprite flags are set (marioFloor false)', () => {
    // Sprite-only floor (e.g. a tile excluded from Mario set like a
    // climbable or coin) should NOT draw. Mirrors what TileFactory
    // produces for tiles with isMarioStandable(low) = false.
    const spriteOnly: TileCollision = { ...NO_COLLISION, floor: true, ceiling: true }
    const map = makeMap([[1]], new Map([[1, spriteOnly]]))
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([])
  })

  it('skips null L1 cells', () => {
    const map = makeMap([[null, 1]], new Map([[1, FLOOR]]))
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 16, y: 0 },
      { kind: 'line', x: 32, y: 0 },
    ])
  })

  it('skips cells whose tile id is not in l1Tiles', () => {
    const map = makeMap([[99]], new Map([[1, FLOOR]]))
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([])
  })

  it('positions lines per-cell at 16px intervals', () => {
    const map = makeMap(
      [
        [1, null, null],
        [null, null, 1],
      ],
      new Map([[1, FLOOR]]),
    )
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0,  y: 0 },
      { kind: 'line', x: 16, y: 0 },
      { kind: 'move', x: 32, y: 16 },
      { kind: 'line', x: 48, y: 16 },
    ])
  })

  it('returns early for an empty l1 grid', () => {
    const map = makeMap([], new Map())
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([])
    expect(ctx.strokeCount).toBe(0)
  })

  it('suppresses the floor line when the cell directly above is also a marioFloor', () => {
    // Vertical stack of 3 marioFloor cells. Only the topmost (row 0)
    // draws. Interior and bottom have marioFloor above.
    const map = makeMap(
      [[1], [1], [1]],
      new Map([[1, FLOOR]]),
    )
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0,  y: 0 },
      { kind: 'line', x: 16, y: 0 },
    ])
  })

  it('suppresses the ceiling line when the cell directly below is also a marioCeiling', () => {
    const map = makeMap(
      [[1], [1], [1]],
      new Map([[1, CEILING]]),
    )
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0,  y: 48 },
      { kind: 'line', x: 16, y: 48 },
    ])
  })

  it('draws floor line when the cell above has marioFloor=false', () => {
    // row 0 is ceiling-only (marioFloor=false), row 1 is floor-only.
    // row 1 should draw since row 0 isn't a marioFloor.
    const map = makeMap(
      [[2], [1]],
      new Map([
        [1, FLOOR],
        [2, CEILING],
      ]),
    )
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    expect(ctx.ops).toEqual([
      // row 0 ceiling: draws bottom edge (row 1 has marioCeiling=false)
      { kind: 'move', x: 0,  y: 16 },
      { kind: 'line', x: 16, y: 16 },
      // row 1 floor: draws top edge (row 0 has marioFloor=false)
      { kind: 'move', x: 0,  y: 16 },
      { kind: 'line', x: 16, y: 16 },
    ])
  })

  it('switch palace $06B and $16B: passable at default, solid when toggled', () => {
    // Both tile-ID ranges go passable when palace state is false and
    // solid when true. marioFloor set regardless — the overlay layer
    // strips it via switchPalacePassable().
    const map = makeMap(
      [[0x06B, 0x16B]],
      new Map([
        [0x06B, FLOOR],
        [0x16B, FLOOR],
      ]),
    )

    const ctx1 = makeCtx()
    drawSurfaces(ctx1, map, [false, false, false, false])
    expect(ctx1.ops).toEqual([])

    const ctx2 = makeCtx()
    drawSurfaces(ctx2, map, [false, true, false, false]) // green toggled
    expect(ctx2.ops).toEqual([
      { kind: 'move', x: 0,  y: 0 },
      { kind: 'line', x: 16, y: 0 },
      { kind: 'move', x: 16, y: 0 },
      { kind: 'line', x: 32, y: 0 },
    ])
  })

  it('clean silhouette of a 3x3 solid mass — top row + bottom row only', () => {
    const map = makeMap(
      [
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
      new Map([[1, FLOOR_CEILING]]),
    )
    const ctx = makeCtx()
    drawSurfaces(ctx, map)
    const expected: PathOp[] = [
      { kind: 'move', x: 0,  y: 0 },  { kind: 'line', x: 16, y: 0 },
      { kind: 'move', x: 16, y: 0 },  { kind: 'line', x: 32, y: 0 },
      { kind: 'move', x: 32, y: 0 },  { kind: 'line', x: 48, y: 0 },
      { kind: 'move', x: 0,  y: 48 }, { kind: 'line', x: 16, y: 48 },
      { kind: 'move', x: 16, y: 48 }, { kind: 'line', x: 32, y: 48 },
      { kind: 'move', x: 32, y: 48 }, { kind: 'line', x: 48, y: 48 },
    ]
    expect(ctx.ops).toEqual(expected)
  })
})
