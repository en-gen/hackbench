import type { AnimationData } from '../../AnimationLoader'
import { VRAM_CHAR_BASE, VRAM_SLOT_NAMES, type GfxSheet, type VramState } from '../../GfxLoader'
import type { CharBehavior } from './CharBehavior'
import { Char } from './Char'
import { AnimatedPixelsBehavior } from './behaviors/AnimatedPixelsBehavior'
import { PSwitchAlternateBehavior } from './behaviors/PSwitchAlternateBehavior'
import { StaticPixelsBehavior } from './behaviors/StaticPixelsBehavior'

const TILES_PER_SLOT = 4

interface CharAnim {
  frames: Uint8Array[]
  altFrames?: Uint8Array[]
}

/**
 * Build a char graph from a loaded VRAM state.
 *
 * Behavior selection per char, in order of precedence:
 *   1. If the char's animation slot is a blue `alt` (blue-P-switch
 *      DMA pair from bank_05.asm:4417-4422), wrap in
 *      `PSwitchAlternateBehavior` over the normal and alt animated pixel
 *      behaviors.
 *   2. Else if the char is in an animation slot, wrap in `AnimatedPixelsBehavior`.
 *   3. Else `StaticPixelsBehavior`.
 *
 * Passing `animData = undefined` produces no animation or P-switch
 * wrapping - every VRAM char gets `StaticPixelsBehavior` over its baked
 * pixels.
 */
export function buildChars(vram: VramState, animData?: AnimationData): Map<number, Char> {
  const animFrames = collectAnimFrames(animData)

  const chars = new Map<number, Char>()
  for (const slot of VRAM_SLOT_NAMES) {
    const sheet = vram[slot]
    if (!sheet) continue
    const base = VRAM_CHAR_BASE[slot]
    for (let i = 0; i < sheet.length; i++) {
      const pixels = sheet[i]
      if (!pixels) continue
      const charNum = base + i
      const anim = animFrames.get(charNum)
      let behavior: CharBehavior
      if (anim?.altFrames) {
        behavior = new PSwitchAlternateBehavior(
          new AnimatedPixelsBehavior(anim.frames),
          new AnimatedPixelsBehavior(anim.altFrames),
        )
      } else if (anim) {
        behavior = new AnimatedPixelsBehavior(anim.frames)
      } else {
        behavior = new StaticPixelsBehavior(pixels)
      }
      chars.set(charNum, new Char(charNum, behavior))
    }
  }
  return chars
}

/**
 * Transpose AnimationData - which is frame-major (per-frame list of
 * slot patches) - into char-major: `Map<charNum, CharAnim>` where each
 * `CharAnim.frames` is indexed by frame, and `altFrames` (when present)
 * holds the blue-P-switch-active pixel data for the same char.
 *
 * Returns an empty map when animData is omitted or has no slots.
 *
 * A char is dropped if any of its normal frames are missing. Alt frames
 * are dropped as a unit if any frame is missing - the normal animation
 * still runs, just without the P-switch swap.
 */
function collectAnimFrames(animData: AnimationData | undefined): Map<number, CharAnim> {
  const out = new Map<number, CharAnim>()
  if (!animData) return out
  const frameCount = animData.frames.length
  for (let f = 0; f < frameCount; f++) {
    for (const slot of animData.frames[f]) {
      for (let i = 0; i < TILES_PER_SLOT; i++) {
        const charNum = slot.charBase + i
        const tile = slot.tiles[i]
        if (!tile) continue
        let anim = out.get(charNum)
        if (!anim) {
          // Dense array (undefined-filled), not sparse - sparse arrays
          // cause `some()` / `every()` to skip holes and miss gaps.
          anim = {
            frames: new Array<Uint8Array>(frameCount).fill(undefined as unknown as Uint8Array),
          }
          out.set(charNum, anim)
        }
        anim.frames[f] = tile
        // PSwitchAlternateBehavior follows the blue toggle only; silver and ON/OFF wait for #574.
        const altTile = slot.alt?.switch === 'blue' ? slot.alt.tiles[i] : undefined
        if (altTile) {
          if (!anim.altFrames) {
            anim.altFrames = new Array<Uint8Array>(frameCount).fill(
              undefined as unknown as Uint8Array,
            )
          }
          anim.altFrames[f] = altTile
        }
      }
    }
  }
  // Drop chars with holes in normal frames; drop alt frames with holes
  // but keep the char's normal animation.
  const toDelete: number[] = []
  for (const [charNum, anim] of out) {
    for (let f = 0; f < frameCount; f++) {
      if (!anim.frames[f] || anim.frames[f].length === 0) {
        toDelete.push(charNum)
        break
      }
    }
    if (anim.altFrames) {
      for (let f = 0; f < frameCount; f++) {
        if (!anim.altFrames[f] || anim.altFrames[f].length === 0) {
          anim.altFrames = undefined
          break
        }
      }
    }
  }
  for (const c of toDelete) out.delete(c)
  return out
}

/**
 * A `VramState` reflecting `chars`' CURRENT pixel state - each char's
 * `getPixels()`, which for an `AnimatedPixelsBehavior` char is whichever
 * frame its own internal index currently points at. Lets a caller reuse a
 * `VramState`-shaped renderer (TileRenderer.buildTileAtlas) against a
 * point-in-time snapshot of the char model, without that renderer knowing
 * anything about `Char`/`CharBehavior`.
 *
 * `base` supplies slot membership and length (which chars exist per slot);
 * only slots present in `base` are considered. A slot is copied (not
 * mutated) only if at least one of its chars actually differs from the
 * base pixels - `StaticPixelsBehavior` hands back the exact array it was
 * built FROM `base` with, so a char with no animation is always skipped.
 *
 * This does NOT mean phase 0 (before any `tickAnimation()`) equals `base`
 * for a tileset that has real animation. `AnimatedPixelsBehavior`'s frames
 * come from `AnimationLoader.loadAnimationData`, decoded from a completely
 * separate part of the cart than the tileset's own GFX file - frame 0 is
 * never the same array as whatever static bytes the GFX file happened to
 * leave at that VRAM char, so an animated char's slot IS patched even at
 * phase 0. Measured on vanilla tileset 0: 76 chars across 2 of the 8
 * `VRAM_SLOT_NAMES` groups (`fg3`, `an1`) differ from `base` before a
 * single `tickAnimation()` call - see Map16Decode.test.ts's
 * "vanilla tileset 0, phase 0" pin, which is the oracle that catches a
 * regression back to rendering raw, un-animated VRAM.
 *
 * An entry may also be a bare `Uint8Array`: a still switch preview has no
 * Char to tick, only the alternate pixels `AnimationLoader.slotTiles` resolved.
 */
export function vramFromChars(
  base: VramState,
  chars: ReadonlyMap<number, Char | Uint8Array>,
): VramState {
  const out: VramState = { ...base }
  for (const slot of VRAM_SLOT_NAMES) {
    const sheet = base[slot]
    if (!sheet) continue
    const slotBase = VRAM_CHAR_BASE[slot]
    let patched: GfxSheet | undefined
    for (let i = 0; i < sheet.length; i++) {
      const entry = chars.get(slotBase + i)
      if (!entry) continue
      const pixels = entry instanceof Uint8Array ? entry : entry.getPixels()
      if (pixels === sheet[i]) continue
      if (!patched) patched = sheet.slice()
      patched[i] = pixels
    }
    if (patched) out[slot] = patched
  }
  return out
}
