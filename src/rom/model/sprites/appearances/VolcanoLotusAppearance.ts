import { ref } from '@vue/reactivity'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $99 (Volcano Lotus).
 *
 * VolcanoLotusGfx (bank_02.asm:12711) writes 4 OAM entries:
 *   - 2 × 16×16 head big-tiles (base char $CE, OBJ palette 5 = CGRAM row 13);
 *     left at dx=-8 unflipped, right at dx=+8 flipped.
 *   - 2 × 8×8 flower chars from `VolcanoLotusTiles` (bank_02.asm:12708)
 *     = { $8E, $9E, $E2 } indexed by SpriteMisc1602.
 *     Left at dx=0, right at dx=+8 (base+1).
 *
 * In-game, CODE_02DFC9 (bank_02.asm:12666) sets SpriteMisc1602 each game
 * frame from bit 3 of the decrementing $1540 timer: `LSR #3; AND #$01`.
 * $1540 decrements every game frame, so bit 3 flips every 8 game frames —
 * meaning the flower holds $8E for 8 frames, $9E for 8 frames, and so on.
 *
 * The editor's tile-animation tick is `8 / NTSC_FPS * 1000 ≈ 133ms`
 * (ANIM_INTERVAL_MS in AnimationLoader.ts) — one editor tick is exactly
 * 8 SNES game frames. So advancing the flower by one frame per editor
 * tick matches the ASM cadence exactly: idle 8 game frames, blink 8
 * game frames. The canvas redraws at rAF rate (60fps), but the flower
 * frame index only changes on tick — which is the point of ref(): render
 * reads the same value for ~8 redraws before it changes.
 *
 * The attack/rising poses ($E2 open mouth, CGRAM row 10 flash) are not
 * reachable from the editor snapshot — those are transient runtime states
 * triggered by Mario proximity, not stable visual identity.
 *
 * Head parts render first (behind), flower parts render on top — matches
 * in-game OAM priority where lower OAM index ($100/$104 head) draws after
 * higher index ($108/$10C flower), so head is visually in front of flower.
 * Our flat painter draws later parts on top, so flower goes last here.
 */
export class VolcanoLotusAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private readonly frame = ref(0)

  constructor(
    readonly headParts: readonly SpritePart[],
    readonly flowerFrames: readonly [readonly SpritePart[], readonly SpritePart[]],
  ) {
    this.hitRect = partsHitRect([
      ...headParts,
      ...flowerFrames[0],
      ...flowerFrames[1],
    ])
  }

  tickAnimation(): void {
    this.frame.value = (this.frame.value + 1) % this.flowerFrames.length
  }

  render(ctx: RenderContext, target: RenderTarget, x: number, y: number): void {
    const blit = (part: SpritePart) => {
      const pixels = part.char.getPixels(ctx)
      const row = ctx.palette.row(part.palette, ctx)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
    for (const part of this.headParts) blit(part)
    for (const part of this.flowerFrames[this.frame.value]) blit(part)
  }
}
