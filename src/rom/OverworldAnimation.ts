/**
 * OverworldAnimation.ts -- Reads the overworld L1 tile-animation tables.
 *
 * Source: `OW_Tile_Animation` at `bank_04.asm:74-151` plus the frame-pointer
 * table `DATA_048006` (`bank_04.asm:6-22`) and the helper paint routine
 * `CODE_0480B9` (`bank_04.asm:51-72`).
 *
 * The actual animation work in vanilla SMW splits into three mechanisms:
 *
 *   1. Water (`bank_04.asm:74-93`):
 *      A bit-rotate in place on bytes of `GfxDecompOWAni` - every 8 frames
 *      (`TrueFrame & $07 == 0`) a 32-byte block is rotated left or right
 *      depending on bit 3 of the index. Pure pixel-shimmer, no source bytes.
 *   2. Waterfall (`bank_04.asm:97-110`):
 *      Same general idea, different rotation pattern. Still in-place.
 *   3. Crumbling castle (`bank_04.asm:111-148`):
 *      Frame-swap from `DATA_048006`. The frame index is computed from
 *      `TrueFrame` masked with $38 or $70 (slow vs fast cycle), then used to
 *      look up an 8-word pointer in `DATA_048006`. The 16 bytes (8 words)
 *      at that pointer are DMA'd into `GfxDecompOWAni` at a fixed offset.
 *
 * For the viewer's first pass we only surface the `DATA_048006` pointer
 * table - that's the only animation data with a stable ROM source. The
 * water/waterfall pixel rotators do not have ROM-side data to surface
 * (their state is purely live VRAM during play). The viewer toggle for
 * "Animation" can drive a webview-side timer; the actual frame-swap
 * rendering is deferred to a follow-up that decodes `GfxDecompOWAni`'s
 * source content (which is part of GFX file $14, see `bank_00.asm:4335`).
 */

import { RomFile } from './RomFile'

// ── Constants from asm ───────────────────────────────────────────────────────

/** SNES address of `DATA_048006`. */
export const OW_ANIM_FRAME_TABLE_ADDR = 0x048006
/** Number of word entries in `DATA_048006` (counted from bank_04.asm:6-22). */
export const OW_ANIM_FRAME_COUNT = 64
/**
 * Animation tick period: `OW_Tile_Animation` runs every 8 frames
 * (`TrueFrame & $07` per `bank_04.asm:75-77`). At 60 fps that's ~7.5 Hz.
 */
export const OW_ANIM_PERIOD_FRAMES = 8

/** Bank for animation tile-data pointers (used at runtime by `[_0],Y` with `_2=$7E`). */
export const OW_ANIM_DATA_BANK = 0x7e

// ── Types ────────────────────────────────────────────────────────────────────

export interface OwAnimFrameTable {
  /**
   * 64 word entries from `DATA_048006`. Each is a 16-bit address; at
   * runtime the OW animation handler reads 8 source words from
   * `($7E:value)` and DMAs them into `GfxDecompOWAni`. We surface the raw
   * pointers so a future renderer can resolve them once we trace exactly
   * where the source bytes live in ROM (vanilla preloads them from GFX
   * file $14 at OW entry, but the byte-by-byte mapping isn't decoded yet).
   */
  framePointers: number[]
}

// ── ROM read ─────────────────────────────────────────────────────────────────

export function loadOverworldAnimation(rom: RomFile): OwAnimFrameTable {
  const buf = rom.readAt(OW_ANIM_FRAME_TABLE_ADDR, OW_ANIM_FRAME_COUNT * 2)
  const pointers: number[] = []
  if (buf) {
    for (let i = 0; i < OW_ANIM_FRAME_COUNT; i++) {
      pointers.push(buf.readUInt16LE(i * 2))
    }
  } else {
    for (let i = 0; i < OW_ANIM_FRAME_COUNT; i++) pointers.push(0)
  }
  return { framePointers: pointers }
}
