import type { GetL1Tile } from '../OverlayContext'
import type { SlopeInfo } from '../../SlopeResolver'

/**
 * Priority-filtered sprite collision predicates, all built from a single
 * `GetL1Tile` accessor.  Use `spriteCollisionFromL1(getL1)` to produce this
 * bundle; do not implement the methods inline in individual behaviors.
 *
 * Every method silently returns false / undefined for priority-1 decorative
 * cells (`cell.isPriority === true`) because those tiles render in front of
 * sprites and pass through collision at runtime.
 *
 * Port mapping:
 *   solidH    → CODE_01928E  (bank_01.asm:2613)
 *   solidV    → CODE_01933B  (bank_01.asm:2705)  full landing path
 *   ceilingV  → CODE_0192C9 Y=3  (bank_01.asm:2659-2668)
 *
 * No production caller today. Kept as the sprite-perspective input for a
 * sprite view of the collision overlays being ported in #435.
 */
export interface SpriteCollision {
  solidH(c: number, r: number): boolean
  solidV(c: number, r: number): boolean
  /** Ceiling-bonk predicate.  Slope range $6E–$D7 has ceiling=false - using
   *  solidV here instead would snap an ascending sprite down below a rising
   *  slope (the cause of the level-$006 Para-Goomba glitch, fixed in PR #228). */
  ceilingV(c: number, r: number): boolean
  /** Slope profile if the cell is a non-priority slope tile, else undefined. */
  slopeAt(c: number, r: number): SlopeInfo | undefined
  /**
   * Pixel Y of the tile surface at a given centerX and tile row.
   * Slope tiles return `row*16 + heights[pxInTile] & 0x0F`; all other
   * cells (including air) return the flat tile top `row*16`.
   */
  surfaceYAt(centerX: number, row: number): number
  /**
   * Scan downward from `startRow` for the first row where `solidV` or a
   * non-priority slope tile is present.  Returns null if none found within
   * `levelRows`.  No production caller today; see
   * docs/sprites/sprite-overlay-removal.md's update section.
   */
  findFloorRowBelow(col: number, startRow: number, levelRows: number): number | null
}

export function spriteCollisionFromL1(getL1: GetL1Tile): SpriteCollision {
  function solidH(c: number, r: number): boolean {
    const cell = getL1(c, r)
    if (cell === null || cell.isPriority) return false
    return cell.collision?.wall ?? false
  }

  function solidV(c: number, r: number): boolean {
    const cell = getL1(c, r)
    if (cell === null || cell.isPriority) return false
    return cell.collision?.floor ?? false
  }

  function ceilingV(c: number, r: number): boolean {
    const cell = getL1(c, r)
    if (cell === null || cell.isPriority) return false
    return cell.collision?.ceiling ?? false
  }

  function slopeAt(c: number, r: number): SlopeInfo | undefined {
    const cell = getL1(c, r)
    if (cell === null || cell.isPriority) return undefined
    return cell.collision?.slope
  }

  function surfaceYAt(centerX: number, row: number): number {
    const col = Math.floor(centerX / 16)
    const pxInTile = Math.max(0, Math.min(15, Math.floor(centerX) - col * 16))
    const slope = slopeAt(col, row)
    return slope ? row * 16 + (slope.heights[pxInTile]! & 0x0f) : row * 16
  }

  function findFloorRowBelow(col: number, startRow: number, levelRows: number): number | null {
    for (let r = startRow; r < levelRows; r++) {
      if (solidV(col, r)) return r
      if (slopeAt(col, r)) return r
    }
    return null
  }

  return { solidH, solidV, ceilingV, slopeAt, surfaceYAt, findFloorRowBelow }
}
