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
import type { HasGround, SolidH, SolidV } from '../../../../src/rom/model/sprites/MovementBehavior'
import { solidityFromL1 } from '../../../../src/rom/model/sprites/MovementBehavior'

export interface TileDef {
  actsLike: number
  /** When true, every subtile carries the priority bit → treated as decorative passthrough. */
  priority?: boolean
}

export interface Solidity {
  rows: number
  cols: number
  getL1: GetL1Tile
  solidH: SolidH
  solidV: SolidV
  hasGround: HasGround
  /** Raw grid for tests that want to inspect tile ids directly. */
  grid: (number | null)[][]
}

/**
 * Build a solidity fixture from a list of row strings.
 *
 * `defs` maps single characters to tile definitions. An entry with
 * `priority: true` means the tile should be treated as a priority-1
 * decorative cell — the fixture's `getL1` returns `null` for those,
 * matching `SmwMap.renderSpriteOverlays`'s closure.
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
      // Priority-decorative — tagged with `isPriority: true` so the
      // per-predicate solidity logic can decide (passable for walls /
      // hard floors, counts as ground for ledge detection). Matches the
      // SmwMap.renderSpriteOverlays cell emit.
      charToCell.set(ch, { id: nextId++, actsLike: def.actsLike, isPriority: true })
      continue
    }
    charToCell.set(ch, { id: nextId++, actsLike: def.actsLike })
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
  const { solidH, solidV, hasGround } = solidityFromL1(getL1)
  return { rows: rowsN, cols, getL1, solidH, solidV, hasGround, grid }
}
