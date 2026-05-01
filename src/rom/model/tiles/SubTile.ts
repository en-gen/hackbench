import type { Char } from '../chars/Char'
import type { Palette } from '../palette/Palette'
import type { PixelPos, RenderTarget } from '../RenderTarget'

export class SubTile {
  constructor(
    readonly char: Char,
    readonly palette: number,
    readonly flipX: boolean,
    readonly flipY: boolean,
    readonly priority: boolean,
  ) {}

  render(target: RenderTarget, pos: PixelPos, palette: Palette, alpha?: number): void {
    const pixels = this.char.getPixels()
    const row = palette.row(this.palette)
    target.blit8x8(pixels, pos, row, this.flipX, this.flipY, alpha)
  }
}
