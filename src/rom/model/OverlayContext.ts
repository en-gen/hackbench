/**
 * Minimal Canvas2D drawing interface used by sprite appearances to render
 * geometric overlays (patrol corridors, detection zones, jump arcs etc.).
 *
 * Defined in the model layer as a plain TypeScript interface so appearance
 * classes in src/rom/ can type-check without importing the browser's
 * CanvasRenderingContext2D DOM type, which is absent in the extension-host
 * compilation that also processes src/rom/**. CanvasRenderingContext2D
 * satisfies this interface structurally; pass it with an explicit
 * `as unknown as OverlayContext` cast at the webview call site.
 */
export interface OverlayContext {
  fillStyle:   string | OverlayGradient
  strokeStyle: string | OverlayGradient
  lineWidth:   number
  save():    void
  restore(): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  fill():   void
  setLineDash(segments: readonly number[]): void
  fillRect  (x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  ellipse(
    cx: number, cy: number,
    rx: number, ry: number,
    rotation: number,
    startAngle: number, endAngle: number,
  ): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): OverlayGradient
}

/**
 * Structural mirror of CanvasGradient — only `addColorStop` is used by
 * overlays. The returned value can be assigned to `fillStyle`/`strokeStyle`,
 * which is why they're typed as `string` in the main interface (the
 * browser accepts both strings and CanvasGradient there).
 */
export interface OverlayGradient {
  addColorStop(offset: number, color: string): void
}

import type { TileCollision } from './tiles/TileCollision'

/**
 * Lightweight view of an L1 cell — the Map16 id plus its acts-like value.
 * Overlays check `actsLike` against the SMW collision ranges (see
 * `isActsLikeHorizSolid` / `isActsLikeVertSolid`) rather than treating tile
 * presence as solidity, so decorative priority tiles with non-solid acts-like
 * values (e.g. forest columns) are correctly ignored by patrol-range scans.
 */
export interface L1Cell {
  readonly id:       number
  readonly actsLike: number
  /**
   * True when every subtile of this cell's tile renders at priority-1
   * (foreground decorative). Priority cells pass through sprite→tile
   * collision (walls, hard floors) but STILL count as ground for
   * ledge-detection purposes — visually the sprite sits on top of the
   * decoration, and the overlay should match that. Consumers decide
   * per-predicate whether to respect the flag.
   */
  readonly isPriority?: boolean
  /**
   * Pre-computed per-direction collision classification from
   * `TileFactory`. Combines the acts-like range checks with the ROM's
   * block-behavior table (`DATA_00F05C`) so coins, vines, and other
   * collectible / climbable tiles don't register as walls, and
   * semi-solid ledges / slopes distinguish top-vs-bottom collision.
   * Undefined for cells built without a classification pass; predicates
   * fall back to acts-like range checks in that case.
   */
  readonly collision?: TileCollision
}

/** Callback used by renderOverlay implementations to read the L1 cell at the
 *  given grid coordinate. Returns null when the cell is empty. */
export type GetL1Tile = (col: number, row: number) => L1Cell | null

/**
 * True if this acts-like value blocks a sprite moving horizontally.
 *
 * Matches CODE_01928E's INITIAL low-byte test (bank_01.asm:2613) — actsLike
 * `$11..$6D` — but not perfectly: the game also reads a per-tile
 * `TileGenerateTrackA` flag in `CODE_0192F9` that kills the wall for
 * non-solid decorative / climbable tiles (rope/net $02D/$02E, etc.).
 * Without loading that per-tile flag, we approximate: Map16 page 0
 * ($000-$0FF) tiles are decorative / slope / background-animated by
 * vanilla convention and are never L1 walls, even when their low byte
 * lands in $11-$6D. Only page-1+ tiles pass the range check.
 */
export function isActsLikeHorizSolid(actsLike: number): boolean {
  if (actsLike < 0x100) return false
  const low = actsLike & 0xFF
  return low >= 0x11 && low <= 0x6D
}

