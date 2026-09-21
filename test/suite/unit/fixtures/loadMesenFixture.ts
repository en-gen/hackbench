/**
 * Load a stitched Mesen Map16 fixture (`map16.txt`) and build a Solidity
 * compatible with the bounce/walk simulators.
 *
 * Format (one row per line, see tools/scripts/stitch_map16_dumps.py):
 *
 *   r##: hex hex . . hex ???
 *
 * - Each cell is a 3-character hex Map16 tile id (low byte $00-$FF, high
 *   byte $0-$1).
 * - `.` means cell is empty (air).
 * - `???` means the auto-walker never observed this column (treat as null
 *   so simulators stop on any contact with the unobserved area instead of
 *   inferring it as solid).
 *
 * Fixture cells use the Map16 tile ID itself as `actsLike` - for vanilla
 * SMW levels, page-1 tiles ($100+) are mostly self-acts-like, and the
 * collision range checks (low byte) are what drives sprite physics.
 * Tilesets that remap acts-like via `readActsLikeTable` would need a ROM
 * read to be exact, which is out of scope for unit tests.
 */

import { readFileSync } from 'node:fs'
import type { GetL1Tile, L1Cell } from '../../../../src/rom/model/OverlayContext'
import type { SolidH, SolidV } from '../../../../src/rom/model/sprites/MovementBehavior'
import { solidityFromL1 } from '../../../../src/rom/model/sprites/MovementBehavior'
import { NO_COLLISION } from '../../../../src/rom/model/tiles/TileCollision'
import type { TileCollision } from '../../../../src/rom/model/tiles/TileCollision'
import type { SlopeInfo } from '../../../../src/rom/SlopeResolver'

/**
 * Mirror of TileFactory.classify's sprite-side fields, without the ROM
 * lookups (block-behavior table, slope-tables, Mario dispatch). Slope
 * tiles get a synthetic flat `heights` array - landing tests that need
 * accurate slope angle should use a ROM-backed fixture instead.
 */
function classifyForFixture(actsLike: number): TileCollision {
  const low = actsLike & 0xff
  const high = (actsLike >> 8) & 0xff
  if (high === 0) return NO_COLLISION
  const inSolidRange = low >= 0x11 && low <= 0x6d
  const inSlopeRange = low >= 0x6e && low <= 0xd7
  const wall = inSolidRange
  const floor = low <= 0x10 || inSolidRange || inSlopeRange || low >= 0xd8
  const ceiling = inSolidRange
  const slopeTable = inSlopeRange
  // Synthetic flat slope (heights all 0 → surface at top of tile). The
  // slope-glitch test only needs `slope` to be present so the apex y-snap
  // path runs; precise pixel landing is covered by ROM-backed tests.
  const slope: SlopeInfo | undefined = inSlopeRange
    ? { slopeIndex: 0, heights: new Uint8Array(16) }
    : undefined
  return {
    wall,
    floor,
    ceiling,
    slopeTable,
    marioFloor: false,
    marioCeiling: false,
    marioWall: false,
    ...(slope ? { slope } : {}),
  }
}

export interface MesenSolidity {
  rows: number
  cols: number
  getL1: GetL1Tile
  solidH: SolidH
  solidV: SolidV
  /** Raw grid for tests that want to inspect tile ids directly. `null` = air or unobserved. */
  grid: (number | null)[][]
}

export interface MesenFixtureOptions {
  /**
   * Columns whose every cell should be reported with `isPriority: true`.
   * Mesen dumps don't capture Map16 priority bits (those live in the ROM's
   * Map16 table, not in the live tile-number RAM the walker reads), so
   * tests that exercise priority-driven behavior pass the affected columns
   * in here. The level $11E forest decoration runs in vertical columns
   * (e.g. c35/c40/c45 - the leaf-and-trunk pillars), so column-granular
   * priority overrides are sufficient for those cases.
   */
  priorityCols?: ReadonlySet<number>
}

export function loadMesenFixture(path: string, opts: MesenFixtureOptions = {}): MesenSolidity {
  const priorityCols = opts.priorityCols ?? new Set<number>()
  const text = readFileSync(path, 'utf8')
  const grid: (number | null)[][] = []
  let maxRow = -1
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.startsWith('r')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const rowNum = parseInt(line.slice(1, colon).trim(), 10)
    if (Number.isNaN(rowNum)) continue
    const tokens = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
    const cells = tokens.map(t => {
      if (t === '.' || t === '???') return null
      const n = parseInt(t, 16)
      return Number.isNaN(n) ? null : n
    })
    grid[rowNum] = cells
    if (rowNum > maxRow) maxRow = rowNum
  }
  for (let r = 0; r <= maxRow; r++) {
    if (!grid[r]) grid[r] = []
  }
  const rows = grid.length
  const cols = Math.max(0, ...grid.map(r => r?.length ?? 0))

  // Two cell variants per tile id: priority and non-priority. Cells in a
  // column listed in `priorityCols` get the `isPriority: true` variant so
  // tests can simulate ROM priority bits that the Mesen dump doesn't carry.
  const plainCache = new Map<number, L1Cell>()
  const priorityCache = new Map<number, L1Cell>()
  const cellFor = (id: number, isPriority: boolean): L1Cell => {
    const cache = isPriority ? priorityCache : plainCache
    let cell = cache.get(id)
    if (!cell) {
      cell = { id, actsLike: id, isPriority, collision: classifyForFixture(id) }
      cache.set(id, cell)
    }
    return cell
  }

  const getL1: GetL1Tile = (c, r) => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return null
    const id = grid[r]?.[c]
    if (id === null || id === undefined) return null
    return cellFor(id, priorityCols.has(c))
  }
  const { solidH, solidV } = solidityFromL1(getL1)
  return { rows, cols, getL1, solidH, solidV, grid }
}
