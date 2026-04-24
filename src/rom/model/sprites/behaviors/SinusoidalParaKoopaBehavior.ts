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
 * That produces a position oscillation whose amplitude depends on the
 * length of each phase; for the overlay we simulate enough frames to
 * enumerate the reachable ±displacement and report it as "amplitudePx".
 *
 * The resulting amplitude is ≈ 60-80 px — a single cycle swings the sprite
 * well over a tile's worth of distance from the spawn anchor.
 */

export const PARAKOOPA_STEP            = [-1, +1] as const
export const PARAKOOPA_TARGET          = [-16, +16] as const
export const PARAKOOPA_COOLDOWN        = 48
export const PARAKOOPA_UPDATE_INTERVAL = 4

export interface SineBounds {
  axis:         'vertical' | 'horizontal'
  amplitudePx:  number
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
    return { axis: this.axis, amplitudePx: simulateAmplitude() }
  }
}

// ── Simulation ──────────────────────────────────────────────────────────────

/**
 * Run the triangle-wave speed integrator forward and return the max
 * absolute displacement reached from origin. Shared for both axes since
 * the math is identical — the Behavior simply reports which axis it
 * applies to. Runs for 1024 frames: plenty for one full (~400 frame)
 * oscillation cycle to complete and the amplitude envelope to stabilise.
 */
function simulateAmplitude(): number {
  let speed    = 0        // signed 8-bit, initial 0
  let pos      = 0        // whole-pixel displacement from origin
  let sub      = 0        // 8-bit sub-pixel accumulator
  let misc1540 = 0        // cooldown
  let misc151C = 0
  let tableC2  = 0
  let maxAbs   = 0

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

    if (Math.abs(pos) > maxAbs) maxAbs = Math.abs(pos)
  }
  return maxAbs
}

function signed8(v: number): number {
  const low = ((v % 256) + 256) % 256
  return low >= 128 ? low - 256 : low
}
