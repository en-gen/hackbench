/**
 * Shared per-frame simulation primitives used by movement behavior classes.
 *
 * The SMW sprite engine is a tight deterministic loop: `SubUpdateSprPos`
 * (bank_01.asm:2322) applies current (X, Y) speed with a 16× sub-pixel
 * accumulator, gravity is added to Y speed (clamped at $40 terminal), then
 * per-handler code adjusts speeds. Porting any of that faithfully in TS
 * means re-using the same sub-pixel math and signed-8-bit arithmetic every
 * handler uses - so those primitives live here, not in each Behavior.
 *
 * None of this is canvas-aware; it's physics only. The Appearance layer
 * calls these via a Behavior's higher-level methods (simulateBounds,
 * computeBounceArc) and renders the result.
 */

export interface Rect {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/**
 * Union a point's body-box (`(x, y)` → `(x+w, y+h)`) into an existing rect.
 * Shrinking `rect` values grow towards the body; both axes grow independently.
 */
export function unionBodyBox(rect: Rect, x: number, y: number, w: number, h: number): void {
  if (x < rect.minX) rect.minX = x
  if (x + w > rect.maxX) rect.maxX = x + w
  if (y < rect.minY) rect.minY = y
  if (y + h > rect.maxY) rect.maxY = y + h
}

/**
 * Mask a JS number back into a signed 8-bit int, matching 65816 `DEC`/`ADC`
 * wrap semantics. Used anywhere we track `SpriteXSpeed,x` / `SpriteYSpeed,x`.
 */
export function signed8(v: number): number {
  const low = ((v % 256) + 256) % 256
  return low >= 128 ? low - 256 : low
}

/**
 * Wrap a JS number into an unsigned 8-bit int. Used for sub-pixel
 * accumulators (`SpriteXPosSpx`, `SpriteYPosSpx`) that mirror `$14F8,x`.
 */
export function unsigned8(v: number): number {
  return ((v % 256) + 256) % 256
}

/**
 * Apply gravity to a signed-8-bit Y speed, clamping to the per-handler
 * terminal velocity. Matches `SubUpdateSprPos`'s gravity step: load
 * `DATA_019030[idx]` (default $03), add to speed, compare against
 * `DATA_01902E[idx]` (default $40) and clamp. The clamp is done in the
 * positive direction only (falling) - rising speeds are bounded by the
 * handler's own `DEC.B SpriteYSpeed,x`.
 */
export function applyGravity(vy: number, gravity: number = 3, terminal: number = 0x40): number {
  const next = vy + gravity
  return next > terminal ? terminal : next
}

/**
 * Run a simulation loop with a convergence cut-off. The body `step` mutates
 * its caller-owned state and returns `false` when the sim should stop early
 * (e.g. sprite is offscreen). The loop also exits once `bounds` stops growing
 * for `stableFrames` iterations - useful for range-of-motion computations
 * where the goal is "enumerate every reachable pixel" rather than "simulate
 * forever". `maxFrames` is an absolute guard against runaway sims.
 *
 * Returns the number of frames actually executed.
 */
export function simulateUntilStable(
  bounds: Rect,
  step: (frame: number) => boolean | void,
  options: {
    stableFrames?: number
    maxFrames?: number
  } = {},
): number {
  const stableTarget = options.stableFrames ?? 256
  const maxFrames = options.maxFrames ?? 4096
  let stable = 0
  for (let frame = 0; frame < maxFrames; frame++) {
    const before = { ...bounds }
    const cont = step(frame)
    if (cont === false) return frame + 1
    const grew =
      bounds.minX !== before.minX ||
      bounds.maxX !== before.maxX ||
      bounds.minY !== before.minY ||
      bounds.maxY !== before.maxY
    stable = grew ? 0 : stable + 1
    if (stable >= stableTarget) return frame + 1
  }
  return maxFrames
}
