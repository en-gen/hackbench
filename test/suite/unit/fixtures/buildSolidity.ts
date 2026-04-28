/**
 * Synthetic L1 solidity fixture for MovementBehavior tests.
 *
 * Tests don't need (and shouldn't rely on) ROM bytes to exercise movement
 * physics — the behaviors consume `solidH`/`solidV` callbacks that only
 * care about per-column-row truthiness. This helper turns string-grid maps
 * into those callbacks plus a `GetL1Tile` closure for behaviors that need
 * cell metadata (e.g. priority-decorative check).
 *
 * Grid legend (per-test; callers pass their own `defs`):
 *   '.'   air
 *   '#'   solid ground (acts-like $30, default)
 *   'W'   wall (acts-like $30)
 *   'K'   sprite anchor (air)
 *   'G'   priority-1 decorative (grass) — passthrough
 *   etc.
 *
 * Any character absent from `defs` is treated as air.
 */

import type { GetL1Tile, L1Cell } from '../../../../src/rom/model/OverlayContext'
import type { SolidH, SolidV } from '../../../../src/rom/model/sprites/MovementBehavior'
import { solidityFromL1 } from '../../../../src/rom/model/sprites/MovementBehavior'
import type { SpriteCollision } from '../../../../src/rom/model/sprites/SpriteCollision'
import { spriteCollisionFromL1 } from '../../../../src/rom/model/sprites/SpriteCollision'
import { NO_COLLISION } from '../../../../src/rom/model/tiles/TileCollision'
import type { TileCollision } from '../../../../src/rom/model/tiles/TileCollision'

export interface TileDef {
  actsLike: number
  /** When true, every subtile carries the priority bit → treated as decorative passthrough. */
  priority?: boolean
}

/**
 * Compute sprite-side TileCollision booleans from an actsLike value using
 * the same page-0 guard and range rules as TileFactory.classify.
 * No block-behavior table or slope profile — fixture tiles represent
 * idealized solid/passthrough cases.
 */
function classifyForFixture(actsLike: number): TileCollision {
  const low  = actsLike & 0xFF
  const high = (actsLike >> 8) & 0xFF
  if (high === 0) return NO_COLLISION
  const inSolidRange = low >= 0x11 && low <= 0x6D
  const inSlopeRange = low >= 0x6E && low <= 0xD7
  const wall       = inSolidRange
  const floor      = low <= 0x10 || inSolidRange || inSlopeRange || low >= 0xD8
  const ceiling    = inSolidRange
  const slopeTable = inSlopeRange
  return { wall, floor, ceiling, slopeTable, marioFloor: false, marioCeiling: false, marioWall: false }
}

export interface Solidity {
  rows: number
  cols: number
  getL1: GetL1Tile
  solidH: SolidH
  solidV: SolidV
  /** Full SpriteCollision bundle — all six priority-filtered predicates. */
  collision: SpriteCollision
  /** Raw grid for tests that want to inspect tile ids directly. */
  grid: (number | null)[][]
}

/**
 * Build a solidity fixture from a list of row strings.
 *
 * `defs` maps single characters to tile definitions. An entry with
 * `priority: true` means the tile should be treated as a priority-1
 * decorative cell — returned as a non-null cell with `isPriority: true`
 * and `NO_COLLISION`, so predicates can apply the priority short-circuit.
 *
 * Default char '.' = air (no entry needed). All rows must be the same length.
 */
export function buildSolidity(
  rows: string[],
  defs: Record<string, TileDef> = {},
): Solidity {
  const grid: (number | null)[][] = []
  const charToCell = new Map<string, L1Cell | null>()
  // Ensure space and '.' always resolve to null.
  charToCell.set('.', null)
  charToCell.set(' ', null)
  let nextId = 0x100
  for (const [ch, def] of Object.entries(defs)) {
    if (def.priority) {
      // Priority-decorative — tagged with `isPriority: true` so
      // solidH/solidV short-circuit to false (passable) regardless of
      // actsLike. Equivalent to SmwMap returning null for these tiles.
      charToCell.set(ch, { id: nextId++, actsLike: def.actsLike, isPriority: true, collision: NO_COLLISION })
      continue
    }
    charToCell.set(ch, { id: nextId++, actsLike: def.actsLike, collision: classifyForFixture(def.actsLike) })
  }
  for (const row of rows) {
    grid.push([...row].map(ch => {
      if (!charToCell.has(ch) && defs[ch] === undefined) return null
      const cell = charToCell.get(ch)
      return cell ? cell.id : null
    }))
  }
  const cols = rows[0]?.length ?? 0
  const rowsN = rows.length

  const getL1: GetL1Tile = (c, r) => {
    if (r < 0 || r >= rowsN || c < 0 || c >= cols) return null
    const ch = rows[r][c]
    return charToCell.get(ch) ?? null
  }
  const { solidH, solidV } = solidityFromL1(getL1)
  const collision = spriteCollisionFromL1(getL1)
  return { rows: rowsN, cols, getL1, solidH, solidV, collision, grid }
}
