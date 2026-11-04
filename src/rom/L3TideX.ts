/**
 * Layer 3 X on a tide ($01-$7F settings byte), as the game steps it.
 *
 * Every gameplay frame CODE_05C4EC runs `$22 = $22 + 1 + Layer1DXPos` in 8-bit
 * mode, then writes 1 to $23 (SMWDisX bank_05.asm:5624-5629; reached from
 * CODE_05C40C at bank_05.asm:5505-5509 for any nonzero Layer3TideSetting, and
 * from CODE_05C494 for every byte but $01). So BG3's X is always $100-$1FF and
 * only its low byte carries information: a phase that advances one pixel per
 * frame plus the layer 1 camera's movement, modulo 256. The load path never
 * writes $22 (bank_00.asm:4139-4164, bank_05.asm:4784-4798), so `x0` is
 * whatever the low byte held before the tide's first frame.
 *
 * Evidence scope: the ASM above, plus layers_v5 captures of vanilla maps 002 and
 * $0BE (one machine), where BG3 X read $100 + frames since the capture anchor.
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
