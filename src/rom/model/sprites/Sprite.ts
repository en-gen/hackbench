import type { GetL1Tile, OverlayContext } from '../OverlayContext'
import { editorStore } from '../stores/editorStore'
import type { RenderTarget } from '../RenderTarget'
import type { MapStore } from '../stores/mapStore'
import type { SpriteAppearance } from './SpriteAppearance'
import type { SpriteBehavior } from './SpriteBehavior'
import { DEFAULT_OBJ_PRIORITY, type SpriteObjPriority } from '../../SpritePriorityLoader'

export class Sprite {
  /**
   * OBJ priority facet: which sprite pass this sprite composites in, plus
   * where the value came from. Assigned once after construction by the
   * factory (extension host) or `rehydrate` (webview) -- not a constructor
   * argument, because every `new Sprite` site would otherwise have to
   * thread a ROM read it has no other use for. Defaults to OBJ.2 so a
   * sprite built by a test fixture still composites somewhere sensible.
   */
  priority: SpriteObjPriority = { value: DEFAULT_OBJ_PRIORITY, source: 'level' }

  constructor(
    readonly id: number,
    readonly x: number,
    readonly y: number,
    readonly appearance: SpriteAppearance,
    readonly behavior: SpriteBehavior,
  ) {}

  /**
   * SCAFFOLDING. Alternate render path for the table-driven draw engine,
   * attached by `attachEngineAppearances` only for sprites with a traced
   * descriptor. Selected by the `spriteEngine` toolbar toggle, which is a
   * temporary comparison control; this field deletes with it. See
   * `docs/sprite-engine-wiring.md`.
   */
  engineAppearance?: SpriteAppearance

  render(target: RenderTarget, mapStore: MapStore): void {
    // Read unconditionally so the reactive render effect tracks the toggle
    // even on a pass where no engine appearance is attached.
    const useEngine = editorStore.spriteEngine
    const chosen = useEngine && this.engineAppearance ? this.engineAppearance : this.appearance
    chosen.render(target, this.x, this.y, this.behavior, mapStore)
  }

  tickAnimation(): void {
    // Both paths advance on the SAME timer tick. The engine appearance does
    // not tick its fallback, so nothing is double-advanced.
    this.appearance.tickAnimation?.()
    this.engineAppearance?.tickAnimation?.()
  }

  /**
   * Second pixel pass, run after the layer-1 priority tiles. No-op unless
   * the appearance opts in - see `SpriteAppearance.renderAboveL1`.
   */
  renderAboveL1(target: RenderTarget, mapStore: MapStore): void {
    this.appearance.renderAboveL1?.(target, this.x, this.y, this.behavior, mapStore)
  }

  renderOverlay(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    getL1:      GetL1Tile,
    levelCols:  number,
    levelRows:  number,
    mapStore:   MapStore,
  ): void {
    this.appearance.renderOverlay?.(
      ctx, x, y, isActive, getL1, levelCols, levelRows, this.behavior, mapStore,
    )
  }

  /**
   * Returns `this` when (levelPx, levelPy) is inside the sprite's hit rect,
   * else null. Subclasses override to drill into nested children.
   */
  pickAt(levelPx: number, levelPy: number): Sprite | null {
    const hr = this.appearance.hitRect
    if (levelPx >= this.x + hr.dx && levelPx < this.x + hr.dx + hr.w
     && levelPy >= this.y + hr.dy && levelPy < this.y + hr.dy + hr.h) {
      return this
    }
    return null
  }
}

/**
 * Overlay toggle key for a sprite: `"id:x,y"`.
 *
 * `SmwMap.renderSpriteOverlays` (which decides whether an annotation is
 * active) and the webview hit test (which decides what a click toggles)
 * must agree on this string exactly, or clicking a sprite silently sets a
 * key nothing reads. Nothing in the type system enforces that agreement,
 * so both sides call this one function instead of building the string.
 */
export function spriteOverlayKey(sprite: Pick<Sprite, 'id' | 'x' | 'y'>): string {
  return `${sprite.id}:${sprite.x},${sprite.y}`
}
