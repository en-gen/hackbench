import { ref } from '@vue/reactivity'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite appearance for any sprite with animated wings driven by `ctx.animFrame`.
 *
 * Wing frames are two arrays of SpritePart indexed by `animFrame % 2`:
 *   frame 0 — wings down (8×8 tile $5D)
 *   frame 1 — wings up   (16×16 tile $C6, expanded to four 8×8 parts)
 *
 * Wing offsets for ? blocks ($83/$84) come from CODE_019E95 (bank_01.asm:4083)
 * pre-adjustments. Para-koopa wing offsets ($0A/$0B/$0C) come from the raw
 * KoopaWingGfxRt tables (bank_01.asm:4006) with no pre-adjustment.
 *
 * `wingsInFront` controls draw order:
 *   false (default) — wings before body (wings behind, used for ? blocks)
 *   true            — body before wings  (wings in front, used for para-koopas)
 */
export class WingedSpriteAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private readonly frame = ref(0)

  constructor(
    readonly bodyParts: readonly SpritePart[],
    readonly wingFrames: readonly [readonly SpritePart[], readonly SpritePart[]],
    readonly wingsInFront: boolean = false,
  ) {
    this.hitRect = partsHitRect([...bodyParts, ...wingFrames[0], ...wingFrames[1]])
  }

  tickAnimation(): void {
    this.frame.value = (this.frame.value + 1) % this.wingFrames.length
  }

  render(_ctx: RenderContext, target: RenderTarget, x: number, y: number): void {
    const wingParts = this.wingFrames[this.frame.value]
    const blit = (part: SpritePart) => {
      const pixels = part.char.getPixels(_ctx)
      const row = _ctx.palette.row(part.palette, _ctx)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
    if (this.wingsInFront) {
      for (const part of this.bodyParts) blit(part)
      for (const part of wingParts) blit(part)
    } else {
      for (const part of wingParts) blit(part)
      for (const part of this.bodyParts) blit(part)
    }
  }
}
