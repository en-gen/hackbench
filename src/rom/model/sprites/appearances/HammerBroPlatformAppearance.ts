import { ref } from '@vue/reactivity'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $9C (Hammer Brother Platform / Flying Block Platform).
 *
 * FlyingPlatformGfx (bank_02.asm:12216) writes 4 OAM entries, split into
 * a static platform body and an animated 2-frame wing pair:
 *
 *   Frame 0 (EffFrame bit 3 = 0):
 *     big-tile $40 at ( 0,   0)                     -- platform left
 *     big-tile $40 at (+16,  0)                     -- platform right
 *     big-tile $C6 at (-14, -10)  flipX             -- left wing
 *     big-tile $C6 at (+30, -10)                    -- right wing
 *
 *   Frame 1 (EffFrame bit 3 = 1):
 *     big-tile $40 at ( 0,   0)                     -- platform left (same)
 *     big-tile $40 at (+16,  0)                     -- platform right (same)
 *     8×8 tile $5D at ( -6,  -2)  flipX             -- left wing
 *     8×8 tile $5D at (+30,  -2)                    -- right wing
 *
 * All tiles use OBJ palette 1 (attr $32 & $0F = $02 → CGRAM row 9),
 * charHigh 0.
 *
 * Wing animation selector matches `WingedSpriteAppearance`:
 * `ctx.animFrame.value % 2`. The store's animFrame is a tile-graphics
 * counter (level-data-driven cadence, ~133ms/tick by default) rather than
 * a 60Hz game clock — so the ASM's `EffFrame>>1 & 4` (flip-every-8-game-
 * frames ≈ 133ms) happens to line up closely. Exact fidelity would need a
 * separate 60Hz counter, but the visual result here reads as a flapping
 * wing pair at a natural rate.
 *
 * Platform parts render first (behind), wings render on top — matches
 * SNES OAM priority (lower OAM index = higher priority = drawn later in
 * our flat-painter loop).
 */
export class HammerBroPlatformAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private readonly frame = ref(0)

  constructor(
    readonly platformParts: readonly SpritePart[],
    readonly wingFrames: readonly [readonly SpritePart[], readonly SpritePart[]],
  ) {
    this.hitRect = partsHitRect([
      ...platformParts,
      ...wingFrames[0],
      ...wingFrames[1],
    ])
  }

  tickAnimation(): void {
    this.frame.value = (this.frame.value + 1) % this.wingFrames.length
  }

  render(ctx: RenderContext, target: RenderTarget, x: number, y: number): void {
    for (const part of this.platformParts) {
      const pixels = part.char.getPixels(ctx)
      const row = ctx.palette.row(part.palette, ctx)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
    for (const part of this.wingFrames[this.frame.value]) {
      const pixels = part.char.getPixels(ctx)
      const row = ctx.palette.row(part.palette, ctx)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
  }
}
