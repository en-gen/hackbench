import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'

/**
 * P-Switch (sprite $3E): selects blue or silver OBJ palette at render time
 * from the sprite's pixel X position, matching InitPSwitch (bank_01.asm:665).
 *
 * InitPSwitch shifts SpriteXPosLow right 4 and ANDs with 1, then indexes
 * PSwitchPal[$06, $02]:
 *   even tile column → $06 → OBJ palette 3 → CGRAM row 11 (blue)
 *   odd tile column  → $02 → OBJ palette 1 → CGRAM row 9  (silver)
 *
 * The `palette` field on each SpritePart is ignored; color is entirely
 * determined here from the `x` coordinate passed by the renderer.
 */
export class PSwitchAppearance implements SpriteAppearance {
  static readonly BLUE_PALETTE   = 8 + ((0x06 >> 1) & 0x07)  // 11
  static readonly SILVER_PALETTE = 8 + ((0x02 >> 1) & 0x07)  // 9

  readonly hitRect: HitRect

  constructor(readonly parts: readonly SpritePart[]) {
    this.hitRect = partsHitRect(parts)
  }

  render(ctx: RenderContext, target: RenderTarget, x: number, y: number): void {
    const palette = ((x >> 4) & 1) === 0
      ? PSwitchAppearance.BLUE_PALETTE
      : PSwitchAppearance.SILVER_PALETTE
    for (const part of this.parts) {
      const pixels = part.char.getPixels(ctx)
      const row = ctx.palette.row(palette, ctx)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
  }
}
