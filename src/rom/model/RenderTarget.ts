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
  /**
   * Show the L2 plane bounding rectangle (toolbar btn-l2range), object-stream
   * L2 only. Reads `mapData.l2.scrollRange`; see `computeL2ScrollRange` in
   * `src/rom/L2Loader.ts`.
   */
  l2Range: boolean
  /**
   * Show the camera-viewport scroll-path overlay (toolbar btn-scrollpath):
   * polylines tracing where the L1 camera and L2 scroll area travel through
   * their respective planes over the level's auto-scroll lifetime. Reads
   * `mapData.header.scrollPath`; the data comes from
   * `sampleViewportPath(scrollSimulator, levelPixelW, 8)`.
   */
  scrollPath: boolean
  /**
   * Show the moving camera-viewport bounding box driven by the Scroll
   * panel's Play button. Reads `editorStore.scrollPlaybackFrame` to
   * pick which sample of `mapData.header.scrollPath` to draw a
   * 256x224 rect at. -1 = not playing.
   */
  scrollPlayback: boolean
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

/**
 * Variant of `cellBoxOf` with a per-render Y delta. Used by `L2ObjectStream`
 * to apply the per-level `Layer2YPos` (BG2VOFS) offset, which positions L2
 * relative to the camera independently of L1's row coordinates.
 */
export function cellBoxAt(tileX: number, tileY: number, dy: number): CellBox {
  const px = tileX * 16
  const py = tileY * 16 + dy
  return {
    tl: { x: px, y: py },
    tr: { x: px + 8, y: py },
    bl: { x: px, y: py + 8 },
    br: { x: px + 8, y: py + 8 },
  }
}
