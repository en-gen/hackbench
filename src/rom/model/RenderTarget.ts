import type { RgbaColor } from '../GraphicsDecoder'

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
  l3: boolean
  sprites: boolean
  screens: boolean
  block: boolean
  /** Tile-grid overlay on the main canvas (toolbar btn-map-grid). */
  mapGrid: boolean
  /**
   * Show HUD-area L3 tiles (VRAM rows 0–7) inside the camera viewport.
   * Default false — only meaningful when camera viewport is focused.
   */
  l3Hud: boolean
  /**
   * Draw floor/ceiling face lines on L1 cells (toolbar btn-surfaces).
   * Reads `tile.collision.marioFloor` / `.marioCeiling`; see
   * `src/rom/model/tiles/COLLISION.md`.
   */
  surfaces: boolean
  /**
   * Draw left/right wall face lines on L1 cells (toolbar btn-walls).
   * Reads `tile.collision.marioWall`; see
   * `src/rom/model/tiles/COLLISION.md`.
   */
  walls: boolean
  /**
   * Show the L3 BG-coverage rectangle (toolbar btn-l3range). Reads
   * `mapData.l3.scrollRange`; see `computeL3ScrollRange` in
   * `src/rom/L3Loader.ts`.
   */
  l3Range: boolean
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
