import { type GetL1Tile, type OverlayContext } from '../../OverlayContext'
import {
  COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH,
  drawArrowHead, rgba, WALL_ALPHA, WALL_LINE_WIDTH,
} from '../../overlays/primitives'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import { BouncingKoopaBehavior } from '../behaviors/BouncingKoopaBehavior'
import { FlyingBlockBehavior } from '../behaviors/FlyingBlockBehavior'
import { FlyingLeftKoopaBehavior } from '../behaviors/FlyingLeftKoopaBehavior'
import { KoopaWalkBehavior } from '../behaviors/KoopaWalkBehavior'
import { SinusoidalParaKoopaBehavior } from '../behaviors/SinusoidalParaKoopaBehavior'
import { WingedGoombaBehavior } from '../behaviors/WingedGoombaBehavior'
import { solidityFromL1 } from '../MovementBehavior'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'
import type { Char } from '../../chars/Char'
import type { SpriteLayout } from '../../../SpriteTileLoader'

/**
 * Sprite appearance for any sprite with animated wings driven by ctx.animFrame.
 *
 * Wing frames are two arrays of SpritePart indexed by animFrame % 2:
 *   frame 0 -- wings down (8x8 tile $5D)
 *   frame 1 -- wings up   (16x16 tile $C6, expanded to four 8x8 parts)
 *
 * Wing offsets for ? blocks ($83/$84) come from CODE_019E95 (bank_01.asm:4083)
 * pre-adjustments. Para-koopa wing offsets ($0A/$0B/$0C) come from the raw
 * KoopaWingGfxRt tables (bank_01.asm:4006) with no pre-adjustment.
 *
 * wingsInFront controls draw order:
 *   false (default) -- wings before body (wings behind, used for ? blocks)
 *   true            -- body before wings  (wings in front, used for para-koopas)
 *
 * The overlay is driven by the sprite's attached Behavior -- no sprite-id
 * switch. Each MovementBehavior subclass exposes the data its overlay
 * needs (patrol range, bounce arc, sine band, fade corridor) and this
 * appearance composes the visual from shared drawing primitives.
 */

function strokeDashedPolyline(
  ctx:    OverlayContext,
  points: readonly { x: number; y: number }[],
  color:  { r: number; g: number; b: number },
): void {
  if (points.length < 2) return
  ctx.lineWidth   = DASH_LINE_WIDTH
  ctx.strokeStyle = rgba(color, DASH_ALPHA)
  ctx.setLineDash([...DEFAULT_DASH])
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
  ctx.stroke()
  ctx.setLineDash([])
}

