import type { L1Cell } from '../OverlayContext'
import { isActsLikeGround, isActsLikeHorizSolid, isActsLikeVertSolid } from '../OverlayContext'
import type { SpriteBehavior } from './SpriteBehavior'

/** Solidity callback — true if the L1 cell at (col, row) blocks horizontal motion. */
export type SolidH = (col: number, row: number) => boolean
/** Solidity callback — true if the L1 cell at (col, row) blocks vertical motion. */
export type SolidV = (col: number, row: number) => boolean
/**
 * Standability callback — true if the L1 cell at (col, row) is walkable
 * ground (flat solid OR slope OR solid-from-above). Broader than
 * `solidV`; used by patrol / ledge-detection overlays to decide where a
 * sprite's surface ENDS. See `isActsLikeGround` in `OverlayContext.ts`
 * for the range derivation (matches `CODE_01933B` classification).
 *
 * Shared across every sprite that needs floor/wall/ledge knowledge:
 * ground-walkers, platform-following AI, fall-arc endpoints.
 */
export type HasGround = (col: number, row: number) => boolean

/**
 * Sim context passed to movement behaviors. Produced by `SmwMap.renderSpriteOverlays`
 * from the L1 grid (after priority-decorative filtering) and forwarded by the
 * Appearance into any `MovementBehavior` method that needs to query tile
 * solidity — e.g. `computePatrolRange`, `simulateBounds`, `computeBounceArc`.
 */
export interface BehaviorSimContext {
  spawnX:    number
  spawnY:    number
  solidH:    SolidH
  solidV:    SolidV
  hasGround: HasGround
  levelCols: number
  levelRows: number
}

/**
 * Abstract base for sprite movement simulators. Each concrete subclass
 * encodes one sprite family's handler — its per-frame physics and the
 * higher-level "where can it go" queries the Appearance draws.
 *
 * Why a class and not a plain object: behaviors need methods that close
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
  displayName?:  string
  spawns?:       number
  isGenerator?:  boolean
  reactRangeDy?: number

  constructor(meta?: BehaviorMeta) {
    if (meta) {
      this.displayName  = meta.displayName
      this.spawns       = meta.spawns
      this.isGenerator  = meta.isGenerator
      this.reactRangeDy = meta.reactRangeDy
    }
  }
}

export interface BehaviorMeta {
  displayName?:  string
  spawns?:       number
  isGenerator?:  boolean
  reactRangeDy?: number
}

/**
 * Convenience adapter: wrap a `GetL1Tile`-style accessor into the triple
 * of solidity callbacks behaviors consume. Appearances call this in
 * `renderOverlay` to produce the callbacks their Behavior needs.
 *
 * The three predicates are used for three different questions, and mixing
 * them up produces visibly wrong overlays — use the one that matches the
 * question being asked:
 *
 *   `solidH(c, r)`    → does this tile block horizontal motion? (wall)
 *                       `CODE_01928E`, actsLike $11-$6D. Use for wall checks.
 *   `solidV(c, r)`    → does this tile block vertical motion?   (hard floor)
 *                       `CODE_0192C9`, actsLike $11-$6D + tileset $C4-$C9.
 *                       Use for landing / ceiling-bonk physics.
 *   `hasGround(c, r)` → is this tile walkable ground? (floor, INCL slopes)
 *                       `CODE_01933B` classification, actsLike $11+. Use
 *                       for ledge detection — where the walkable surface
 *                       ENDS. A slope is ground; a ledge is missing ground.
 */
export function solidityFromL1(
  getCell: (col: number, row: number) => L1Cell | null,
): { solidH: SolidH; solidV: SolidV; hasGround: HasGround } {
  return {
    // Walls — `CODE_01928E` port. Priority-deco cells pass through walls
    // visually. Otherwise read the pre-computed `collision.sideSolid`
    // from the tile loader; test fixtures without a collision
    // classification fall back to the acts-like range check.
    solidH: (c, r) => {
      const cell = getCell(c, r)
      if (cell === null) return false
      if (cell.isPriority) return false
      if (cell.collision !== undefined) return cell.collision.wall
      return isActsLikeHorizSolid(cell.actsLike)
    },
    // Vertical solid — LANDING path (CODE_01933B via CODE_0192C9 Y=2).
    // This is the common overlay question: "can a sprite stand on
    // this tile?". Semi-solid platforms (<$11) and mushroom-platform
    // surfaces register here. Consumers asking about CEILING BONK
    // semantics should read `cell.collision.ceiling` directly.
    solidV: (c, r) => {
      const cell = getCell(c, r)
      if (cell === null) return false
      if (cell.isPriority) return false
      if (cell.collision !== undefined) return cell.collision.floor
      return isActsLikeVertSolid(cell.actsLike)
    },
    // Walkable ground for ledge detection — `floor` (landing path,
    // CODE_01933B) OR slope-table membership (CODE_00F04D via
    // DATA_00EAC1). Slope tiles route through slope-angle dispatch
    // instead of the uniform solid check. Priority-deco cells count
    // as ground visually — the sprite sits on top of foreground
    // decoration in the editor view.
    hasGround: (c, r) => {
      const cell = getCell(c, r)
      if (cell === null) return false
      if (cell.isPriority) return true
      if (cell.collision !== undefined) {
        return cell.collision.floor || cell.collision.slopeTable
      }
      return isActsLikeGround(cell.actsLike)
    },
  }
}
