/**
 * A pure-core `RenderTarget`: an RGBA buffer whose `blit8x8` is `composeTile`
 * plus the color row (#421 step 2 round 3, design approved on #421). Until
 * now the only `RenderTarget` was `src/webview/mapEditor/CanvasRenderTarget`
 * (reference webview, canvas-backed), so nothing on the model's render path
 * (`Tile.render` -> `SubTile.render` -> `blit8x8`) ever ran through the core
 * resolver. This gives the same path a core implementation without touching
 * the webview or its `RenderTarget` interface.
 *
 * Effects (`L3Layer`'s own flip handling) is out of scope here; only the
 * Foreground/Background 8x8 blit is covered.
 */
import type { RgbaColor } from '../GraphicsDecoder'
import type { PixelPos, PixelSize, RenderTarget } from '../model/RenderTarget'
import { composeTile } from './TileResolver'

export class BufferRenderTarget implements RenderTarget {
  readonly buf: Uint8ClampedArray

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.buf = new Uint8ClampedArray(width * height * 4)
  }

  blit8x8(
    pixels: Uint8Array,
    pos: PixelPos,
    paletteRow: RgbaColor[],
    flipX: boolean,
    flipY: boolean,
    alpha = 1,
  ): void {
    const a = alpha >= 1 ? 1 : alpha <= 0 ? 0 : alpha
    const fields = { char: 0, flipX: flipX ? 1 : 0, flipY: flipY ? 1 : 0 }
    composeTile(
      fields,
      (_ch, x, y) => pixels[y * 8 + x],
      (x, y, v) => {
        // prettier-ignore
        const px = pos.x + x
        const py = pos.y + y
        if (px < 0 || py < 0 || px >= this.width || py >= this.height) return
        const col = paletteRow[v]
        if (!col) return
        const off = (py * this.width + px) * 4
        if (a < 1) {
          const inv = 1 - a
          this.buf[off] = col[0] * a + this.buf[off] * inv
          this.buf[off + 1] = col[1] * a + this.buf[off + 1] * inv
          this.buf[off + 2] = col[2] * a + this.buf[off + 2] * inv
          this.buf[off + 3] = 255
        } else {
          this.buf[off] = col[0]
          this.buf[off + 1] = col[1]
          this.buf[off + 2] = col[2]
          this.buf[off + 3] = 255
        }
      },
    )
  }

  fillRect(pos: PixelPos, size: PixelSize, color: RgbaColor): void {
    for (let y = 0; y < size.h; y++) {
      const py = pos.y + y
      if (py < 0 || py >= this.height) continue
      for (let x = 0; x < size.w; x++) {
        const px = pos.x + x
        if (px < 0 || px >= this.width) continue
        const off = (py * this.width + px) * 4
        this.buf[off] = color[0]
        this.buf[off + 1] = color[1]
        this.buf[off + 2] = color[2]
        this.buf[off + 3] = color[3]
      }
    }
  }
}
