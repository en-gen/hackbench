/**
 * Reproduce the level $11E koopa $05 patrol-corridor collapse with
 * synthetic L1 cells that set `isPriority` on candidate tile positions.
 *
 * The fixture-driven test (KoopaWalkBehavior.fixture.test.ts) passes,
 * because `loadMesenFixture` doesn't carry priority info — so the
 * regression must come from priority-driven filtering of the platform
 * layout. This file explicitly toggles `isPriority` on each plausible
 * tile and asserts that the corridor stays wide regardless.
 *
 * Layout (matches $11E around the koopa at c41 r24):
 *
 *   c39 c40 c41 c42
 *   ---------------
 *   r23  .   T   .   .       T = trunk (page 0)
 *   r24  .   T   K   .       K = koopa
 *   r25  P   M   E   .       P = platform left edge ($15F)
 *   r26  D   T   D   .       M = platform middle ($10D)
 *                            E = platform right edge ($15E)
 *                            D = lower platform tile
 */
import { describe, expect, it } from 'vitest'
import type { GetL1Tile, L1Cell } from '../../../src/rom/model/OverlayContext'
import { solidityFromL1 } from '../../../src/rom/model/sprites/MovementBehavior'
import { KoopaWalkBehavior, propsFromSpriteId } from '../../../src/rom/model/sprites/behaviors/KoopaWalkBehavior'

const TILE = 16

interface CellSpec {
  actsLike: number
  priority?: boolean
}

function buildGrid(cells: Map<string, CellSpec>): {
  getL1: GetL1Tile
  solidH: ReturnType<typeof solidityFromL1>['solidH']
  solidV: ReturnType<typeof solidityFromL1>['solidV']
  cols: number
  rows: number
} {
  const cols = 50
  const rows = 30
  const getL1: GetL1Tile = (c, r) => {
    if (c < 0 || c >= cols || r < 0 || r >= rows) return null
    const spec = cells.get(`${c},${r}`)
    if (!spec) return null
    const low  = spec.actsLike & 0xFF
    const high = (spec.actsLike >> 8) & 0xFF
    const isPage0 = high === 0
    const inSolidRange = !isPage0 && low >= 0x11 && low <= 0x6D
    const inSlopeRange = !isPage0 && low >= 0x6E && low <= 0xD7
    const cell: L1Cell = {
      id: spec.actsLike,
      actsLike: spec.actsLike,
      isPriority: spec.priority ?? false,
      collision: {
        floor:        !isPage0 && (low <= 0x10 || inSolidRange || inSlopeRange || low >= 0xD8),
        wall:         inSolidRange,
        ceiling:      inSolidRange,
        marioFloor:   false,
        marioCeiling: false,
        marioWall:    false,
        slopeTable:   inSlopeRange,
      },
    }
    return cell
  }
  const { solidH, solidV } = solidityFromL1(getL1)
  return { getL1, solidH, solidV, cols, rows }
}

function placeKoopaPlatform(prioritySet: Partial<{
  trunkR23: boolean; trunkR24: boolean
  platformLeft: boolean; platformMiddle: boolean; platformRight: boolean
  underLeft: boolean; underTrunk: boolean; underRight: boolean
}>) {
  const cells = new Map<string, CellSpec>()
  // Trunk column at c40 (page-0 decorative trunk)
  cells.set('40,23', { actsLike: 0x0BD, priority: prioritySet.trunkR23 })
  cells.set('40,24', { actsLike: 0x0BE, priority: prioritySet.trunkR24 })
  // Platform top at r25
  cells.set('39,25', { actsLike: 0x15F, priority: prioritySet.platformLeft })   // left edge
  cells.set('40,25', { actsLike: 0x10D, priority: prioritySet.platformMiddle }) // middle
  cells.set('41,25', { actsLike: 0x15E, priority: prioritySet.platformRight })  // right edge
  // Lower platform at r26
  cells.set('39,26', { actsLike: 0x160, priority: prioritySet.underLeft })
  cells.set('40,26', { actsLike: 0x0BE, priority: prioritySet.underTrunk })
  cells.set('41,26', { actsLike: 0x15D, priority: prioritySet.underRight })
  return buildGrid(cells)
}

function corridor(prioritySet: Parameters<typeof placeKoopaPlatform>[0]) {
  const grid = placeKoopaPlatform(prioritySet)
  const beh = new KoopaWalkBehavior(propsFromSpriteId(0x05))
  const r = beh.computePatrolRange(
    41 * TILE, 24 * TILE, grid.solidH, grid.solidV, grid.cols, grid.rows, grid.getL1,
  )
  return { leftX: r.leftX, rightX: r.rightX, leftKind: r.leftKind, rightKind: r.rightKind }
}

describe('KoopaWalkBehavior — $11E priority-bit reproductions', () => {
  it('baseline: no priority anywhere → corridor c39..c42 left edges', () => {
    const r = corridor({})
    expect(r.leftX).toBe(39 * TILE)
    expect(r.rightX).toBe(42 * TILE)
    expect(r.leftKind).toBe('turnLedge')
    expect(r.rightKind).toBe('turnLedge')
  })

  it('platform RIGHT edge tile priority ($15E) → starts from r26, corridor must NOT collapse', () => {
    const r = corridor({ platformRight: true })
    expect(r.leftX, 'left boundary should still reach c39').toBe(39 * TILE)
    expect(r.rightX, 'right boundary should still reach c42').toBe(42 * TILE)
  })

  it('platform MIDDLE tile priority ($10D) → koopa must still walk left across c40', () => {
    const r = corridor({ platformMiddle: true })
    expect(r.leftX).toBe(39 * TILE)
    expect(r.rightX).toBe(42 * TILE)
  })

  it('platform LEFT edge tile priority ($15F) → corridor must reach c39', () => {
    const r = corridor({ platformLeft: true })
    expect(r.leftX).toBe(39 * TILE)
    expect(r.rightX).toBe(42 * TILE)
  })

  it('all platform tiles priority → corridor must NOT collapse to a single tile', () => {
    const r = corridor({ platformLeft: true, platformMiddle: true, platformRight: true })
    // The bug surfaces here as leftX=42*TILE / rightX=42*TILE (or similar collapse).
    expect(r.leftX).toBe(39 * TILE)
    expect(r.rightX).toBe(42 * TILE)
  })

  it('trunk priority + middle platform priority (the $11E suspected combo)', () => {
    const r = corridor({
      trunkR23: true, trunkR24: true, underTrunk: true,
      platformMiddle: true,
    })
    expect(r.leftX).toBe(39 * TILE)
    expect(r.rightX).toBe(42 * TILE)
  })
})
