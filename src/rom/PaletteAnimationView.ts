/**
 * The level palette animation as the palette view shows it: one entry per
 * animated CGRAM index, each frame with the ROM word it came from so an edit
 * can target it. Built only from what PaletteAnimationDetect read off the
 * cart; an unavailable context yields no targets, never stock's (CLAUDE.md,
 * "Never fall back to the vanilla value"). Timing is reported, not editable:
 * it lives in the kernel's AND mask and LSR count (bank_00.asm:4668-4670).
 */
import { bgr555ToRgba, RgbaColor } from './GraphicsDecoder'
import { framesToMs } from './timing'
import type { PaletteAnimDetection, PaletteAnimTarget } from './PaletteAnimationDetect'

export interface AnimFrameView {
  color: RgbaColor
  romAddr: number
}

export interface AnimTargetView {
  cgramIdx: number
  frameStride: number
  intervalMs: number
  /**
   * Another target, in either context, reads one of these frame words.
   * 'unknown' when no known target does but the overworld could not be read:
   * stock $6D shares $64's words (bank_00.asm:4664-4676 via :4780).
   */
  sharedWithOtherTargets: boolean | 'unknown'
  timing: PaletteAnimTarget['timing']
  frames: AnimFrameView[]
}

export interface LevelAnimationView {
  available: boolean
  notes: string[]
  targets: AnimTargetView[]
}

export function buildLevelAnimation(detection: PaletteAnimDetection): LevelAnimationView {
  const { level, overworld } = detection
  if (!level.available) return { available: false, notes: [...level.notes], targets: [] }

  const everyTarget = [...level.targets, ...(overworld.available ? overworld.targets : [])]
  const targets = level.targets.map((t): AnimTargetView => ({
    cgramIdx: t.cgramIdx,
    frameStride: t.frameStride,
    intervalMs: Math.round(framesToMs(t.frameStride)),
    sharedWithOtherTargets: sharesWords(t, everyTarget, overworld.available),
    timing: t.timing,
    frames: t.colors.map((word, i) => ({ color: bgr555ToRgba(word), romAddr: t.frameAddrs[i]! })),
  }))
  return { available: true, notes: [...level.notes], targets }
}

function sharesWords(
  t: PaletteAnimTarget,
  known: PaletteAnimTarget[],
  overworldRead: boolean,
): boolean | 'unknown' {
  if (known.some(o => o !== t && o.frameAddrs.some(a => t.frameAddrs.includes(a)))) return true
  return overworldRead ? false : 'unknown'
}
