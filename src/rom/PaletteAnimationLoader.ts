/**
 * Per-frame CGRAM patches for the palette views, built from whatever
 * `PaletteAnimationDetect` could read off the cart. A context it cannot
 * read yields null, which every caller already treats as "no animation
 * data", so such a cart shows nothing rather than stock's swatches.
 * `explainPaletteAnimation` carries the reason, since null alone cannot.
 * See docs/spikes/palette-animation-detect.md.
 */

import { RomFile } from './RomFile'
import { bgr555ToRgba } from './GraphicsDecoder'
import { framesToMs } from './timing'
import {
  detectPaletteAnimation,
  type PaletteAnimContextName,
  type PaletteAnimDetection,
} from './PaletteAnimationDetect'

// ── Types ────────────────────────────────────────────────────────────────────

/** One CGRAM color slot update for a single animation frame. */
export interface PaletteAnimPatch {
  /** CGRAM color index 0-255: row = cgramIdx >> 4, col = cgramIdx & 15. */
  cgramIdx: number
  /** RGBA color to write. */
  color: [number, number, number, number]
}

export interface PaletteAnimData {
  frameCount: number
  intervalMs: number
  /** Per-frame patches: apply each by writing color to paletteRows[cgramIdx >> 4][cgramIdx & 15]. */
  frames: PaletteAnimPatch[][]
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Per-frame CGRAM patches for one context, or null when this cart's handler
 * for that context does not decode or is not reached.
 *
 * Targets with differing phase counts are replayed over their least common
 * multiple so each keeps its own cadence; stock's two overworld targets share
 * one kernel and so share a count.
 *
 * @param detection Reuse an existing detection instead of re-scanning.
 */
export function loadPaletteAnimData(
  rom: RomFile,
  mode: PaletteAnimContextName = 'overworld',
  detection?: PaletteAnimDetection,
): PaletteAnimData | null {
  const context = (detection ?? detectPaletteAnimation(rom))[mode]
  if (!context.available || context.targets.length === 0) return null

  const frameCount = context.targets.reduce((acc, t) => lcm(acc, t.phaseCount), 1)
  const frames: PaletteAnimPatch[][] = []
  for (let f = 0; f < frameCount; f++) {
    frames.push(
      context.targets.map(t => ({
        cgramIdx: t.cgramIdx,
        color: bgr555ToRgba(t.colors[f % t.phaseCount]!),
      })),
    )
  }

  const stride = context.targets.reduce((acc, t) => Math.min(acc, t.frameStride), Infinity)
  return { frameCount, intervalMs: Math.round(framesToMs(stride)), frames }
}

/**
 * Why a context animates what it animates, or why it could not be read. The
 * only channel that survives `loadPaletteAnimData` returning null.
 */
export function explainPaletteAnimation(
  rom: RomFile,
  mode: PaletteAnimContextName = 'overworld',
  detection?: PaletteAnimDetection,
): string[] {
  return (detection ?? detectPaletteAnimation(rom))[mode].notes
}

function lcm(a: number, b: number): number {
  let x = a,
    y = b
  while (y !== 0) {
    const t = x % y
    x = y
    y = t
  }
  return (a / x) * b
}

/**
 * Serialize palette animation data for postMessage transfer.
 * Colors are converted to plain {r,g,b,a} objects for JSON compatibility.
 */
export function serializePaletteAnimData(data: PaletteAnimData): SerializedPaletteAnimData {
  return {
    frameCount: data.frameCount,
    intervalMs: data.intervalMs,
    frames: data.frames.map(frame =>
      frame.map(p => ({
        cgramIdx: p.cgramIdx,
        r: p.color[0],
        g: p.color[1],
        b: p.color[2],
        a: p.color[3],
      })),
    ),
  }
}

export interface SerializedPaletteAnimData {
  frameCount: number
  intervalMs: number
  frames: Array<Array<{ cgramIdx: number; r: number; g: number; b: number; a: number }>>
}
