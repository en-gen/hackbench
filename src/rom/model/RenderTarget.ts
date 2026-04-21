import type { Ref } from '@vue/reactivity'
import type { RgbaColor } from '../GraphicsDecoder'
import type { Palette } from './palette/Palette'

export type Phase = 'nonPriority' | 'priority'

export interface PixelPos {
  x: number
  y: number
}

export interface PixelSize {
  w: number
  h: number
}

export interface CellPos {
  x: number
  y: number
}

export interface CellBox {
  tl: PixelPos
  tr: PixelPos
  bl: PixelPos
  br: PixelPos
}

export interface CameraState {
  tileX: number
  tileY: number
  focused: boolean
}

export interface LayerToggles {
  l1: boolean
  l2: boolean
  sprites: boolean
  screens: boolean
  block: boolean
  /** Tile-grid overlay on the main canvas (toolbar btn-map-grid). */
  mapGrid: boolean
}

/**
 * Thread for model behaviors to reach state. Reactive fields are `Ref`s
 * so that reads inside `computed()` are tracked by @vue/reactivity and
 * downstream caches invalidate only when their actual inputs change.
 *
 * All fields are level-wide or display-wide state — anything per-cell
 * (e.g. which pipe-palette variant a pipe tile should pick for its
 * screen) is derived by the tile's behavior from its own `cell`
 * argument, so callers don't need to pre-compute per-cell ctx.
 */
export interface RenderContext {
  animFrame: Ref<number>
  palAnimFrame: Ref<number>
  pSwitchActive: Ref<boolean>
  switchPalaceState: Ref<readonly [boolean, boolean, boolean, boolean]>
  palette: Palette
  camera: Ref<CameraState>
  zoom: Ref<number>
  layerToggles: Ref<LayerToggles>
  /**
   * Level orientation — lets behaviors that care (PipeVariants) decide
   * whether the "scrolling axis" is X or Y when computing which screen
   * a given cell belongs to.
   */
  levelOrientation?: 'horizontal' | 'vertical'
  /**
   * Per-screen MAP16AppTable index (0..3), one entry per screen in the
   * level. PipeVariants picks its variant via
   * `screenPipeVariantIdx[screenOf(cell)]`.
   */
  screenPipeVariantIdx?: readonly number[]
}

export interface RenderTarget {
  /**
   * Write an 8×8 tile to the framebuffer.
   * `alpha` ∈ (0, 1]; when < 1, the tile is blended over existing pixels
   * (used for editor-only "hidden" tiles gated by the blue P-switch).
   * Default 1.0 = fully opaque write.
   */
  blit8x8(
    pixels: Uint8Array,
    pos: PixelPos,
    paletteRow: RgbaColor[],
    flipX: boolean,
    flipY: boolean,
    alpha?: number,
  ): void
  fillRect(pos: PixelPos, size: PixelSize, color: RgbaColor): void
}

export function cellBoxOf(tileX: number, tileY: number): CellBox {
  const px = tileX * 16
  const py = tileY * 16
  return {
    tl: { x: px, y: py },
    tr: { x: px + 8, y: py },
    bl: { x: px, y: py + 8 },
    br: { x: px + 8, y: py + 8 },
  }
}
