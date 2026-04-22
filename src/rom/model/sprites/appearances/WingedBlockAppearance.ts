import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { SpriteAppearance } from '../SpriteAppearance'
import type { SpritePart } from './StaticSpriteAppearance'

/**
 * Flying Question Block ($83/$84) appearance.
 *
 * Renders a 16×16 ? block body plus two animated 8×8 wing tiles driven by
 * `ctx.animFrame`. Wing animation mirrors KoopaWingGfxRt (bank_01.asm:4024):
 *
 *   frame 0 (wings down): char $5D, dy=-2,  left dx=-3,  right dx=+11
 *   frame 1 (wings up):   char $C6, dy=-10, left dx=-11, right dx=+11
 *
 * X/Y offsets are derived from CODE_019E95 (bank_01.asm:4083) pre-adjustments
 * plus KoopaWingDispXLo/Y table entries (indices 0/1 for left, 2/3 for right).
 * Wings use OBJ palette 3 (CGRAM row 11) from KoopaWingGfxProp $46/$06.
 */
export class WingedBlockAppearance implements SpriteAppearance {
  constructor(
    readonly bodyParts: readonly SpritePart[],
    /** Two wing-frame layouts indexed by animFrame % 2. */
    readonly wingFrames: readonly [readonly SpritePart[], readonly SpritePart[]],
  ) {}

  render(ctx: RenderContext, target: RenderTarget, x: number, y: number): void {
    const wingParts = this.wingFrames[ctx.animFrame.value % 2]
    for (const part of wingParts) {
      const pixels = part.char.getPixels(ctx)
      const row = ctx.palette.row(part.palette, ctx)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
    for (const part of this.bodyParts) {
      const pixels = part.char.getPixels(ctx)
      const row = ctx.palette.row(part.palette, ctx)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
  }
}
