import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { SuperKoopaBehavior } from '../behaviors/SuperKoopaBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'

/**
 * A two-frame flap animation. `flapA` renders when `ctx.animFrame` is even,
 * `flapB` when odd. Grounded poses that don't visually animate use identical
 * parts for both.
 */
export interface SuperKoopaPoseFrames {
  readonly flapA: readonly SpritePart[]
  readonly flapB: readonly SpritePart[]
}

/**
 * Super Koopa ($71/$72/$73) appearance.
 *
 * Pose selection (airborne vs grounded) is fixed at construction from the
 * factory's L1-below check. Flash state (feather-drop cape alternation) is
 * evaluated per render-frame from `behavior.dropsFeather(x)`, so moving the
 * sprite in the editor re-resolves whether the cape flashes.
 *
 * Pose geometry is Frame 0 (bank_02.asm:14373+$00) for grounded, Frames 2
 * and 3 alternated for airborne (+$08, +$0C). Cape flash alternates the
 * palette-override value between $10 (CGRAM row 8) and $0A (CGRAM row 13)
 * per CODE_02ED3B at bank_02.asm:14434, which reads `DATA_02ED39 db $10,$0A`
 * when `SpriteMisc1534 != 0` (set by `InitSuperKoopaFthr`'s feather-drop
 * branch).
 *
 * Flap index comes from `ctx.animFrame.value & 1` — the same shared reactive
 * counter tile animations already depend on. Using a local `ref` per sprite
 * fans N animated Super Koopas into N map re-renders per tick and visibly
 * slows tile animations (coins etc.); reading the shared counter gives a
 * single reactive dep regardless of sprite count.
 */
export class SuperKoopaAppearance implements SpriteAppearance {
  readonly hitRect: HitRect

  constructor(
    readonly grounded:       SuperKoopaPoseFrames,
    readonly groundedFlash:  SuperKoopaPoseFrames,
    readonly airborne:       SuperKoopaPoseFrames,
    readonly airborneFlash:  SuperKoopaPoseFrames,
    readonly isAirborne:     boolean,
  ) {
    this.hitRect = partsHitRect([
      ...grounded.flapA, ...grounded.flapB,
      ...groundedFlash.flapA, ...groundedFlash.flapB,
      ...airborne.flapA, ...airborne.flapB,
      ...airborneFlash.flapA, ...airborneFlash.flapB,
    ])
  }

  render(
    ctx:      RenderContext,
    target:   RenderTarget,
    x:        number,
    y:        number,
    behavior: SpriteBehavior,
  ): void {
    const flashing = behavior instanceof SuperKoopaBehavior && behavior.dropsFeather(x)
    const pose = this.isAirborne
      ? (flashing ? this.airborneFlash : this.airborne)
      : (flashing ? this.groundedFlash : this.grounded)
    const parts = (ctx.animFrame.value & 1) === 0 ? pose.flapA : pose.flapB
    for (const part of parts) {
      const pixels = part.char.getPixels(ctx)
      const row = ctx.palette.row(part.palette, ctx)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
  }
}
