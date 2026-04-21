import type { Char } from '../../chars/Char'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { SpriteAppearance } from '../SpriteAppearance'

export interface SpritePart {
  char: Char
  palette: number
  flipX: boolean
  flipY: boolean
  dx: number
  dy: number
}

export class StaticSpriteAppearance implements SpriteAppearance {
  constructor(readonly parts: readonly SpritePart[]) {}

  render(ctx: RenderContext, target: RenderTarget, x: number, y: number): void {
    for (const part of this.parts) {
      const pixels = part.char.getPixels(ctx)
      const row = ctx.palette.row(part.palette, ctx)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
  }
}
