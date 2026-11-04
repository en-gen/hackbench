/**
 * Layer 3 X on a tide ($01-$7F settings byte). CODE_05C4EC runs every gameplay
 * frame: `$22 += 1 + Layer1DXPos` (8-bit), then `$23 = 1`, so only the low byte
 * carries information. The load path never writes $22, so `x0` is whatever the
 * low byte held before the first tide frame. Derivation, ASM citations and the
 * capture evidence scope: docs/rom/level-rendering.md, "Tide X (#808)".
 */

/** The high byte the game writes on every tide frame. */
const TIDE_X_HIGH = 0x100

/**
 * BG3 X after `frames` tide frames that moved the camera by `sumDx` in total
 * (signed, as Layer1DXPos is), starting from low byte `x0`.
 */
export function tideBgX(x0: number, frames: number, sumDx: number): number {
  return TIDE_X_HIGH | ((x0 + frames + sumDx) & 0xff)
}