/**
 * True if this acts-like value blocks a sprite moving vertically — matches
 * CODE_0192C9 (bank_01.asm:2646): either acts-like `$11..$6D`, or in the
 * tileset-specific `SolidTileStart..SolidTileEnd` window (default `$C4..$C9`).
 * The default window covers the standard "solid from above" tiles used by
 * most tilesets; tileset 0 (underground) and tileset 7 (ghost house) disable
 * it by writing `$FF` to both (bank_05.asm:323).
 *
 * Same page-0 rejection as `isActsLikeHorizSolid` — decorative page-0 tiles
 * aren't hard floors / ceilings even when their low byte falls in range.
 * Slopes still count as `hasGround` (different predicate, different range).
 */
export function isActsLikeVertSolid(actsLike: number, tileset: number = 1): boolean {
  if (actsLike < 0x100) return false
  const low = actsLike & 0xFF
  if (low >= 0x11 && low <= 0x6D) return true
  if (tileset === 0 || tileset === 7) return false
  return low >= 0xC4 && low <= 0xC9
}

/**
 * True if this acts-like value represents walkable ground — a tile a sprite
 * can stand on top of without falling. Strictly broader than
 * `isActsLikeVertSolid`: includes slopes ($6E..$D7) which pass the "partial
 * collision" data-table lookup in `CODE_01933B` (bank_01.asm:2705), plus the
 * `$D8+` "solid from above" range. Used for ledge detection (where a sprite's
 * surface ENDS), not for hard vertical collision (which is `solidV`).
 *
 * Range derivation — CODE_01933B branches:
 *   < $11        → return non-solid
 *   $11..$6D     → solid
 *   $6E..$D7     → slope / partial-collision via `CODE_00FA19` table lookup
 *                  (vast majority walkable; a handful of special values like
 *                  gas / water / conveyors may not be — out of scope for the
 *                  static overlay's purposes)
 *   $D8..$FF     → solid
 *
 * The static overlay treats "any ground tile" as standable. A sprite that
 * would land on a non-standable special tile will still see that tile in its
 * `solidV` check if it's strictly solid; ledge detection is about "does the
 * surface continue in this direction", which is separate from "would the
 * sprite land on this specific tile".
 */
export function isActsLikeGround(actsLike: number): boolean {
  return (actsLike & 0xFF) >= 0x11
}

/**
 * Structural view of a tile's behavior — enough to check for a stable
 * four-subtile quad without importing the full `Tile` class. Matches
 * `StaticQuadBehavior.quad` shape. Behaviors that don't expose `quad`
 * (pipes, P-switch reveal, etc.) just fall through as non-decorative.
 */
interface QuadExposingBehavior {
  quad?: readonly { priority: boolean }[]
}

/**
 * True when this tile renders as a foreground-decorative (priority-1) cell
 * that does not participate in sprite collision. Priority-1 tiles draw in
 * front of sprites and are treated as passable by the game's sprite-tile
 * interaction routines (CODE_019140 and friends) — they're LM-style
 * foreground overlays like grass tufts, backdrop tubes, forest columns.
 *
 * We only inspect the `quad` on `StaticQuadBehavior` tiles because they
 * expose a stable four-subtile quad without needing a render context.
 * Dynamic-behavior tiles (pipes, P-switch reveal) fall through as
 * non-decorative — their actsLike value alone decides solidity.
 *
 * All four subtiles must carry the priority bit; a mixed quad (e.g. a pipe
 * top with priority on the rim tiles only) is treated as a normal collision
 * tile.
 */
export function isPriorityDecorative(tile: { behavior: unknown }): boolean {
  const b = tile.behavior as QuadExposingBehavior
  const quad = b?.quad
  if (!quad || quad.length !== 4) return false
  return quad[0].priority && quad[1].priority && quad[2].priority && quad[3].priority
}
