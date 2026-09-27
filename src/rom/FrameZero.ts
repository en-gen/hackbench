/**
 * The VRAM a map or a Map16 sheet composites from: the ROM's own animation
 * frame 0, one source for the map tab, the Map16 view and the L1 data gate.
 */
import type { RomFile } from './RomFile'
import type { VramState } from './GfxLoader'
import {
  getAnimatedChars,
  loadAnimationDataOrReason,
  stockAnimationUnreached,
  type AnimationData,
  type LoadAnimationResult,
} from './AnimationLoader'
import { mergeAnimationData } from './ExAnimationLoader'
import { buildChars, vramFromChars } from './model/chars/CharFactory'
import type { Char } from './model/chars/Char'

/** `frameZeroChars`'s result: `animData`/`chars` present whenever real stock
 * frame data exists to composite; `error` set whenever that data is
 * unverified or does not exist at all, and absent otherwise. */
export type FrameZeroChars =
  | { animData: AnimationData; chars: Map<number, Char>; vram: VramState; error?: string }
  | { animData?: undefined; vram: VramState; error: string }
  | undefined

/** Frame 0 of this ROM's own animation over `vram`, never the raw GFX: docs/rom/frame-zero.md. */
export function frameZeroChars(rom: RomFile, tileset: number, vram: VramState): FrameZeroChars {
  const loaded = loadAnimationDataOrReason(rom, tileset)
  return frameZeroFrom(loaded, loaded.ok ? stockAnimationUnreached(rom) : null, vram)
}

/** `frameZeroChars` over readings already taken: no ROM access, so a caller can test the logic. */
export function frameZeroFrom(
  loaded: LoadAnimationResult,
  unreached: { target: number } | { reason: string } | null,
  vram: VramState,
  exAnim?: AnimationData | null,
): FrameZeroChars {
  if (!loaded.ok) {
    // No stock frames exist to composite: leave this level's own GFX
    // exactly as loaded rather than guess at pixels there is no data for,
    // save for a level's own ExAnimation frames.
    const error = framesError(loaded.reason, false)
    if (!exAnim) return { vram, error }
    const chars = buildChars(vram, exAnim)
    return { animData: exAnim, chars, vram: vramFromChars(vram, chars), error }
  }
  // ExAnimation slots after the stock ones, as MapBuilder merges them.
  const animData = exAnim ? mergeAnimationData(loaded.data, exAnim) : loaded.data
  // Checked before the animated-char count: a ROM that skips its own
  // routine must always report, even on a tileset with nothing to animate.
  // A reached routine that cannot be read served the vanilla tables: unverified the same way.
  const unverified = unreached ? unreachedReason(unreached) : loaded.data.unverified
  if (getAnimatedChars(animData).size === 0 && !unverified) return undefined
  // Nothing has ticked yet, so this snapshot IS phase 0 by construction.
  const chars = buildChars(vram, animData)
  const composited = { animData, chars, vram: vramFromChars(vram, chars) }
  if (!unverified) return composited
  // The level's own code never reaches the stock routine: this tileset's
  // stock data is real, but unverified - shown for reference, not as proof
  // of what this ROM actually draws.
  return { ...composited, error: framesError(unverified, true) }
}

/** The animation data safe to play back, or undefined when frame 0 came
 * from an unverified or unavailable source - only a still frame is shown. */
export function playableAnimation(frameZero: FrameZeroChars): AnimationData | undefined {
  return frameZero?.animData && !frameZero.error ? frameZero.animData : undefined
}

const framesError = (reason: string, hasStockFrames: boolean): string =>
  `Animation frames couldn't be loaded: ${reason}. ${
    hasStockFrames
      ? 'Showing stock frames.'
      : "These characters are shown as this ROM's own GFX loaded them."
  }`

function unreachedReason(unreached: { target: number } | { reason: string }): string {
  if ('reason' in unreached) return unreached.reason
  const hex = unreached.target.toString(16).toUpperCase().padStart(6, '0')
  return `this ROM decides per level whether the stock animation runs (the level calls $${hex})`
}
