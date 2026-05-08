/**
 * parallaxDerivation.ts — port of the bank_00 `UpdateScreenPosition`
 * L2 parallax derivation + 8-byte `Layer→Next` block copy
 * (`CODE_00F79D` / `CODE_00F7AA`, bank_00.asm:13727-13772).
 *
 * Runs once per frame BEFORE the bank_05 cmd handlers. It re-derives
 * `Layer2*Pos` from the current `Layer1*Pos` based on the level's
 * parallax-rate bytes, then copies all four `Layer*Pos` fields into
 * `NextLayer*Pos`. The bank_05 cmd handlers may then OVERWRITE
 * `Next*Pos` for the layer they animate. For levels where l2cmd=0
 * (e.g. $00C), the L2 dispatch BEQs out with no per-frame handler — so
 * `Next2*Pos` is whatever this routine just wrote, which is what makes
 * the L2 plane scroll at the per-level parallax rate even when its cmd
 * handler is a no-op.
 *
 * X-axis rules (no offset):
 *   horizSetting 0      → Layer2XPos unchanged (locked)
 *   horizSetting 1      → Layer2XPos = Layer1XPos
 *   horizSetting >= 2   → Layer2XPos = Layer1XPos >> 1
 *
 * Y-axis rules (with `backgroundVertOffset`):
 *   vertSetting 0       → Layer2YPos unchanged
 *   vertSetting 1       → Layer2YPos = Layer1YPos + bgOffset
 *   vertSetting 2       → Layer2YPos = (Layer1YPos >> 1) + bgOffset
 *   vertSetting >= 3    → Layer2YPos = (Layer1YPos >> 5) + bgOffset
 *
 * `backgroundVertOffset` is calibrated ONCE at level entry so the
 * initial `Layer2YPos` survives the first parallax pass:
 *   bgOffset = layer2YPos_seed - parallaxYBase(layer1YPos_seed, vertSetting)
 *
 * 8-byte block copy (line 13768-13772):
 *   for X in [7, 6, 5, 4, 3, 2, 1, 0]:
 *     NextLayer1XPos+X ← Layer1XPos+X
 * Effectively: Next* = Layer* for all four 16-bit position fields.
 */

import type { ScrollState } from '../scrollSim'
import { wrap16 } from '../scrollSim'

/**
 * Compute the bgOffset such that
 * `parallaxYBase(layer1YPos_seed) + bgOffset === layer2YPos_seed`.
 * For vertSetting=0 the formula is unused (Y is held). Returns 0 for
 * setting=0 to keep the state field deterministic.
 */
export function computeBackgroundVertOffset(
  layer1YPos: number, layer2YPos: number, vertSetting: number,
): number {
  if (vertSetting === 0) return 0
  let base: number
  if (vertSetting === 1)      base = layer1YPos
  else if (vertSetting === 2) base = layer1YPos >>> 1
  else                        base = layer1YPos >>> 5
  return wrap16(layer2YPos - base)
}

/**
 * Apply one frame of bank_00 parallax derivation + 8-byte Layer→Next
 * copy. Mutates only `Layer2*Pos` and `NextLayer*Pos`.
 *
 * Order matters: the derivation runs FIRST (reading current Layer*Pos,
 * writing Layer2*Pos), then the copy propagates all four positions to
 * the Next* shadow.
 */
export function applyParallaxDerivation(s: ScrollState): ScrollState {
  // X axis.
  let l2x = s.layer2XPos
  if (s.horizLayer2Setting === 0) {
    // Locked.
  } else if (s.horizLayer2Setting === 1) {
    l2x = s.layer1XPos
  } else {
    l2x = s.layer1XPos >>> 1
  }

  // Y axis.
  let l2y = s.layer2YPos
  if (s.vertLayer2Setting === 0) {
    // Held.
  } else {
    let base: number
    if (s.vertLayer2Setting === 1)      base = s.layer1YPos
    else if (s.vertLayer2Setting === 2) base = s.layer1YPos >>> 1
    else                                base = s.layer1YPos >>> 5
    l2y = wrap16(base + s.backgroundVertOffset)
  }

  // 8-byte Layer→Next copy.
  return {
    ...s,
    layer2XPos:     wrap16(l2x),
    layer2YPos:     wrap16(l2y),
    nextLayer1XPos: s.layer1XPos,
    nextLayer1YPos: s.layer1YPos,
    nextLayer2XPos: wrap16(l2x),
    nextLayer2YPos: wrap16(l2y),
  }
}
