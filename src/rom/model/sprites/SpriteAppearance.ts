import type { OverlayContext, GetL1Tile } from '../OverlayContext'
import type { RenderTarget } from '../RenderTarget'
import type { MapStore } from '../stores/mapStore'
import type { SpriteBehavior } from './SpriteBehavior'
import type { SpritePart } from './appearances/StaticSpriteAppearance'

/** Axis-aligned hit rectangle in sprite-local pixel space. */
export interface HitRect {
  dx: number // left edge relative to sprite origin
  dy: number // top edge relative to sprite origin
  w: number
  h: number
}

export interface SpriteAppearance {
  /**
   * Draw this sprite at the given pixel position. `behavior` is the same
   * object hanging off the parent `Sprite` - appearances that need access
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

  /**
   * Optional SECOND pixel pass, drawn after the layer-1 priority tiles in
   * `SmwMap.render` (and before layer 3, so the foreground BG keeps its
   * existing top-most role).
   *
   * It is the seam for EDITOR ANNOTATIONS: extra artwork drawn to tell the
   * user what a sprite is when its authored pose does not ($4D Monty Mole
   * rests as a pile of rubble, so the editor ghosts its emerged pose above
   * the mound). Running after layer 1 keeps that legibility independent of
   * whatever the author put in the cell.
   *
   * It is NOT a fix for buried sprites. An earlier version of this comment
   * claimed moles are hidden under terrain; that was measured and is false
   * - 176 $4D/$4E instances across four ROMs, none occluded by an L1
   * priority subtile (docs/sprite-4d-monty-mole.md).
   *
   * Rule: never introduce a second animation timer. An implementation may
   * draw something static, or drive itself from the same state `render`
   * reads, but it must not run a clock of its own.
   *
   * Appearances that do not implement it cost nothing: `Sprite.renderAboveL1`
   * is an optional-chained no-op.
   */
  renderAboveL1?(
    target: RenderTarget,
    x: number,
    y: number,
    behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void

  /** Pixel-space bounding rect relative to the sprite origin. Used for cursor hit-testing. */
  readonly hitRect: HitRect

  /**
   * The 8x8 parts this appearance draws, when it keeps them as a single
   * flat list. Declared optional because appearances that hold one list
   * per animation frame (SpikeTop, Wiggler) have no single answer. Read
   * only by the inspector; the render path uses each class's own field.
   */
  readonly parts?: readonly SpritePart[]

  /**
   * Advance this appearance's internal animation state by one frame.
   * Called by the editor's animation timer for every visible sprite.
   * Appearances without multi-frame animation may omit this.
   */
  tickAnimation?(): void

  /**
   * Draw a Canvas2D annotation for this sprite. Called by
   * `SmwMap.renderSpriteOverlays` as a pre-pass (before the sprite
   * pixels), so the sprite artwork naturally sits on top of any tinted
   * region.
   *
   * **This hook has no implementations right now, and that is
   * deliberate.** Every path, movement, trajectory, patrol, orbit and
   * detection-zone annotation was removed (see
   * `docs/sprite-overlay-removal.md`); the hook, the `SmwMap` pre-pass
   * and the webview click-to-toggle plumbing were kept as the extension
   * point for identity annotations, which tell the user what a sprite IS
   * when its static appearance does not. Do not remove it as dead code.
   *
   * @param ctx       Annotation drawing context (CanvasRenderingContext2D cast).
   * @param x         Sprite origin X in level pixels.
   * @param y         Sprite origin Y in level pixels.
   * @param isActive  True when the player has clicked this sprite to toggle
   *                  the annotation on; implementations should skip drawing
   *                  when false.
   * @param getL1     Accessor for the L1 map grid, returns null for empty
   *                  cells, or the Map16 id for a solid tile.
   * @param levelCols Total number of L1 tile columns in this level.
   * @param levelRows Total number of L1 tile rows in this level.
   * @param behavior  Attached behavior for this sprite, if any.
   * @param mapStore  Per-map reactive store.
   */
  renderOverlay?(
    ctx: OverlayContext,
    x: number,
    y: number,
    isActive: boolean,
    getL1: GetL1Tile,
    levelCols: number,
    levelRows: number,
    behavior: SpriteBehavior | undefined,
    mapStore: MapStore,
  ): void
}
