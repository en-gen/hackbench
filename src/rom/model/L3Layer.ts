import { L3_HUD_ROW_CUTOFF, L3_TILEMAP_COLS, L3_TILEMAP_ROWS, type L3ScrollRange } from '../L3Loader'
import type { GfxSheet } from '../GfxLoader'
import type { Phase, RenderTarget } from './RenderTarget'
import { editorStore } from './stores/editorStore'
import type { MapStore } from './stores/mapStore'

/**
 * An L3 tile cell as decoded from the stripe-image VRAM buffer.
 * Standard SNES BG tile word format (same as L1/L2):
 *   [15] flipY, [14] flipX, [13] priority, [12:10] palette (0–7), [9:0] charIdx
 * For 2BPP BG3, palette P selects CGRAM colors P*4 to P*4+3.
 */
interface L3Cell {
  charIdx: number
  palette: number
  priority: boolean
  flipX: boolean
  flipY: boolean
}

export abstract class L3Layer {
  /**
   * Draw only the cells whose tile word carries `phase`. BG3 splits on the
   * PPU exactly like BG1 and BG2: with the header's BG3-priority bit set
   * BG3.1 is the frontmost thing on screen while BG3.0 stays behind
   * everything, so one undifferentiated pass cannot place both.
   */
  abstract render(
    target: RenderTarget,
    mapStore: MapStore,
    phase: Phase,
    clipRangeX?: { xMin: number; xMax: number },
  ): void

  /** Which tile-priority phases this layer has content for. */
  abstract phases(): Set<Phase>
}

/**
 * L3 overlay built from a stripe-image tilemap dataset (Tilemap_L3Tide, etc.).
 *
 * Rendering:
 *   Each non-null cell in the 64×64 VRAM tilemap is drawn at pixel coordinates:
 *     x = col * 8  (repeated to fill level width)
 *     y = initialYPx + (row - firstDataRow) * 8
 *
 *   `firstDataRow` is the first row >= L3_HUD_ROW_CUTOFF that contains data.
 *   `initialYPx` is the game's Layer3YPos initial value (tile rows + scroll).
 *
 * HUD area (rows 0 – L3_HUD_ROW_CUTOFF-1):
 *   Skipped unless ctx.layerToggles.l3Hud is true AND ctx.camera is focused.
 *   When shown, cells are clipped to the camera viewport pixel bounds.
 */
export class L3TilemapLayer extends L3Layer {
  /** 64×64 sparse cell table. null = empty (tile word was 0). */
  private readonly cells: (L3Cell | null)[][]
  /** First row >= L3_HUD_ROW_CUTOFF that holds at least one non-null cell. */
  private readonly firstDataRow: number
  /**
   * Exclusive upper bound for gameplay row rendering.
   * Tilesets like the tide write two identical VRAM copies (e.g. rows 32–47 and
   * rows 48–63) for smooth animation; we render only the first copy so the editor
   * doesn't show a double band.  Set by finding the first row after firstDataRow
   * whose charIdx pattern matches firstDataRow exactly.
   */
  private readonly dataEndRow: number

