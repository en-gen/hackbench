/**
 * Shared editor sprite-animation cadence.
 *
 * Lives on the model side because both the webview timer that drives the
 * ticks and the appearances that convert ticks to game frames need the
 * same number. Duplicating it let the two drift apart silently.
 */

/**
 * Nominal period the editor asks `createRafTimer` for when ticking sprite
 * animations. ~8 Hz; preserves the legacy sprite cadence.
 *
 * NOMINAL, not realized: `createRafTimer` re-bases on the frame it fires
 * rather than accumulating, so the realized period is
 * `ceil(interval / frameMs) * frameMs` - 133.33 ms on a 60 Hz display,
 * 125 ms on 120/144 Hz. See docs/sprite-4d-monty-mole.md.
 */
export const SPRITE_ANIM_INTERVAL_MS = 125

/** SNES frame rate the ROM's frame counters advance at. */
export const GAME_FPS = 60

/**
 * Game frames per editor tick, from the NOMINAL interval. Multiplied
 * before dividing on purpose: `125 / (1000 / 60)` is 7.499999999999999,
 * which drifts the accumulator off the half-frame grid the wrap relies on.
 */
export const ROM_FRAMES_PER_TICK = (SPRITE_ANIM_INTERVAL_MS * GAME_FPS) / 1000
