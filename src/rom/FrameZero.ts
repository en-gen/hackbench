/**
 * The VRAM a map or a Map16 sheet composites from: the ROM's own animation
 * frame 0, moved from theia/extension/src/node/map16-decode.ts so the map
 * tab, the Map16 view and the L1 data gate share one source (#421 step 3).
 */
import type { RomFile } from './RomFile'
import type { VramState } from './GfxLoader'
import {
  getAnimatedChars,
  loadAnimationDataOrReason,
  stockAnimationUnreached,
  type AnimationData,
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

/**
 * The VRAM every surface of this view composites from: this ROM's own
 * animation FRAME 0, not the raw bytes of the four GFX files.
 *
 * The two are not the same picture. Measured on vanilla tileset 0, 75 of
 * the 80 animated characters differ - $040-$07F bar $078, $080-$081,
 * $090-$091, $0DA-$0DD and $0EA-$0ED - and every one of the 89
 * tileset/ROM combinations in the corpus that carries animation data
 * diverges (GPW2: 60 of 64). Those characters are the coins, the `?`
 * blocks and the water.
 *
 * So this is not a rendering nicety. A palette section drawn from raw VRAM
 * beside a tile drawn from frame 0 shows the user a coin, takes the click
 * and paints something else, and the whole design rests on recognition
 * coming from the picture. Map16Decode.test.ts already pins that the STILL
 * SHEET composites from here rather than from raw VRAM, and warns in as
 * many words that reintroducing the raw source is the original bug; this
 * function exists so every surface has ONE source and there is no second
 * chance to make that mistake one surface over.
 */
export function frameZeroChars(
  rom: RomFile,
  tileset: number,
  vram: VramState,
  exAnim?: AnimationData | null,
): FrameZeroChars {
  const loaded = loadAnimationDataOrReason(rom, tileset)
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
  const unreached = stockAnimationUnreached(rom)
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
