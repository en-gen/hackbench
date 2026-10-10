/**
 * Which MAIN pass of the sprite runner corresponds to the frame Mesen caught a sprite drawing.
 * Sprites run MAIN from about the capture's anchor frame (before it Mario is held at a leftover
 * position and the level is still being set up), and never before the frame after INIT, so the
 * capture is `drawnFrame - max(anchorFrame, initFrame + 1)` passes in. Test oracle only.
 */

/** Largest pass index the grader will run for one record; a larger k falls back. */
export const MAX_GRADED_PASS = 255

/** The pass index to grade, or undefined when a field is missing or k is out of range. */
export function gradedPass(
  initFrame: number | undefined,
  anchorFrame: number | undefined,
  drawnFrame: number | undefined,
): number | undefined {
  if (![initFrame, anchorFrame, drawnFrame].every(Number.isInteger)) return undefined
  const k = drawnFrame! - Math.max(anchorFrame!, initFrame! + 1)
  return k >= 0 && k <= MAX_GRADED_PASS ? k : undefined
}

/** Mario's WRAM cells: $94/$96 (Next) and $D1/$D3 (Now), each 16 bit little endian. */
const MARIO_CELLS = [0x94, 0x96, 0xd1, 0xd3] as const

/** Writes the capture's marioStart into both copies of Mario's position (after INIT, before MAIN). */
export function writeMarioStart(w: Uint8Array, m: { x: number; y: number }): void {
  const put = (a: number, v: number): void => {
    w[a] = v & 0xff
    w[a + 1] = (v >> 8) & 0xff
  }
  put(MARIO_CELLS[0], m.x)
  put(MARIO_CELLS[1], m.y)
  put(MARIO_CELLS[2], m.x)
  put(MARIO_CELLS[3], m.y)
}
