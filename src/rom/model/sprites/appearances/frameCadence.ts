/**
 * How many SNES frames one editor animation tick stands for.
 *
 * The map editor ticks sprite animation every `SPRITE_ANIM_INTERVAL_MS` = 125 ms
 * (`src/webview/mapEditor/main.ts`), i.e. 8 Hz, while the PPU runs at 60 Hz. An
 * appearance that replays a ROM frame counter therefore advances it by
 * 125 ms * 60 Hz / 1000 = 7.5 ROM frames per tick.
 */

/** Exact 7.5. Use this in new appearances. */
export const ROM_FRAMES_PER_TICK = 125 * 60 / 1000

/**
 * The same quantity written `125 / (1000 / 60)`, which is NOT 7.5: it is
 * 7.499999999999999, because 1000 / 60 is not representable in binary64.
 *
 * `RipVanFishAppearance` still uses this form. Measured on its accumulator
 * (`(romFrame + step) % 120`, floored), the two forms disagree from the second
 * tick and on 2500 of the first 5000 ticks, yet its 13 tests stay green either
 * way, so switching it would be an unverified behaviour change. Named here
 * rather than left as a second literal in that file, so retiring it is one
 * edit plus re-derived oracles.
 */
export const ROM_FRAMES_PER_TICK_LEGACY = 125 / (1000 / 60)
