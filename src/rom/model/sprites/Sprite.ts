import type { GetL1Tile, OverlayContext } from '../OverlayContext'
import { editorStore } from '../stores/editorStore'
import type { RenderTarget } from '../RenderTarget'
import type { MapStore } from '../stores/mapStore'
import type { SpriteAppearance } from './SpriteAppearance'
import type { SpriteBehavior } from './SpriteBehavior'

export class Sprite {
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
