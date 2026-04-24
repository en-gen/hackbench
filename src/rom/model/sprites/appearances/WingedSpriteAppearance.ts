import { ref } from '@vue/reactivity'
import { type GetL1Tile, type OverlayContext } from '../../OverlayContext'
import {
  COLORS,
  drawApexLine,
  drawBounceArc,
  drawCorridor,
  drawFadeCorridor,
  drawSineBand,
} from '../../overlays/primitives'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import { BouncingKoopaBehavior } from '../behaviors/BouncingKoopaBehavior'
import { FlyingLeftKoopaBehavior } from '../behaviors/FlyingLeftKoopaBehavior'
import { KoopaWalkBehavior } from '../behaviors/KoopaWalkBehavior'
import { SinusoidalParaKoopaBehavior } from '../behaviors/SinusoidalParaKoopaBehavior'
import { solidityFromL1 } from '../MovementBehavior'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
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
 *
 * The overlay is driven by the sprite's attached Behavior — no sprite-id
 * switch. Each MovementBehavior subclass exposes the data its overlay
 * needs (patrol range, bounce arc, sine band, fade corridor) and this
 * appearance composes the visual from shared drawing primitives.
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

  renderOverlay(
    ctx:       OverlayContext,
    x:         number,
    y:         number,
    isActive:  boolean,
    getL1:     GetL1Tile,
    levelCols: number,
    levelRows: number,
    behavior?: SpriteBehavior,
  ): void {
    if (!isActive || !behavior) return
    const { solidH, solidV } = solidityFromL1(getL1)
    ctx.save()
    if (behavior instanceof KoopaWalkBehavior) {
      // Yellow Para-Koopa ($0C): horizontal corridor bounded by walls.
      const r = behavior.computePatrolRange(x, y, solidH, solidV, levelCols, levelRows)
      drawCorridor(
        ctx,
        r.leftX, r.rightX, r.topY, r.bottomY,
        COLORS.purpleYellow,
        { solidLeft: r.leftIsWall, solidRight: r.rightIsWall },
      )
    } else if (behavior instanceof BouncingKoopaBehavior) {
      // $09 Green Para-Koopa: parabolic bounce arcs + envelope.
      const env  = behavior.simulateArc(x, y, solidH, solidV, levelCols, levelRows)
      const path = behavior.computeBouncePath(x, y, solidH, solidV, levelCols, levelRows)
      drawBounceArc(ctx, env, path, COLORS.cyanKoopa)
      drawApexLine(ctx, env.minX, env.maxX, env.minY + 0.5, COLORS.cyanKoopa)
    } else if (behavior instanceof FlyingLeftKoopaBehavior) {
      // $08 Green Para-Koopa: short fade-to-transparent corridor to the left.
      const c = behavior.computeFadeCorridor(x, y)
      drawFadeCorridor(ctx, c.originX, c.originY + 8, c.endX, c.heightPx, COLORS.cyanKoopa)
    } else if (behavior instanceof SinusoidalParaKoopaBehavior) {
      // $0A / $0B Red Para-Koopa: sine band oscillating around spawn.
      const b = behavior.computeSineBounds()
      const centerX = x + 8, centerY = y + 8
      drawSineBand(ctx, centerX, centerY, b.axis, b.amplitudePx, COLORS.cyanKoopa)
    }
    ctx.restore()
  }
}
