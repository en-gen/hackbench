import type { CellBox, RenderTarget } from '../RenderTarget'
import type { MapStore } from '../stores/mapStore'
import type { SubtileQuad } from './Tile'

/**
 * A tile behavior decides, given the per-map store and its own
 * placement (`cell`), which subtiles to draw and at what opacity. Both
 * arguments are passed so behaviors can derive per-cell concerns (like
 * a pipe tile figuring out its screen-specific palette variant) without
 * leaking that math into callers. Editor-singleton state (P-switch,
 * switch palace, animation frame, etc.) is reached by behaviors via
 * direct `editorStore` import.
 */
export interface TileBehavior {
  selectQuad(cell: CellBox, mapStore: MapStore): SubtileQuad
  /**
   * Optional per-render alpha ∈ (0, 1]. Undefined or ≥1 = opaque write.
   * Used by editor-only behaviors that need to fade a tile based on state
   * (e.g. blue-P-switch "hidden" tiles shown at 50% when inactive).
   */
  selectAlpha?(cell: CellBox, mapStore: MapStore): number
  /**
   * Optional editor overlay drawn in a pre-pass BEFORE the tile's own pixels.
   * Since tiles render afterward, they naturally cover the lower portion of
   * any overlay that extends into the tile's own cell — achieving a
   * "peek out from behind" effect without explicit clipping.
   *
   * Used for vine/1-up indicator icons drawn above vine-source blocks.
   * Alpha should be 0.5 at rest, 1.0 when `editorStore.cursorPx` is within the cell.
   */
  renderOverlay?(target: RenderTarget, cell: CellBox, mapStore: MapStore): void
}
