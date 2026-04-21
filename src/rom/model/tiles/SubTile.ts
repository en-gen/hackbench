import type { Char } from '../chars/Char'
import type { PixelPos, RenderContext, RenderTarget } from '../RenderTarget'

export class SubTile {
  constructor(
    readonly char: Char,
    readonly palette: number,
    readonly flipX: boolean,
    readonly flipY: boolean,
    readonly priority: boolean,
  ) {}

  render(ctx: RenderContext, target: RenderTarget, pos: PixelPos, alpha?: number): void {
    const pixels = this.char.getPixels(ctx)
    const row = ctx.palette.row(this.palette, ctx)
    target.blit8x8(pixels, pos, row, this.flipX, this.flipY, alpha)
  }
}
