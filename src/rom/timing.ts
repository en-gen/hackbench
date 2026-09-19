/** Game-frame timing. The SNES counts frames; milliseconds are plumbing. */

/** NTSC SNES frame rate. */
export const SNES_NTSC_FPS = 60.098

/** Game frames to wall-clock milliseconds. */
export function framesToMs(frames: number): number {
  return (frames * 1000) / SNES_NTSC_FPS
}

/**
 * Milliseconds to whole game frames, at least 1.
 *
 * Multiply before dividing: `125 / (1000 / 60.098)` is `7.5122...` only by
 * luck, and `125 / (1000 / 60)` is `7.499999999999999`, which floors to 7.
 */
export function msToFrames(ms: number): number {
  return Math.max(1, Math.round((ms * SNES_NTSC_FPS) / 1000))
}

/**
 * Game frames per editor sprite-animation tick.
 *
 * `SetAnimationFrame` flips the walk frame on bit 3 of a per-sprite counter
 * incremented once per game frame (`SMWDisX bank_01.asm:2089-2096`), so the
 * shared walk cadence is 8 frames. Being a whole number, it also removes the
 * accumulate-then-floor drift that the old 7.5 carried.
 */
export const SPRITE_ANIM_FRAME_STRIDE = 8
