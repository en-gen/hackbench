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
