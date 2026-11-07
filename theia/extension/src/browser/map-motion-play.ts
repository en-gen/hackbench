/**
 * Play on the map tab (#1242): the pure parts. The run itself is node-side (`mapMotion`); the view only
 * decodes its strips, picks the frame by time and shifts Layer 2's planes with wrap.
 */
import type { MapMotionResult } from '../common/project-protocol'
import { decodeRgba } from './map16-pixels'

export type Motion = Extract<MapMotionResult, { status: 'ok' }>

/** Frames advance at 60 per second by time, not per paint. */
export const FRAME_MS = 1000 / 60

/** The frame the run is at after `elapsedMs`; the run loops from its load state. */
export const frameAt = (elapsedMs: number, count: number): number =>
  count <= 0 ? 0 : Math.floor(Math.max(0, elapsedMs) / FRAME_MS) % count

export interface Strip {
  low: Uint8ClampedArray | null
  high: Uint8ClampedArray | null
}

export const decodeStrips = (m: Motion): Strip[] =>
  m.strips.map(s => ({
    low: s?.low ? decodeRgba(s.low) : null,
    high: s?.high ? decodeRgba(s.high) : null,
  }))

/**
 * One Layer 2 plane drawn `shift` rows lower: `base` is the screen's `height` rows and `extra` the rows below
 * them up to the 512 px period, so the rows that scroll in come from the wrapped plane, never from a gap.
 * A plane nothing drew in stays blank.
 */
export function shiftPlane(
  base: Uint8ClampedArray | null,
  extra: Uint8ClampedArray | null,
  width: number,
  height: number,
  extraRows: number,
  shift: number,
): Uint8ClampedArray | null {
  if (!base && !extra) return null
  const period = height + extraRows
  const rowBytes = width * 4
  const out = new Uint8ClampedArray(rowBytes * height)
  for (let r = 0; r < height; r++) {
    const src = (((r - shift) % period) + period) % period
    const from =
      src < height
        ? base?.subarray(src * rowBytes, (src + 1) * rowBytes)
        : extra?.subarray((src - height) * rowBytes, (src - height + 1) * rowBytes)
    if (from) out.set(from, r * rowBytes)
  }
  return out
}
