import type { L1Cell } from '../OverlayContext'
import type { SpriteBehavior } from './SpriteBehavior'

/** Solidity callback - true if the L1 cell at (col, row) blocks horizontal motion. */
export type SolidH = (col: number, row: number) => boolean
/** Solidity callback - true if the L1 cell at (col, row) blocks vertical motion (or is slope ground). */
export type SolidV = (col: number, row: number) => boolean

/**
 * Sim context for movement behaviors: the L1 grid after priority-decorative
 * filtering, plus the spawn and level bounds, for any `MovementBehavior`
 * method that queries tile solidity.
 *
 * Currently unused: the movement-simulation classes that consumed this
 * were deleted in issue #409 (see docs/sprites/sprite-overlay-removal.md's
 * update section). It goes with this file when #418 deletes it.
 */
export interface BehaviorSimContext {
  spawnX: number
  spawnY: number
  solidH: SolidH
  solidV: SolidV
  levelCols: number
  levelRows: number
}

/**
 * Abstract base for sprite movement simulators: a concrete subclass would
 * encode one sprite family's handler - its per-frame physics and the
 * higher-level "where can it go" queries the Appearance draws.
 *
 * Zero classes extend this today. The eleven that did were dead
 * movement-simulation code (no Appearance ever called them) and were
 * deleted in issue #409; see docs/sprites/sprite-overlay-removal.md's
 * update section. Whether this base class is still worth keeping - versus
 * folding its metadata fields into a plain object, the way
 * `BehaviorFactory`'s `default` case already does - is issue #418.
 *
 * If a future subclass does appear: behaviors need methods that close
 * over SMW-specific constants (tables, magic speeds, gravity) without
 * leaking those into every Appearance. The Appearance calls a typed
 * method on the behavior; no `instanceof` juggling at the render site.
 *
 * Subclasses MUST set `kind`. Additional metadata fields (`displayName`,
 * `spawns`, `isGenerator`, `reactRangeDy`) are populated by the factory
 * via constructor or Object.assign.
 */
export abstract class MovementBehavior implements SpriteBehavior {
  abstract readonly kind: string
  displayName?: string
  spawns?: number
  isGenerator?: boolean
  reactRangeDy?: number

  constructor(meta?: BehaviorMeta) {
    if (meta) {
      this.displayName = meta.displayName
      this.spawns = meta.spawns
      this.isGenerator = meta.isGenerator
      this.reactRangeDy = meta.reactRangeDy
    }
  }
}

export interface BehaviorMeta {
  displayName?: string
  spawns?: number
  isGenerator?: boolean
  reactRangeDy?: number
}

/**
 * Convenience adapter: wrap a `GetL1Tile`-style accessor into the pair
 * of solidity callbacks behaviors consume. No production caller; its two
 * predicates duplicate `spriteCollisionFromL1`'s, so it goes with this
 * file when #418 deletes it.
 *
 *   `solidH(c, r)` → does this tile block horizontal motion? (wall)
 *                    Reads `tile.collision.wall` - CODE_01928E port
 *                    (page-0 guard + $11-$6D range).
 *   `solidV(c, r)` → is this tile a sprite-landable surface?
 *                    Reads `tile.collision.floor` - covers CODE_01933B's
 *                    full landing path: hard floors AND slopes $6E-$D7.
 *                    Use for both gravity landing and ledge detection.
 */
export function solidityFromL1(getCell: (col: number, row: number) => L1Cell | null): {
  solidH: SolidH
  solidV: SolidV
} {
  return {
    solidH: (c, r) => {
      const cell = getCell(c, r)
      if (cell === null) return false
      if (cell.isPriority) return false
      return cell.collision?.wall ?? false
    },
    solidV: (c, r) => {
      const cell = getCell(c, r)
      if (cell === null) return false
      if (cell.isPriority) return false
      return cell.collision?.floor ?? false
    },
  }
}
