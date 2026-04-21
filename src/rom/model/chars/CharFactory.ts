import type { AnimationData } from '../../AnimationLoader'
import {
  VRAM_CHAR_BASE,
  VRAM_SLOT_NAMES,
  type VramState,
} from '../../GfxLoader'
import type { CharBehavior } from './CharBehavior'
import { Char } from './Char'
import { AnimatedPixels } from './behaviors/AnimatedPixels'
import { PSwitchAlternate } from './behaviors/PSwitchAlternate'
import { StaticPixels } from './behaviors/StaticPixels'

const TILES_PER_SLOT = 4

/**
 * A blue-P-switch char pairing: when the switch is active, VRAM char
 * `normalCharNum` renders the pixels of `altCharNum` instead. In SMW
 * this comes from the DMA table at bank_05.asm:4418-4421 via the
 * `+0x26` offset at DATA_05B97D. The full ROM walk that derives these
 * pairs is a separate task; this type is the interface the factory
 * expects once that walk lands.
 */
export interface PSwitchPair {
  normalCharNum: number
  altCharNum: number
}

/**
 * Build a char graph from a loaded VRAM state.
 *
 * Behavior selection per char, in order of precedence:
 *   1. If the char has a `PSwitchPair` entry, wrap in `PSwitchAlternate`
 *      over the base behavior (static or animated) and the alt's base.
 *   2. Else if the char is in an animation slot, wrap in `AnimatedPixels`.
 *   3. Else `StaticPixels`.
 *
 * Passing `pSwitchPairs = []` (the default) produces no P-switch
 * wrapping — levels render correctly without animation. The full
 * bank_05 DMA-table walk that derives real pairs is a separate task.
 */
export function buildChars(
  vram: VramState,
  animData?: AnimationData,
  pSwitchPairs: readonly PSwitchPair[] = [],
): Map<number, Char> {
  const animFrames = collectAnimFrames(animData)
  const pSwitchByNormal = new Map<number, number>()
  for (const pair of pSwitchPairs) pSwitchByNormal.set(pair.normalCharNum, pair.altCharNum)

  const baseBehaviors = new Map<number, CharBehavior>()
  for (const slot of VRAM_SLOT_NAMES) {
    const sheet = vram[slot]
    if (!sheet) continue
    const base = VRAM_CHAR_BASE[slot]
    for (let i = 0; i < sheet.length; i++) {
      const pixels = sheet[i]
      if (!pixels) continue
      const charNum = base + i
      const frames = animFrames.get(charNum)
      baseBehaviors.set(charNum, frames ? new AnimatedPixels(frames) : new StaticPixels(pixels))
    }
  }

  const chars = new Map<number, Char>()
  for (const [charNum, base] of baseBehaviors) {
    const altNum = pSwitchByNormal.get(charNum)
    const alt = altNum !== undefined ? baseBehaviors.get(altNum) : undefined
    const behavior = alt ? new PSwitchAlternate(base, alt) : base
    chars.set(charNum, new Char(charNum, behavior))
  }
  return chars
}

/**
 * Transpose AnimationData — which is frame-major (per-frame list of
 * slot patches) — into char-major: Map<charNum, Uint8Array[]> where
 * each array is indexed by frame.
 *
 * Returns an empty map when animData is omitted or has no slots.
 */
function collectAnimFrames(animData: AnimationData | undefined): Map<number, Uint8Array[]> {
  const out = new Map<number, Uint8Array[]>()
  if (!animData) return out
  const frameCount = animData.frames.length
  for (let f = 0; f < frameCount; f++) {
    for (const slot of animData.frames[f]) {
      for (let i = 0; i < TILES_PER_SLOT; i++) {
        const charNum = slot.charBase + i
        const tile = slot.tiles[i]
        if (!tile) continue
        let frames = out.get(charNum)
        if (!frames) {
          // Dense array (undefined-filled), not sparse — sparse arrays
          // cause `some()` / `every()` to skip holes and miss gaps.
          frames = new Array<Uint8Array>(frameCount).fill(undefined as unknown as Uint8Array)
          out.set(charNum, frames)
        }
        frames[f] = tile
      }
    }
  }
  // Drop any char whose frame list has holes. Explicit index walk — avoids
  // the sparse-array `some()` trap where holes are invisible to the callback.
  const toDelete: number[] = []
  for (const [charNum, frames] of out) {
    for (let f = 0; f < frameCount; f++) {
      if (!frames[f] || frames[f].length === 0) {
        toDelete.push(charNum)
        break
      }
    }
  }
  for (const c of toDelete) out.delete(c)
  return out
}
