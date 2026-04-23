import type { CellBox, RenderContext, RenderTarget } from '../RenderTarget'
import type { SubtileQuad } from './Tile'

/**
 * A tile behavior decides, given the level state (`ctx`) and its own
 * placement (`cell`), which subtiles to draw and at what opacity. Both
 * arguments are passed so behaviors can derive per-cell concerns (like
 * a pipe tile figuring out its screen-specific palette variant) without
 * leaking that math into callers.
 */
export interface TileBehavior {
  selectQuad(ctx: RenderContext, cell: CellBox): SubtileQuad
  /**
   * Optional per-render alpha ∈ (0, 1]. Undefined or ≥1 = opaque write.
   * Used by editor-only behaviors that need to fade a tile based on state
   * (e.g. blue-P-switch "hidden" tiles shown at 50% when inactive).
   */
  selectAlpha?(ctx: RenderContext, cell: CellBox): number
  /**
   * Optional editor overlay drawn in a pre-pass BEFORE the tile's own pixels.
   * Since tiles render afterward, they naturally cover the lower portion of
   * any overlay that extends into the tile's own cell — achieving a
   * "peek out from behind" effect without explicit clipping.
   *
   * Used for vine/1-up indicator icons drawn above vine-source blocks.
   * Alpha should be 0.5 at rest, 1.0 when `ctx.cursorPx` is within the cell.
   */
  renderOverlay?(ctx: RenderContext, target: RenderTarget, cell: CellBox): void
}
