/**
 * BG3 X on a tide ($01-$7F settings byte) after `frames` GM14 frames that
 * moved the camera by `sumDx` in total (signed, as Layer1DXPos is), starting
 * from low byte `x0`: CODE_05C4EC, bank_05.asm:5624-5629. Holds only while
 * Layer3ScrollType is 0 and the game is not paused. Nothing consumes it yet.
 * Derivation and evidence scope: docs/rom/level-rendering.md, "Tide X (#808)".
 */
export function tideBgX(x0: number, frames: number, sumDx: number): number {
  return 0x100 | ((x0 + frames + sumDx) & 0xff)
}
