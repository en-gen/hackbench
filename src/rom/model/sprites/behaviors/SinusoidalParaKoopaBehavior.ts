import { MovementBehavior, type BehaviorMeta } from '../MovementBehavior'

/**
 * $0A Red Vertical Para-Koopa / $0B Red Horizontal Para-Koopa — shared
 * handler at bank_01.asm:1881. The two sprites differ only in which axis
 * the oscillating speed drives:
 *
 *   $0A: SubSprYPosNoGrvty applies speed to Y; X is frozen.
 *   $0B: both axes; Y bobs ±4 sub-pixels via misc1570 bit 5 (same as $08).
 *
 * The speed itself is driven by a table-driven triangle-wave generator.
 * Every 4 frames (when cooldown `misc1540 == 0` and `TableC2 & $03 == 0`):
 *
 *   idx = misc151C & 1
 *   speed += STEP[idx]
 *   if speed == TARGET[idx]:
 *     misc151C++, misc1540 = COOLDOWN
 *
 * With tables from bank_01.asm:1871-1872:
 *   DATA_018CBA: db $FF,$01    → STEP   = [-1, +1]
 *   DATA_018CBC: db $F0,$10    → TARGET = [-16, +16]
 *
 * So the speed ramps 0→-16 (64 frames), holds at -16 for 48 (cooldown),
 * ramps -16→+16 (128 frames), holds at +16 for 48, ramps +16→-16, etc.
 *
 * Because both `SpriteXSpeed` and `SpriteMisc151C` initialise to 0, the
 * very first speed update is `STEP[0] = -1` — the sprite ALWAYS moves in
 * the negative direction first (left for $0B, up for $0A), regardless of
 * Mario's position. The integrated position oscillates between roughly
 * -112 px (the leftmost/topmost reach) and 0 px (the spawn anchor) and
 * never crosses to the positive side of spawn. The overlay must reflect
 * this asymmetry — a single one-sided segment, not a ±amplitude band.
 */

export const PARAKOOPA_STEP            = [-1, +1] as const
export const PARAKOOPA_TARGET          = [-16, +16] as const
export const PARAKOOPA_COOLDOWN        = 48
export const PARAKOOPA_UPDATE_INTERVAL = 4

export interface SineBounds {
  axis:    'vertical' | 'horizontal'
  /** Most-negative displacement reached from spawn. By ASM design ≤ 0. */
  minPos:  number
  /** Most-positive displacement reached from spawn. By ASM design = 0. */
  maxPos:  number
}

export interface SinusoidalConfig {
  axis: 'vertical' | 'horizontal'
}

export class SinusoidalParaKoopaBehavior extends MovementBehavior {
  readonly kind = 'sinusoidal_para_koopa'
  readonly axis: 'vertical' | 'horizontal'

  constructor(config: SinusoidalConfig, meta?: BehaviorMeta) {
    super(meta)
    this.axis = config.axis
  }

  computeSineBounds(): SineBounds {
    const { minPos, maxPos } = simulateRange()
    return { axis: this.axis, minPos, maxPos }
  }
}

// ── Simulation ──────────────────────────────────────────────────────────────

/**
 * Run the triangle-wave speed integrator forward and return the
 * [minPos, maxPos] window reached from the spawn origin. Shared for both
 * axes since the math is identical — the Behavior simply reports which
 * axis it applies to. Runs for 1024 frames: plenty for one full (~400
 * frame) oscillation cycle to complete and the envelope to stabilise.
 *
 * Because `SpriteXSpeed` / `SpriteMisc151C` both init to 0, the first
 * speed update is `STEP[0] = -1`, and `maxPos` stays at 0 forever — the
 * sprite never crosses back to the positive side of spawn. The overlay
 * relies on this to draw a one-sided segment.
 */
function simulateRange(): { minPos: number; maxPos: number } {
  let speed    = 0        // signed 8-bit, initial 0
  let pos      = 0        // whole-pixel displacement from origin
  let sub      = 0        // 8-bit sub-pixel accumulator
  let misc1540 = 0        // cooldown
  let misc151C = 0
  let tableC2  = 0
  let minPos   = 0
  let maxPos   = 0

  for (let frame = 0; frame < 1024; frame++) {
    // 1. Speed update block (only when cooldown == 0).
    if (misc1540 === 0) {
      tableC2 = (tableC2 + 1) & 0xFF
      if ((tableC2 & 0x03) === 0) {
        const idx = misc151C & 1
        speed = signed8(speed + PARAKOOPA_STEP[idx])
        if (speed === PARAKOOPA_TARGET[idx]) {
          misc151C = (misc151C + 1) & 0xFF
          misc1540 = PARAKOOPA_COOLDOWN
        }
      }
    } else {
      misc1540--
    }

    // 2. SubSprPosNoGrvty: move by speed × 16 sub-px into 8-bit accumulator.
    const totalSub  = speed * 16
    const newSub    = sub + totalSub
    const wholeStep = Math.floor(newSub / 256)
    sub = ((newSub % 256) + 256) % 256
    pos += wholeStep

    if (pos < minPos) minPos = pos
    if (pos > maxPos) maxPos = pos
  }
  return { minPos, maxPos }
}

function signed8(v: number): number {
  const low = ((v % 256) + 256) % 256
  return low >= 128 ? low - 256 : low
}
