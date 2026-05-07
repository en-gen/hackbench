// Consumes: (none directly — overlay only)

import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS,
  DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH,
  rgba, WALL_ALPHA, WALL_LINE_WIDTH,
} from '../../overlays/primitives'
import type { MapStore } from '../../stores/mapStore'
import type { SpriteBehavior } from '../SpriteBehavior'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $4F Jumping Piranha Plant — vertical jump zone overlay.
 *
 * Handler: `JumpingPiranhaMain` → `CODE_02E0CD` (bank_02.asm:12804).
 * Three-state machine indexed by `SpriteTableC2`:
 *
 *   State 0 (`CODE_02E13C`): dwell in pipe (Y speed = 0). When
 *   `SpriteMisc1540` expires, sets Y speed = $C0 (= −64 raw) and goes to state 1.
 *
 *   State 1 (`CODE_02E159`): launch/rise. `ADC #$02` each frame: speed runs
 *   $C0 → $F0 (= −16 raw) in 24 frames.
 *   Contribution: Σ((-64+2j)/16) for j=0..23 ≈ 62 px.
 *
 *   State 2 (`CODE_02E177`): `EffFrame & $03` adds +1 to speed every 4 frames
 *   until speed reaches $08 (+0.5 px/frame terminal); `JSL CODE_019138` runs
 *   collision detection only (no extra position or gravity update).
 *   From speed $F0 (−1 px/frame) to 0: 16 raw steps × 4 frames each = 64 frames.
 *   Contribution: 4 × Σ((-16+k)/16) for k=0..15 = 4×(−136/16) ≈ 34 px.
 *
 *   JUMP_H = 62 + 34 = 96 px above anchor.
 *
 * The sprite body spans dx 8..24 (from InitPiranha's +8 X centering,
 * bank_01.asm:880); center is at spawn_x + 16.
 */
const JUMP_H    = 96  // state-1: 62 px + state-2: 34 px (EffFrame/4 gravity, $F0→0)
const BODY_HALF = 8   // half the 16 px body width; center at anchor_x + 16

export class JumpingPiranhaAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }

  override renderOverlay(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    _getL1:     GetL1Tile,
    _levelCols: number,
    _levelRows: number,
    _behavior:  SpriteBehavior | undefined,
    _mapStore:  MapStore,
  ): void {
    if (!isActive) return

    // Sprite body is 16 px wide, left edge at x+8 (dx=8), right edge at x+24.
    // Center = x + 8 + BODY_HALF = x + 16.
    const centerX = x + 8 + BODY_HALF
    const jumpTop = y - JUMP_H
    const color   = COLORS.patrolPath

    ctx.save()

    // Dashed vertical centerline — tracks the jump column above the pipe.
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()
    ctx.moveTo(centerX, y); ctx.lineTo(centerX, jumpTop)
    ctx.stroke()
    ctx.setLineDash([])

    // Solid apex endcap spanning the full 16 px body width.
    ctx.lineWidth   = WALL_LINE_WIDTH
    ctx.strokeStyle = rgba(color, WALL_ALPHA)
    ctx.beginPath()
    ctx.moveTo(centerX - BODY_HALF, jumpTop)
    ctx.lineTo(centerX + BODY_HALF, jumpTop)
    ctx.stroke()

    ctx.restore()
  }
}
