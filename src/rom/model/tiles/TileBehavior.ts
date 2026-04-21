import type { CellBox, RenderContext } from '../RenderTarget'
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
}
