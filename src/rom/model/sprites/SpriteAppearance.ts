import type { OverlayContext, GetL1Tile } from '../OverlayContext'
import type { RenderTarget } from '../RenderTarget'
import type { MapStore } from '../stores/mapStore'
import type { SpriteBehavior } from './SpriteBehavior'

/** Axis-aligned hit rectangle in sprite-local pixel space. */
export interface HitRect {
  dx: number  // left edge relative to sprite origin
  dy: number  // top edge relative to sprite origin
  w:  number
  h:  number
}

export interface SpriteAppearance {
  /**
   * Draw this sprite at the given pixel position. `behavior` is the same
   * object hanging off the parent `Sprite` — appearances that need access
   * to behavioral data (reach, state, etc.) read it here; most ignore it.
   * Editor-singleton state is read via direct `editorStore` import.
   */
  render(
    target: RenderTarget,
    x: number,
    y: number,
    behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void

  /** Pixel-space bounding rect relative to the sprite origin. Used for cursor hit-testing. */
  readonly hitRect: HitRect

  /**
   * Advance this appearance's internal animation state by one frame.
   * Called by the editor's animation timer for every visible sprite.
   * Appearances without multi-frame animation may omit this.
   */
  tickAnimation?(): void

  /**
   * Draw a Canvas2D geometric overlay for this sprite — patrol corridors,
   * detection zones, jump arcs etc. Called by `SmwMap.renderSpriteOverlays`
   * as a pre-pass (before the sprite pixels), so the sprite artwork naturally
   * sits on top of any tinted region.
   *
   * Sprites whose ASM init uses `FaceMario` (e.g. $09 bouncing koopa,
   * bank_01.asm:847-850) read Mario's spawn X off `mapStore.marioSpawnX`
   * to choose the toward-Mario simulation direction.
   *
   * @param ctx       Overlay drawing context (CanvasRenderingContext2D cast).
   * @param x         Sprite origin X in level pixels.
   * @param y         Sprite origin Y in level pixels.
   * @param isActive  True when the player has clicked this sprite to toggle
   *                  the overlay on; implementations should skip drawing when
   *                  false.
   * @param getL1     Accessor for the L1 map grid — returns null for empty
   *                  cells, or the Map16 id for a solid tile.
   * @param levelCols Total number of L1 tile columns in this level.
   * @param levelRows Total number of L1 tile rows in this level.
   * @param behavior  Attached behavior for this sprite, if any.
   * @param mapStore  Per-map reactive store — exposes `marioSpawnX` for
   *                  spawn-side-aware patrol overlays.
   */
  renderOverlay?(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    getL1:      GetL1Tile,
    levelCols:  number,
    levelRows:  number,
    behavior:   SpriteBehavior | undefined,
    mapStore:   MapStore,
  ): void
}
