import { type GetL1Tile, type OverlayContext } from '../../OverlayContext'
import {
  COLORS,
  drawApexLine,
  drawCorridor,
  drawVertLane,
} from '../../overlays/primitives'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $47 Swimming/Jumping fish — full ASM port.
 *
 * Handler: `SwimJumpFishMain` → `CODE_02E727` (bank_02.asm:13649-13735).
 * Globally, `bank_01.asm:157-159` decrements `SpriteMisc1540` once per
 * frame (when nonzero) before the main handler runs. The handler then
 * dispatches on `SpriteTableC2 & 1`:
 *
 *   STATE 0 — swim (CODE_02E74E):
 *     XSpeed from DATA_02E74C = [$14, $EC] indexed by `misc157C`.
 *     UpdateXPosNoGrvty applies XSpeed (1 sub-px/16 = 1/16 px/frame).
 *     When `misc1540 == 0`, INC `misc1570`:
 *       - misc1570 == 4 → goto CODE_02E77C: enter jump state,
 *         misc1540 = $80, YSpeed = $A0 (-96 signed = -6 px/frame).
 *       - misc1570 == 3 → reload misc1540 = $20 and flip misc157C.
 *       - otherwise   → reload misc1540 = $40 and flip misc157C.
 *
 *   STATE 1 — jump (CODE_02E788):
 *     If misc1540 == 0 → CODE_02E7A4: snap Y low byte to $F0 grid,
 *       INC SpriteTableC2 (back to swim), misc1570 = 0, misc1540 = $20.
 *     If misc1540 >= $70 (first 16 frames of jump) → anticipation,
 *       no movement (fish hangs at launch point).
 *     Otherwise → XSpeed = 0, UpdateYPosNoGrvty applied, and gravity
 *       adds +2 to YSpeed each frame except when YSpeed is non-negative
 *       and already >= $30 (+48 = +3 px/frame fall cap).
 *
 * Empirically the first swim cycle (starting from all-zero misc state)
 * produces X-range [-78.75, +1.25] px from spawn; jump apex = -147 px.
 * Cycle 2+ enters swim with misc1540 = $20 and misc157C = 1, giving a
 * symmetric X oscillation of ±40 around the second cycle's anchor —
 * but because the net cycle-1 X drift is -38.75 and cycle-2+ is zero,
 * the steady-state swim corridor is [-78.75, +1.25] relative to spawn.
 * We simulate 2 full cycles to pick up both the one-time and steady
 * patterns.
 *
 * Overlay:
 *   - Swim corridor: rectangular band from min swim-X to max swim-X
 *     at simulated swim Y (spawn row + tile below).
 *   - Jump zone: narrower rect centered on each unique swim-X column
 *     the simulation visits at jump launch, rising to min jump-Y.
 *   - Apex line: dashed marker at min jump-Y.
 *   - Path polyline: dashed trail of simulated frames for visual proof.
 */

const s8 = (v: number): number => ((v + 128) & 0xFF) - 128

/** One simulation step. Mutates the state in place. */
interface FishSim {
  subX: number  // sub-pixel X (256 = 1 px), signed
  subY: number  // sub-pixel Y
  xSpeed: number
  ySpeed: number
  state: 0 | 1  // SpriteTableC2 & 1
  m1540: number
  m1570: number
  m157C: 0 | 1
}

const SWIM_SPEEDS = [0x14, 0xEC] as const