  constructor(
    /** Raw 64×64 VRAM tilemap (index = row*64+col). Stored for serialization. */
    readonly tilemap: Uint16Array,
    /** L3 GFX as 4-element array: [GFX28, GFX29, GFX2A, GFX2B] (each 128 tiles). */
    readonly l3Chars: GfxSheet[],
    /** Initial Layer3YPos in pixels (from Layer3TilemapSettings). */
    readonly initialYPx: number,
    /** Level pixel width (screens * 256). Stored for serialization. */
    readonly levelPixelW: number,
    /** Level pixel height (27 × 16 = 432 for horizontal levels). */
    readonly levelPixelH: number,
    /**
     * Pre-computed scroll-range rectangle for the editor's BG-coverage
     * overlay. `kind: 'none'` for HUD-only L3 (no gameplay-area content).
     * Computed in L3Factory.buildL3 from this layer's settings + tileset.
     */
    readonly scrollRange: L3ScrollRange = { kind: 'none', xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
  ) {
    super()

    // Decode tilemap into cell grid
    this.cells = Array.from({ length: L3_TILEMAP_ROWS }, (_, row) =>
      Array.from({ length: L3_TILEMAP_COLS }, (__, col) => {
        const word = tilemap[row * L3_TILEMAP_COLS + col] ?? 0
        if (word === 0) return null
        return {
          charIdx:  word & 0x3FF,
          palette:  (word >> 10) & 0x07,
          priority: (word & 0x2000) !== 0,
          flipX:    (word & 0x4000) !== 0,
          flipY:    (word & 0x8000) !== 0,
        }
      }),
    )

    // Find first data row in gameplay area
    let first = L3_HUD_ROW_CUTOFF
    outer: for (let r = L3_HUD_ROW_CUTOFF; r < L3_TILEMAP_ROWS; r++) {
      for (const cell of this.cells[r]!) {
        if (cell !== null) { first = r; break outer }
      }
    }
    this.firstDataRow = first

    // Tide overlays write two identical VRAM copies for smooth animation (e.g.
    // rows 32–47 then 48–63).  For tides we find the repeat and stop there so
    // the editor doesn't render a double band.
    //
    // Non-tide overlays (fish, cage, clouds, …) fill sub 0/1 (rows 0–31) and
    // sub 2/3 (rows 32–63) with *different* content at the same charIdx values;
    // running the repeat-detection on them prematurely sets dataEndRow = 32 and
    // hides all sub 2/3 tiles.  Skip the detection entirely for non-tides.
    const isTide = this.initialYPx > 0 && this.initialYPx < 0xC0
    let end = L3_TILEMAP_ROWS
    if (isTide) {
      const firstRow = this.cells[this.firstDataRow]!
      for (let r = this.firstDataRow + 1; r < L3_TILEMAP_ROWS; r++) {
        const row = this.cells[r]!
        let match = true
        for (let c = 0; c < L3_TILEMAP_COLS; c++) {
          const a = firstRow[c], b = row[c]
          if ((a === null) !== (b === null) || (a !== null && b !== null && a.charIdx !== b.charIdx)) {
            match = false; break
          }
        }
        if (match) { end = r; break }
      }
    }
    this.dataEndRow = end
  }

  /**
   * Render the L3 overlay.  `clipRangeX`, if provided, limits the horizontal
   * level-Y range that tide tiles iterate through; tiles whose final `ox`
   * would fall outside the range are skipped up-front.  The camera-viewport
   * composite uses this to avoid iterating every repeat of the 256px tide
   * pattern across the full level width when only the strip needs refilling.
   */
  /**
   * Gameplay rows only, mirroring `render`'s row filter. The HUD rows are
   * an editor diagnostic behind `l3Hud`, and the status bar is a
   * scanline-region rule the pass model does not try to express
   * (docs/obj-priority.md section 4); counting them would put every level
   * in a BG3.1 pass it never draws.
   */
  phases(): Set<Phase> {
    const out = new Set<Phase>()
    for (let row = L3_HUD_ROW_CUTOFF; row < this.dataEndRow && out.size < 2; row++) {
      for (const cell of this.cells[row]!) {
        if (cell) out.add(cell.priority ? 'priority' : 'nonPriority')
      }
    }
    return out
  }

  render(
    target: RenderTarget,
    mapStore: MapStore,
    phase: Phase,
    clipRangeX?: { xMin: number; xMax: number },
  ): void {
    const toggles = editorStore.layerToggles
    // HUD is only meaningful when the camera viewport is on (it's positioned
    // relative to the viewport). Gating on cameraOn here also prevents the
    // main L3 render from establishing a reactive dependency on editorStore.camera
    // when HUD is off, so dragging the viewport doesn't force full-level L3
    // re-renders.  Also skip HUD while actively dragging — the status bar
    // tiles snap to whole tiles, so a sub-tile-smooth drag looks jittery;
    // snap back on drag release.
    const mayShowHud = toggles.l3Hud && editorStore.cameraOn
    const showHud = mayShowHud && !editorStore.cameraDragging
    const camera  = showHud ? editorStore.camera : null

    // Pre-compute all 8 L3 2BPP sub-palettes.
    // For 2BPP BG3, palette P selects CGRAM colors P*4 to P*4+3:
    //   CGRAM row = P >> 2, column offset = (P & 3) * 4
    const subPalettes: import('../GraphicsDecoder').RgbaColor[][] = Array.from({ length: 8 }, (_, p) => {
      const cgRow = mapStore.palette.row(p >> 2)
      const off   = (p & 3) * 4
      return [cgRow[off]!, cgRow[off + 1]!, cgRow[off + 2]!, cgRow[off + 3]!]
    })

    // Tide overlays (initialYPx $40/$70) differ from cage/windows ($D0):
    //   - Tide: the game scrolls BG3HOFS with the camera (Layer3XPos += Layer1DXPos,
    //     bank_05.asm CODE_05C4EC), so the wave pattern at cols 0-31 effectively
    //     tiles at 256px instead of 512px.
    //   - Non-tide: BG3 stays fixed relative to the screen, so the full 512px
    //     tilemap renders once per 512px.
    const isTide = this.initialYPx > 0 && this.initialYPx < 0xC0
    const xPeriod  = isTide ? 256 : L3_TILEMAP_COLS * 8
    const colLimit = isTide ? 32 : L3_TILEMAP_COLS

    for (let row = 0; row < L3_TILEMAP_ROWS; row++) {
      const isHud = row < L3_HUD_ROW_CUTOFF
      if (isHud && !showHud) continue
      if (!isHud && row >= this.dataEndRow) continue  // skip second VRAM copy

      const rowCells = this.cells[row]!
      // HUD rows at the camera viewport top.
      // Gameplay rows: BG3 tile at VRAM row R appears at screen scanline (R*8 - BG3VOFS),
      //   and in level coords: screen + cameraY. The level's initial camera Y is the
      //   ROM-derived Layer1YPos at level init (DATA_05D708 lookup, bank_05.asm:7329-7335).
      const initialCamY = mapStore.initialCameraYPx
      const pixelY = isHud
        ? (camera!.tileY * 16) + row * 8
        : row * 8 - this.initialYPx + initialCamY
      if (!isHud && pixelY < 0) continue

      // HUD uses the full BG3 sub 0 width (32 cols), regardless of tide's
      // 32-col rendering convention. HUD rows must not be truncated when the
      // tilemap happens to extend into cols > 31 of the flat layout.
      const rowColLimit = isHud ? L3_TILEMAP_COLS : colLimit
      // HUD: render once at camera viewport X; skip level-wide repeat.
      const rowXPeriod = isHud ? Number.POSITIVE_INFINITY : xPeriod
      const rowXStart  = isHud ? (camera!.tileX * 16) : 0

      for (let col = 0; col < rowColLimit; col++) {
        const cell = rowCells[col]
        if (!cell) continue
        if ((cell.priority ? 'priority' : 'nonPriority') !== phase) continue

        const pixels = this._charPixels(cell.charIdx)
        if (!pixels) continue

        const paletteSlice = subPalettes[cell.palette]!
        const basePixelX = rowXStart + col * 8

        // For periodic (non-HUD) tiles with a clipRangeX, jump straight to the
        // first ox that could land inside the range instead of iterating every
        // repeat from 0. Saves ~10× iterations on typical 11-screen levels.
        const oxMin = clipRangeX && !isHud
          ? basePixelX + Math.max(0, Math.ceil((clipRangeX.xMin - basePixelX) / rowXPeriod)) * rowXPeriod
          : basePixelX
        const oxMax = clipRangeX && !isHud
          ? Math.min(this.levelPixelW, clipRangeX.xMax)
          : this.levelPixelW

        for (let ox = oxMin; ox < oxMax; ox += rowXPeriod) {
          const pos = { x: ox, y: pixelY }
          target.blit8x8(pixels, pos, paletteSlice, cell.flipX, cell.flipY)
        }
      }
    }
  }

  private _charPixels(charIdx: number): Uint8Array | null {
    const fileIdx  = charIdx >> 7       // 0–3 (4 GFX files)
    const localIdx = charIdx & 0x7F     // 0–127 within the file
    return this.l3Chars[fileIdx]?.[localIdx] ?? null
  }
}
