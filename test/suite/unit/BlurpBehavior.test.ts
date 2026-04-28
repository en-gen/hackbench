/**
 * BlurpBehavior — constants match the ROM port (`bank_03.asm:556-565`).
 *
 *   BlurpSpeedX    = $08, $F8        → ±$08 sub-px/frame  (X)
 *   BlurpMaxSpeedY = $04, $FC        → ±$04 cap            (Y triangle)
 *   BlurpAccelY    = $01, $FF        → ±1 per 4 frames     (Y triangle)
 *
 * Y amplitude — integrating speed across half a cycle (16 ticks per
 * direction × 4 frames per tick): 1+1+1+1+2+2+2+2+3+3+3+3+4+4+4+4 then
 * decel back to 0 = sum 64 speed-units. Position update uses
 * `speed * 16` sub-pixel offsets per frame (256 sub-px = 1 px), so
 * 64 × 16 / 256 = 4 px peak.
 */
import { describe, expect, it } from 'vitest'
import {
  BlurpBehavior,
  BLURP_X_SPEED_SUBPX,
  BLURP_Y_AMPLITUDE_PX,
  BLURP_Y_CYCLE_FRAMES,
} from '../../../src/rom/model/sprites/behaviors/BlurpBehavior'

describe('BlurpBehavior', () => {
  it('constants match the ROM data tables', () => {
    expect(BLURP_X_SPEED_SUBPX).toBe(0x08)
    expect(BLURP_Y_AMPLITUDE_PX).toBe(4)
    expect(BLURP_Y_CYCLE_FRAMES).toBe(64)
  })

  it('swimDirection mirrors FaceMario init', () => {
    const beh = new BlurpBehavior()
    // Sprite to the right of Mario → swims left (-1).
    expect(beh.swimDirection(/*spawnX*/ 200, /*marioSpawnX*/ 100)).toBe(-1)
    // Sprite to the left of Mario → swims right (+1).
    expect(beh.swimDirection(/*spawnX*/ 100, /*marioSpawnX*/ 200)).toBe(+1)
    // Tie (sprite at Mario X) → swims right (+1) by the >-strict tiebreaker.
    expect(beh.swimDirection(/*spawnX*/ 100, /*marioSpawnX*/ 100)).toBe(+1)
  })

  it('kind tag identifies the behavior class', () => {
    expect(new BlurpBehavior().kind).toBe('blurp')
  })
})
