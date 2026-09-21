/**
 * drawWalls - "Show walls" overlay renderer.
 *
 * Locks the RENDERING behavior: given a tile with its `marioWall` flag
 * already classified, drawWalls must emit the right canvas path
 * operations on the vertical (left / right) faces. Classify-time
 * exclusions (coins, vine, midway, moon, etc.) live in
 * `isMarioStandable` / `marioTileSolidity` and are tested separately
 * in `BlockBehaviorLoader.test.ts` / `TileCollision.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { drawWalls, type WallDrawCtx } from '../../../src/webview/mapEditor/overlays/drawWalls'
import type { SmwMap } from '../../../src/rom/model/SmwMap'
import { NO_COLLISION, type TileCollision } from '../../../src/rom/model/tiles/TileCollision'

type PathOp = { kind: 'move' | 'line'; x: number; y: number }

function makeCtx(): WallDrawCtx & { ops: PathOp[]; strokeCount: number } {
  const ops: PathOp[] = []
  const ctx = {
    strokeStyle: '',
    lineWidth: 0,
    ops,
    strokeCount: 0,
    save() {},
    restore() {},
    beginPath() {},
    moveTo(x: number, y: number) {
      ops.push({ kind: 'move', x, y })
    },
    lineTo(x: number, y: number) {
      ops.push({ kind: 'line', x, y })
    },
    stroke() {
      ctx.strokeCount++
    },
  }
  return ctx
}

function makeMap(l1: (number | null)[][], tileCollisions: Map<number, TileCollision>): SmwMap {
  const l1Tiles = new Map<number, { id: number; collision: TileCollision }>()
  for (const [id, coll] of tileCollisions) l1Tiles.set(id, { id, collision: coll })
  return { l1, l1Tiles } as unknown as SmwMap
}

const WALL: TileCollision = { ...NO_COLLISION, wall: true, marioWall: true }

/**
 * Minimal slope fixture - only `slope` matters for the silhouette rule.
 * Heights are placeholder bytes; drawWalls never reads them.
 */
const SLOPE: TileCollision = {
  ...NO_COLLISION,
  slope: { slopeIndex: 0, heights: new Uint8Array(16) },
}