export class WingedSpriteAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private frame = 0

  constructor(
    readonly bodyParts: readonly SpritePart[],
    readonly wingFrames: readonly [readonly SpritePart[], readonly SpritePart[]],
    readonly wingsInFront: boolean = false,
  ) {
    this.hitRect = partsHitRect([...bodyParts, ...wingFrames[0], ...wingFrames[1]])
  }

  tickAnimation(): void {
    this.frame = (this.frame + 1) % this.wingFrames.length
  }

  render(_ctx: RenderContext, target: RenderTarget, x: number, y: number): void {
    const wingParts = this.wingFrames[this.frame]
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
    ctx:          OverlayContext,
    x:            number,
    y:            number,
    isActive:     boolean,
    getL1:        GetL1Tile,
    levelCols:    number,
    levelRows:    number,
    behavior?:    SpriteBehavior,
    marioSpawnX?: number,
  ): void {
    if (!isActive || !behavior) return
    const { solidH, solidV } = solidityFromL1(getL1)
    const color = COLORS.patrolPath

    ctx.save()

    if (behavior instanceof BouncingKoopaBehavior) {
      // Per-frame trajectory polyline — strokes as a smooth dashed arc.
      // Only the toward-Mario direction is simulated (matches FaceMario init
      // at bank_01.asm:847-850). marioSpawnX defaults to 0 inside the
      // behavior when the level didn't parse Mario's spawn position.
      // getL1 enables slope-aware landing so arcs touch slope surfaces.
      const { points } = behavior.computeBouncePolyline(
        x, y, solidH, solidV, levelCols, levelRows, marioSpawnX, getL1,
      )
      strokeDashedPolyline(ctx, points, color)
      if (points.length >= 2) {
        const tip  = points[points.length - 1]
        const from = points[points.length - 2]
        drawArrowHead(ctx, tip.x, tip.y, from.x, from.y, color, DASH_ALPHA)
      }

    } else if (behavior instanceof WingedGoombaBehavior) {
      // $10 Para-Goomba bounce arc — full 4-bounce cycle (3 short + 1 tall),
      // toward Mario's spawn X (FaceMario init, bank_01.asm:847-850).
      // getL1 enables slope-aware landing so arcs touch slope surfaces.
      const { points } = behavior.computeBouncePolyline(
        x, y, solidH, solidV, levelCols, levelRows, marioSpawnX, getL1,
      )
      strokeDashedPolyline(ctx, points, color)
      if (points.length >= 2) {
        const tip  = points[points.length - 1]
        const from = points[points.length - 2]
        drawArrowHead(ctx, tip.x, tip.y, from.x, from.y, color, DASH_ALPHA)
      }

    } else if (behavior instanceof FlyingLeftKoopaBehavior) {
      // Horizontal dashed line at body-center, fading off to the left.
      // Arrow at the far end shows the koopa flies indefinitely in that direction.
      const c = behavior.computeFadeCorridor(x, y)
      const midY = c.originY + 8
      ctx.lineWidth   = DASH_LINE_WIDTH
      ctx.strokeStyle = rgba(color, DASH_ALPHA)
      ctx.setLineDash([...DEFAULT_DASH])
      ctx.beginPath()
      ctx.moveTo(c.originX, midY)
      ctx.lineTo(c.endX, midY)
      ctx.stroke()
      ctx.setLineDash([])
      drawArrowHead(ctx, c.endX, midY, c.originX, midY, color, DASH_ALPHA)

    } else if (behavior instanceof SinusoidalParaKoopaBehavior) {
      // Sinusoidal patrol — $0A vertical / $0B horizontal Para-Koopa.
      // The dashed line marks the centerline of the back-and-forth path
      // (length = 2·amplitude). Solid endcaps perpendicular to the path
      // at each end signal the reversal points (same vocabulary as the
      // walk-koopa wall lines: "the sprite turns around here").
      const b = behavior.computeSineBounds()
      const centerX = x + 8, centerY = y + 8
      const ENDCAP_HALF = 8  // half body — endcap = sprite-sized stub
      ctx.lineWidth   = DASH_LINE_WIDTH
      ctx.strokeStyle = rgba(color, DASH_ALPHA)
      ctx.setLineDash([...DEFAULT_DASH])
      ctx.beginPath()
      if (b.axis === 'vertical') {
        ctx.moveTo(centerX, centerY - b.amplitudePx)
        ctx.lineTo(centerX, centerY + b.amplitudePx)
      } else {
        ctx.moveTo(centerX - b.amplitudePx, centerY)
        ctx.lineTo(centerX + b.amplitudePx, centerY)
      }
      ctx.stroke()
      ctx.setLineDash([])

      // Solid endcaps. Vertical patrol → horizontal stubs at top/bottom;
      // horizontal patrol → vertical stubs at left/right.
      ctx.lineWidth   = WALL_LINE_WIDTH
      ctx.strokeStyle = rgba(color, WALL_ALPHA)
      ctx.beginPath()
      if (b.axis === 'vertical') {
        const yTop = centerY - b.amplitudePx
        const yBot = centerY + b.amplitudePx
        ctx.moveTo(centerX - ENDCAP_HALF, yTop); ctx.lineTo(centerX + ENDCAP_HALF, yTop)
        ctx.moveTo(centerX - ENDCAP_HALF, yBot); ctx.lineTo(centerX + ENDCAP_HALF, yBot)
      } else {
        const xLeft  = centerX - b.amplitudePx
        const xRight = centerX + b.amplitudePx
        ctx.moveTo(xLeft,  centerY - ENDCAP_HALF); ctx.lineTo(xLeft,  centerY + ENDCAP_HALF)
        ctx.moveTo(xRight, centerY - ENDCAP_HALF); ctx.lineTo(xRight, centerY + ENDCAP_HALF)
      }
      ctx.stroke()

    } else if (behavior instanceof KoopaWalkBehavior) {
      // Super-koopa walking phase or other ground-walker on a winged body.
      // Centerline dashed at body midpoint between leftX and rightX.
      const r = behavior.computePatrolRange(x, y, solidH, solidV, levelCols, levelRows)
      const midY = (r.topY + r.bottomY) / 2
      ctx.lineWidth   = DASH_LINE_WIDTH
      ctx.strokeStyle = rgba(color, DASH_ALPHA)
      ctx.setLineDash([...DEFAULT_DASH])
      ctx.beginPath()
      ctx.moveTo(r.leftX, midY)
      ctx.lineTo(r.rightX, midY)
      ctx.stroke()
      ctx.setLineDash([])

    } else if (behavior instanceof FlyingBlockBehavior) {
      // Both $83 and $84 drift left while oscillating in Y, producing a
      // sinusoidal path. $83 moves at constant speed; $84 accelerates to
      // its max speed over ~64 frames (wider horizontal spacing after that).
      // Passes through walls — no collision call in Flying_Block.
      const pts = behavior.computePath(x, y)
      strokeDashedPolyline(ctx, pts, color)
      if (pts.length >= 2) {
        const tip  = pts[pts.length - 1]
        const from = pts[pts.length - 2]
        drawArrowHead(ctx, tip.x, tip.y, from.x, from.y, color, DASH_ALPHA)
      }
    }

    ctx.restore()
  }

  private static layoutToBodyParts(
    layout: SpriteLayout | null,
    chars: Map<number, Char>,
    placeholder: Char,
  ): SpritePart[] {
    return (layout?.tiles ?? []).map(t => ({
      char: chars.get(t.charNum) ?? placeholder,
      palette: t.palette, flipX: t.flipX, flipY: t.flipY, dx: t.dx, dy: t.dy,
    }))
  }

  /**
   * Para-koopa wing frames from KoopaWingGfxRt (bank_01.asm:4006).
   * Shows right wing (SpriteMisc157C=1 -> right-facing body by default).
   * Frame 0: 16x16 right wing open (tile $C6, table index 3).
   * Frame 1: 8x8 right wing closed (tile $5D, table index 2).
   */
  private static buildKoopaWingFrames(
    chars: Map<number, Char>,
    placeholder: Char,
  ): [SpritePart[], SpritePart[]] {
    const WING_PAL = 11
    const BASE = 0x400
    const c = (n: number) => chars.get(BASE + n) ?? placeholder
    const p = (n: number, dx: number, dy: number, flipX: boolean): SpritePart =>
      ({ char: c(n), palette: WING_PAL, flipX, flipY: false, dx, dy })
    const wf0: SpritePart[] = [
      p(0xC6,  9, -12, false), p(0xC7, 17, -12, false),
      p(0xD6,  9,  -4, false), p(0xD7, 17,  -4, false),
    ]
    const wf1: SpritePart[] = [p(0x5D, 9, -4, false)]
    return [wf0, wf1]
  }

  /**
   * $08/$09 (Green Para-Koopa) and $0A/$0B/$0C (Red/Yellow Para-Koopa).
   * All share the Spr0to13Gfx -> KoopaWingGfxRt path with wingsInFront=true.
   */
  static fromParaKoopa(
    chars: Map<number, Char>,
    placeholder: Char,
    layout: SpriteLayout | null,
  ): WingedSpriteAppearance {
    const bodyParts = WingedSpriteAppearance.layoutToBodyParts(layout, chars, placeholder)
    const [wf0, wf1] = WingedSpriteAppearance.buildKoopaWingFrames(chars, placeholder)
    return new WingedSpriteAppearance(bodyParts, [wf0, wf1], true)
  }

  /**
   * $10 Para-Goomba. GoombaWingGfxRt (bank_01.asm:2022).
   * Frame 0: 16x16 wings open ($C6). Frame 1: 8x8 wings closed ($5D).
   * Left wing is H-flipped; right wing is not (GoombaWingGfxProp $46/$06 + EOR $40).
   * wingsInFront=false (wings behind goomba body).
   */
  static fromParaGoomba(
    chars: Map<number, Char>,
    placeholder: Char,
    layout: SpriteLayout | null,
  ): WingedSpriteAppearance {
    const gBody = WingedSpriteAppearance.layoutToBodyParts(layout, chars, placeholder)
    const GPAL = 11
    const GBASE = 0x400
    const gc = (n: number) => chars.get(GBASE + n) ?? placeholder
    const gp = (n: number, dx: number, dy: number, flipX: boolean): SpritePart =>
      ({ char: gc(n), palette: GPAL, flipX, flipY: false, dx, dy })
    // GoombaWingGfxRt (bank_01.asm:2022):
    // iter=1 → GoombaWingGfxProp[1]=$06 EOR $40=$46 → left wing is H-flipped.
    // iter=0 → GoombaWingGfxProp[0]=$46 EOR $40=$06 → right wing is not flipped.
    // X offsets: DATA_018DC7 with _4=0 adds 8; left=index9=$F5=-11, right=index8=$0B=+11.
    // Frame-1 X: left=index13=$FC=-4, right=index12=$0B=+11. Y always+1 (DATA_018DD7[4/5]).
    const gwf0: SpritePart[] = [
      // Left wing: H-flipped 16x16 $C6 at (-11, -9) — col order swaps for H-flip
      gp(0xC7, -11, -9, true),  gp(0xC6,  -3, -9, true),
      gp(0xD7, -11,  -1, true), gp(0xD6,  -3,  -1, true),
      // Right wing: no-flip 16x16 $C6 at (+11, -9)
      gp(0xC6,  11, -9, false), gp(0xC7,  19, -9, false),
      gp(0xD6,  11,  -1, false), gp(0xD7,  19,  -1, false),
    ]
    const gwf1: SpritePart[] = [
      gp(0x5D, -4, 1, true),   // left wing: H-flipped, X=DATA_018DC7[13]=-4
      gp(0x5D, 11, 1, false),  // right wing: no-flip, X=DATA_018DC7[12]=+11
    ]
    return new WingedSpriteAppearance(gBody, [gwf0, gwf1])
  }

  /**
   * $83/$84 (Left/Right Flying ? Block). Wing offsets from CODE_019E95
   * (bank_01.asm:4083) pre-adjustment path; para-koopas skip that path.
   * Frame 0: 8x8 tile $5D per wing (small).
   * Frame 1: 16x16 tile $C6 per wing (large), split into four 8x8 parts.
   * wingsInFront=false (wings behind block body).
   */
  static fromFlyingQBlock(
    chars: Map<number, Char>,
    placeholder: Char,
    layout: SpriteLayout | null,
  ): WingedSpriteAppearance {
    const bodyParts = WingedSpriteAppearance.layoutToBodyParts(layout, chars, placeholder)
    const WING_PAL = 11
    const BASE = 0x400
    const c = (n: number) => chars.get(BASE + n) ?? placeholder
    const p = (n: number, dx: number, dy: number, flipX: boolean): SpritePart =>
      ({ char: c(n), palette: WING_PAL, flipX, flipY: false, dx, dy })
    const wf0: SpritePart[] = [
      p(0x5D,  -3, -2, true),
      p(0x5D,  11, -2, false),
    ]
    const wf1: SpritePart[] = [
      p(0xC7, -11, -10, true),  p(0xC6,  -3, -10, true),
      p(0xD7, -11,  -2, true),  p(0xD6,  -3,  -2, true),
      p(0xC6,  11, -10, false), p(0xC7,  19, -10, false),
      p(0xD6,  11,  -2, false), p(0xD7,  19,  -2, false),
    ]
    return new WingedSpriteAppearance(bodyParts, [wf0, wf1])
  }
}
