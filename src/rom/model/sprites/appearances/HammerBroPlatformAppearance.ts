import { ref } from '@vue/reactivity'
import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'

/**
 * Precomputed 256-frame movement path for the $9C Hammer Bro Platform.
 *
 * Faithful to CODE_02DB5C (bank_02.asm:12149-12174):
 *   - Even frames: XSpeed += ±1 toward ±$20; YSpeed += ±2 toward ±$20,
 *     with direction flipping when speed equals target.
 *   - Every frame: pos += speed (UpdateXPosNoGrvty / UpdateYPosNoGrvty).
 * Starting state is zeroed so the path begins at the spawn anchor.
 */
const PLATFORM_PATH: readonly { x: number; y: number }[] = (() => {
  const s8 = (v: number): number => ((v + 128) & 0xFF) - 128
  const X_ACC = [ 1, -1], X_TGT = [0x20, 0xE0]
  const Y_ACC = [ 2, -2], Y_TGT = [0x20, 0xE0]
  let xSpeed = 0, ySpeed = 0, xState = 0, yState = 0
  let xPos = 0, yPos = 0
  const pts: { x: number; y: number }[] = []
  for (let frame = 0; frame < 256; frame++) {
    if ((frame & 1) === 0) {
      const xi = xState & 1
      const nx = s8(xSpeed + X_ACC[xi])
      if ((nx & 0xFF) === X_TGT[xi]) xState = (xState + 1) & 0xFF
      xSpeed = nx
      const yi = yState & 1
      const ny = s8(ySpeed + Y_ACC[yi])
      if ((ny & 0xFF) === Y_TGT[yi]) yState = (yState + 1) & 0xFF
      ySpeed = ny
    }
    xPos += xSpeed
    yPos += ySpeed
    pts.push({ x: xPos / 16, y: yPos / 16 })
  }
  return pts
})()

/** Bounding box of PLATFORM_PATH. */
const PLATFORM_BOUNDS = (() => {
  let minX = 0, maxX = 0, minY = 0, maxY = 0
  for (const p of PLATFORM_PATH) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, maxX, minY, maxY }
})()

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

  renderOverlay(
    ctx:      OverlayContext,
    x:        number,
    y:        number,
    isActive: boolean,
    _getL1:     GetL1Tile,
    _levelCols: number,
    _levelRows: number,
  ): void {
    if (!isActive) return
    const { minX, maxX, minY, maxY } = PLATFORM_BOUNDS
    const rx    = (maxX - minX) / 2
    const ry    = maxY - minY
    const cx    = x + minX + rx
    const topY  = y + minY

    ctx.save()
    ctx.fillStyle = 'rgba(255,220,40,0.12)'
    ctx.beginPath()
    ctx.ellipse(cx, topY, rx, ry, 0, 0, Math.PI)
    ctx.closePath()
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = 'rgba(255,220,40,0.70)'
    ctx.beginPath()
    ctx.ellipse(cx, topY, rx, ry, 0, 0, Math.PI)
    ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,220,40,0.95)'
    ctx.beginPath()
    ctx.moveTo(x - 3, y + 0.5); ctx.lineTo(x + 4, y + 0.5)
    ctx.moveTo(x + 0.5, y - 3); ctx.lineTo(x + 0.5, y + 4)
    ctx.stroke()
    ctx.restore()
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
