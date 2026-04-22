import type { RgbaColor } from '../../rom/GraphicsDecoder'
import type { PixelPos, PixelSize, RenderTarget } from '../../rom/model/RenderTarget'

export class CanvasRenderTarget implements RenderTarget {
  private readonly width: number
  private readonly height: number
  private readonly ctx2d: CanvasRenderingContext2D
  private readonly imageData: ImageData
  private readonly buf: Uint8ClampedArray
  private clipX0 = 0
  private clipX1 = 0
  private clipY0 = 0
  private clipY1 = 0

  constructor(canvas: HTMLCanvasElement) {
    this.width = canvas.width
    this.height = canvas.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to acquire 2D canvas context')
    this.ctx2d = ctx
    this.imageData = ctx.createImageData(this.width, this.height)
    this.buf = this.imageData.data
    this.clipX1 = this.width
    this.clipY1 = this.height
  }

  setClip(x: number, y: number, w: number, h: number): void {
    this.clipX0 = x
    this.clipY0 = y
    this.clipX1 = x + w
    this.clipY1 = y + h
  }

  clearClip(): void {
    this.clipX0 = 0
    this.clipY0 = 0
    this.clipX1 = this.width
    this.clipY1 = this.height
  }

  clear(color: RgbaColor = [0, 0, 0, 0]): void {
    const buf = this.buf
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = color[0]
      buf[i + 1] = color[1]
      buf[i + 2] = color[2]
      buf[i + 3] = color[3]
    }
  }

  blit8x8(
    pixels: Uint8Array,
    pos: PixelPos,
    paletteRow: RgbaColor[],
    flipX: boolean,
    flipY: boolean,
    alpha?: number,
  ): void {
    if (!pixels) {
      console.warn('[blit8x8] pixels undefined at', pos)
      return
    }
    if (!paletteRow) {
      console.warn('[blit8x8] paletteRow undefined at', pos)
      return
    }
    const w = this.width
    const buf = this.buf
    const a = alpha === undefined || alpha >= 1 ? 1 : (alpha <= 0 ? 0 : alpha)
    const blend = a < 1
    for (let py = 0; py < 8; py++) {
      const dstY = pos.y + py
      if (dstY < this.clipY0 || dstY >= this.clipY1) continue
      const srcY = flipY ? 7 - py : py
      for (let px = 0; px < 8; px++) {
        const dstX = pos.x + px
        if (dstX < this.clipX0 || dstX >= this.clipX1) continue
        const srcX = flipX ? 7 - px : px
        const idx = pixels[srcY * 8 + srcX]
        if (idx === 0) continue
        const col = paletteRow[idx]
        if (!col) {
          console.warn('[blit8x8] palette idx out of range', {
            idx,
            rowLen: paletteRow.length,
            pixelsLen: pixels.length,
            srcX,
            srcY,
          })
          return
        }
        const off = (dstY * w + dstX) * 4
        if (blend) {
          // src over dst (dst already 255-alpha from background fill)
          const inv = 1 - a
          buf[off]     = col[0] * a + buf[off]     * inv
          buf[off + 1] = col[1] * a + buf[off + 1] * inv
          buf[off + 2] = col[2] * a + buf[off + 2] * inv
          buf[off + 3] = 255
        } else {
          buf[off]     = col[0]
          buf[off + 1] = col[1]
          buf[off + 2] = col[2]
          buf[off + 3] = 255
        }
      }
    }
  }

  fillRect(pos: PixelPos, size: PixelSize, color: RgbaColor): void {
    const w = this.width
    const buf = this.buf
    for (let py = 0; py < size.h; py++) {
      const dstY = pos.y + py
      if (dstY < this.clipY0 || dstY >= this.clipY1) continue
      for (let px = 0; px < size.w; px++) {
        const dstX = pos.x + px
        if (dstX < this.clipX0 || dstX >= this.clipX1) continue
        const off = (dstY * w + dstX) * 4
        buf[off] = color[0]
        buf[off + 1] = color[1]
        buf[off + 2] = color[2]
        buf[off + 3] = color[3]
      }
    }
  }

  flush(): void {
    this.ctx2d.putImageData(this.imageData, 0, 0)
  }

  /** Write only a sub-region of the buffer to the canvas.
   *  Pixels outside (x, y, w, h) on the canvas are not touched.
   *  Used by the camera composite to update just the viewport strip
   *  without overwriting the base level render. */
  flushRegion(x: number, y: number, w: number, h: number): void {
    this.ctx2d.putImageData(this.imageData, 0, 0, x, y, w, h)
  }
}
