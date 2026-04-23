import type { Char } from '../../chars/Char'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'

export interface SpritePart {
  char: Char
  palette: number
  flipX: boolean
  flipY: boolean
  dx: number
  dy: number
}

/** Compute the tightest axis-aligned bounding rect over a set of 8×8 parts. */
export function partsHitRect(parts: Iterable<SpritePart>): HitRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of parts) {
    x0 = Math.min(x0, p.dx);     y0 = Math.min(y0, p.dy)
    x1 = Math.max(x1, p.dx + 8); y1 = Math.max(y1, p.dy + 8)
  }
  return x0 === Infinity ? { dx: 0, dy: 0, w: 16, h: 16 }
    : { dx: x0, dy: y0, w: x1 - x0, h: y1 - y0 }
}

export class StaticSpriteAppearance implements SpriteAppearance {
  readonly hitRect: HitRect

  constructor(readonly parts: readonly SpritePart[]) {
    this.hitRect = partsHitRect(parts)
  }

  render(ctx: RenderContext, target: RenderTarget, x: number, y: number): void {
    for (const part of this.parts) {
      const pixels = part.char.getPixels(ctx)
      const row = ctx.palette.row(part.palette, ctx)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
  }
}
// `behavior` arg on SpriteAppearance.render is unused here — static sprites
// draw the same parts regardless of behavioral state. TS lets us omit it.