describe('drawWalls', () => {
  it('draws BOTH vertical edges for a single marioWall cell', () => {
    const map = makeMap([[1]], new Map([[1, WALL]]))
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 0, y: 16 },
      { kind: 'move', x: 16, y: 0 },
      { kind: 'line', x: 16, y: 16 },
    ])
    expect(ctx.strokeCount).toBe(1)
  })

  it('draws nothing for a cell without marioWall', () => {
    const map = makeMap([[1]], new Map([[1, NO_COLLISION]]))
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([])
    expect(ctx.strokeCount).toBe(1)
  })

  it('draws nothing when only the sprite wall flag is set (marioWall false)', () => {
    // Sprite-only wall (e.g. a coin with low byte in $11-$6D that is
    // excluded from Mario set). Mirrors TileFactory output for tiles
    // where isMarioStandable(low) = false.
    const spriteOnly: TileCollision = { ...NO_COLLISION, wall: true }
    const map = makeMap([[1]], new Map([[1, spriteOnly]]))
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([])
  })

  it('suppresses the shared face between two horizontally-adjacent marioWall cells', () => {
    const map = makeMap([[1, 1]], new Map([[1, WALL]]))
    const ctx = makeCtx()
    drawWalls(ctx, map)
    // Left cell: left edge only (no right neighbour check suppresses right).
    // Right cell: right edge only.
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 0, y: 16 },
      { kind: 'move', x: 32, y: 0 },
      { kind: 'line', x: 32, y: 16 },
    ])
  })

  it('draws full L/R edges on each of two vertically-adjacent marioWall cells', () => {
    // Walls are a vertical-axis concept - adjacency in Y does NOT fuse
    // faces. Each cell still exposes its left and right faces.
    const map = makeMap([[1], [1]], new Map([[1, WALL]]))
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([
      // row 0
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 0, y: 16 },
      { kind: 'move', x: 16, y: 0 },
      { kind: 'line', x: 16, y: 16 },
      // row 1
      { kind: 'move', x: 0, y: 16 },
      { kind: 'line', x: 0, y: 32 },
      { kind: 'move', x: 16, y: 16 },
      { kind: 'line', x: 16, y: 32 },
    ])
  })

  it('skips null L1 cells', () => {
    const map = makeMap([[null, 1]], new Map([[1, WALL]]))
    const ctx = makeCtx()
    drawWalls(ctx, map)
    // Only the single wall cell at col 1 draws - both its edges exposed.
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 16, y: 0 },
      { kind: 'line', x: 16, y: 16 },
      { kind: 'move', x: 32, y: 0 },
      { kind: 'line', x: 32, y: 16 },
    ])
  })

  it('skips cells whose tile id is not in l1Tiles', () => {
    const map = makeMap([[99]], new Map([[1, WALL]]))
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([])
  })

  it('returns early for an empty l1 grid', () => {
    const map = makeMap([], new Map())
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([])
    expect(ctx.strokeCount).toBe(0)
  })

  it('draws outward edges at the grid boundary (c=0 left edge, c=cols-1 right edge)', () => {
    // Single-row 1x3 all-wall strip. Left cell has nothing left of it,
    // right cell has nothing right of it. Interior shared faces
    // suppressed.
    const map = makeMap([[1, 1, 1]], new Map([[1, WALL]]))
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 0, y: 16 },
      { kind: 'move', x: 48, y: 0 },
      { kind: 'line', x: 48, y: 16 },
    ])
  })

  it('slope cell itself draws no vertical lines (only suppresses neighbours)', () => {
    // Slopes fall outside the marioWall range ($11-$6D) so the outer
    // `if (!marioWall) continue` skips them. The polyline belongs to
    // drawSurfaces, not drawWalls.
    const map = makeMap([[1]], new Map([[1, SLOPE]]))
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([])
  })

  it('wall cell suppresses its right face when the right neighbour is a slope', () => {
    // Row: [wall, slope]. The wall's right face is covered by the
    // slope's diagonal graphic, so it should not be drawn. The wall's
    // left face still draws (no neighbour there).
    const map = makeMap(
      [[1, 2]],
      new Map([
        [1, WALL],
        [2, SLOPE],
      ]),
    )
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 0, y: 16 },
    ])
  })

  it('wall cell suppresses its left face when the left neighbour is a slope', () => {
    const map = makeMap(
      [[2, 1]],
      new Map([
        [1, WALL],
        [2, SLOPE],
      ]),
    )
    const ctx = makeCtx()
    drawWalls(ctx, map)
    // Only the wall's right face should draw (col 1 right edge at x=32).
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 32, y: 0 },
      { kind: 'line', x: 32, y: 16 },
    ])
  })

  it('row [wall, slope, wall] emits only the outer faces - no stair-step', () => {
    // Reproduces the picture-1 artefact fix. Pre-Phase-3, the left
    // wall's right face and the right wall's left face would each draw
    // a vertical purple line against the slope's surface graphic. With
    // `wallishAt` treating slope cells as wall-covering, both shared
    // faces are suppressed.
    const map = makeMap(
      [[1, 2, 1]],
      new Map([
        [1, WALL],
        [2, SLOPE],
      ]),
    )
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 0, y: 16 },
      { kind: 'move', x: 48, y: 0 },
      { kind: 'line', x: 48, y: 16 },
    ])
  })

  it('switch palace $06B and $16B: passable at default, solid when toggled', () => {
    // Both palace ranges go passable when state[color]=false and
    // solid when true. marioWall set regardless - the overlay strips
    // it via switchPalacePassable(). Uses color 1 (green) like the
    // surfaces test for parity.
    const map = makeMap(
      [[0x06b, 0x16b]],
      new Map([
        [0x06b, WALL],
        [0x16b, WALL],
      ]),
    )

    const ctx1 = makeCtx()
    drawWalls(ctx1, map, [false, false, false, false])
    expect(ctx1.ops).toEqual([])

    const ctx2 = makeCtx()
    drawWalls(ctx2, map, [false, true, false, false]) // green toggled
    // Two adjacent wall cells - left face of left cell, right face of
    // right cell. The interior shared face is suppressed.
    expect(ctx2.ops).toEqual([
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 0, y: 16 },
      { kind: 'move', x: 32, y: 0 },
      { kind: 'line', x: 32, y: 16 },
    ])
  })

  it('clean silhouette of a 3x3 solid mass - left column + right column only', () => {
    const map = makeMap(
      [
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
      new Map([[1, WALL]]),
    )
    const ctx = makeCtx()
    drawWalls(ctx, map)
    const expected: PathOp[] = [
      // row 0: col 0 left face, col 2 right face
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 0, y: 16 },
      { kind: 'move', x: 48, y: 0 },
      { kind: 'line', x: 48, y: 16 },
      // row 1
      { kind: 'move', x: 0, y: 16 },
      { kind: 'line', x: 0, y: 32 },
      { kind: 'move', x: 48, y: 16 },
      { kind: 'line', x: 48, y: 32 },
      // row 2
      { kind: 'move', x: 0, y: 32 },
      { kind: 'line', x: 0, y: 48 },
      { kind: 'move', x: 48, y: 32 },
      { kind: 'line', x: 48, y: 48 },
    ]
    expect(ctx.ops).toEqual(expected)
  })

  it('positions lines per-cell at 16px intervals', () => {
    const map = makeMap(
      [
        [1, null, null],
        [null, null, 1],
      ],
      new Map([[1, WALL]]),
    )
    const ctx = makeCtx()
    drawWalls(ctx, map)
    expect(ctx.ops).toEqual([
      // (0,0): both vertical edges
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 0, y: 16 },
      { kind: 'move', x: 16, y: 0 },
      { kind: 'line', x: 16, y: 16 },
      // (2,1): both vertical edges
      { kind: 'move', x: 32, y: 16 },
      { kind: 'line', x: 32, y: 32 },
      { kind: 'move', x: 48, y: 16 },
      { kind: 'line', x: 48, y: 32 },
    ])
  })
})