function tick(s: FishSim): void {
  // 1) Global timer decrement (bank_01.asm:157-159).
  if (s.m1540 > 0) s.m1540--

  if (s.state === 0) {
    // CODE_02E74E — swim
    s.xSpeed = SWIM_SPEEDS[s.m157C]
    s.subX += s8(s.xSpeed) * 16  // UpdateXPosNoGrvty
    if (s.m1540 !== 0) return
    s.m1570++
    if (s.m1570 === 4) {
      // CODE_02E77C — launch jump
      s.state = 1
      s.m1540 = 0x80
      s.ySpeed = 0xA0  // -96 signed
      return
    }
    s.m157C = (s.m157C ^ 1) as 0 | 1
    s.m1540 = (s.m1570 === 3) ? 0x20 : 0x40
    return
  }

  // CODE_02E788 — jump
  if (s.m1540 === 0) {
    // CODE_02E7A4 — snap Y low byte to $F0 grid, back to swim.
    const pixelY  = Math.floor(s.subY / 256)
    const yLow    = pixelY & 0xFF
    const yHigh   = (pixelY >> 8) & 0xFF
    const newLow  = yLow & 0xF0
    let   newY16  = (yHigh << 8) | newLow
    if (newY16 >= 0x8000) newY16 -= 0x10000
    s.subY   = newY16 * 256 + (((s.subY % 256) + 256) % 256)
    s.state  = 0
    s.m1570  = 0
    s.m1540  = 0x20
    return
  }
  if (s.m1540 >= 0x70) return  // anticipation
  s.xSpeed = 0
  s.subY += s8(s.ySpeed) * 16  // UpdateYPosNoGrvty
  const ys = s8(s.ySpeed)
  if (ys < 0 || ys < 0x30) {
    s.ySpeed = (s.ySpeed + 2) & 0xFF
  }
}

/** Simulated path for 2 full swim+jump cycles (≈ 580 frames). Anchored at (0,0). */
const FISH_PATH: readonly { x: number; y: number; state: 0 | 1 }[] = (() => {
  const s: FishSim = {
    subX: 0, subY: 0, xSpeed: 0, ySpeed: 0,
    state: 0, m1540: 0, m1570: 0, m157C: 0,
  }
  const pts: { x: number; y: number; state: 0 | 1 }[] = []
  for (let f = 0; f < 600; f++) {
    tick(s)
    pts.push({
      x: Math.floor(s.subX / 256),
      y: Math.floor(s.subY / 256),
      state: s.state,
    })
  }
  return pts
})()

const FISH_BOUNDS = (() => {
  let minX = 0, maxX = 0, minY = 0, maxY = 0
  let swimMinX = 0, swimMaxX = 0
  for (const p of FISH_PATH) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
    if (p.state === 0) {
      if (p.x < swimMinX) swimMinX = p.x
      if (p.x > swimMaxX) swimMaxX = p.x
    }
  }
  return { minX, maxX, minY, maxY, swimMinX, swimMaxX }
})()

export class SwimJumpFishAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }

  /**
   * $47 movement is an **upside-down T**:
   *   - Horizontal "swim band" at the water-level row (swim state).
   *   - Vertical "jump column" centered on spawn X rising to apex-Y
   *     (jump state — the fish launches straight up, water drag keeps the
   *     horizontal excursion near zero during the jump state).
   * The overlay renders those as two distinct primitives that meet at the
   * spawn column, plus an apex line marking the peak height.
   */
  override renderOverlay(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    _getL1:     GetL1Tile,
    _levelCols: number,
    _levelRows: number,
  ): void {
    if (!isActive) return

    const { minY, swimMinX, swimMaxX } = FISH_BOUNDS
    const spawnCenterX = x + 8
    const swimLeftX  = x + swimMinX
    const swimRightX = x + swimMaxX
    // Swim band is 2 tiles tall (spawn row + row below) so the lane reads
    // clearly with the sprite body drawn on top of the spawn row.
    const swimTopY    = y
    const swimBottomY = y + 32
    const jumpTopY    = y + minY        // minY is negative (apex above spawn)
    // Jump column: sprite-body-wide (16 px), centered on spawn column.
    const JUMP_HALFW = 8

    ctx.save()

    // Jump column (upside-down T's vertical stroke).
    drawVertLane(ctx, spawnCenterX, jumpTopY, swimTopY, JUMP_HALFW, COLORS.tealJump)

    // Swim band (upside-down T's horizontal stroke). Solid walls on left/
    // right boundaries since those come from simulated movement extents,
    // not L1 collision.
    drawCorridor(
      ctx,
      swimLeftX, swimRightX,
      swimTopY, swimBottomY,
      COLORS.tealSwim,
      { solidLeft: true, solidRight: true, solidBottom: true },
    )

    // Apex line across the jump column's width.
    drawApexLine(
      ctx,
      spawnCenterX - JUMP_HALFW,
      spawnCenterX + JUMP_HALFW,
      jumpTopY + 0.5,
      COLORS.tealJump,
    )

    ctx.restore()
  }
}
