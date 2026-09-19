/**
 * Palette animation loader — FlashingColors CGRAM cycling (bank_00.asm).
 *
 * SMW has two NMI paths that write to different CGRAM slots from the same
 * FlashingColors table at $00B60C:
 *
 *   Level NMI  (80/A41A): writes 1 BGR555 word → CGRAM $64 (row 6 col 4)
 *     lda #$64 / stz $00 / sta $2121 / ... / lda $B60C,Y / sta $2122  (yellow only)
 *
 *   Overworld NMI (80/A4E3): writes 2 BGR555 words → CGRAM $6D + $7D
 *     lda #$6D / jsr $A41C  (offset 0  → yellow, bytes  0–14)
 *     lda #$10 / sta $00 / lda #$7D / jmp $A41E  (offset $10 → red, bytes 16–30)
 *
 * FlashingColors at $00B60C (32 bytes):
 *   Bytes  0–15 : 8 yellow BGR555 words (used by level $64 and overworld $6D)
 *   Bytes 16–31 : 8 red    BGR555 words (overworld $7D only)
 *
 * Timing: EffFrame bits 2-4 advance every 4 game frames.
 *   At 60.098 fps → ~66 ms per phase, 8 phases ≈ 533 ms full cycle.
 *
 * These CGRAM targets are hardcoded in the NMI handler — no ROM data marks
 * palette slots as "animated"; it is a fixed engine behaviour.
 *
 * References: bank_00.asm 80/A41A–A435 (level), 80/A4E3–A51E (overworld)
 */

import { RomFile } from './RomFile'
import { bgr555ToRgba } from './GraphicsDecoder'
import { framesToMs } from './timing'

// ── Constants ────────────────────────────────────────────────────────────────

export const PAL_ANIM_FRAME_COUNT = 8

/**
 * Milliseconds per palette animation phase.
 * EffFrame bits 2-4 change every 4 game frames → 4 / 60.098 ≈ 66 ms.
 */
export const PAL_ANIM_FRAME_STRIDE = 4
export const PAL_ANIM_INTERVAL_MS = Math.round(framesToMs(PAL_ANIM_FRAME_STRIDE))

/**
 * Level NMI: CGRAM $64 = row 6 col 4 (StandardColors row 2, col 4).
 * Dragon-coin yellow — the only slot cycled in regular levels.
 */
export const PAL_ANIM_CGRAM_LEVEL = 0x64

/**
 * Overworld NMI: CGRAM $6D = row 6 col 13. Yellow slot.
 */
export const PAL_ANIM_CGRAM_YELLOW = 0x6D

/**
 * Overworld NMI: CGRAM $7D = row 7 col 13. Red slot.
 */
export const PAL_ANIM_CGRAM_RED = 0x7D

/** FlashingColors table address: 8 yellow + 8 red BGR555 words = 32 bytes. */
const FLASHING_COLORS_ADDR = 0x00B60C

// ── Types ────────────────────────────────────────────────────────────────────

/** One CGRAM color slot update for a single animation frame. */
export interface PaletteAnimPatch {
  /** CGRAM color index 0–255: row = cgramIdx >> 4, col = cgramIdx & 15. */
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
 * Read the FlashingColors table from ROM and return per-frame CGRAM patches.
 *
 * @param mode  'level'     — animates CGRAM $64 only (level NMI path, 80/A41A)
 *              'overworld' — animates CGRAM $6D + $7D (overworld NMI path, 80/A4E3)
 *
 * Returns null if the ROM data is unavailable.
 */
export function loadPaletteAnimData(rom: RomFile, mode: 'level' | 'overworld' = 'overworld'): PaletteAnimData | null {
  const frames: PaletteAnimPatch[][] = []

  for (let f = 0; f < PAL_ANIM_FRAME_COUNT; f++) {
    const patches: PaletteAnimPatch[] = []

    // Yellow values: bytes 0–15 of FlashingColors (offset = f * 2)
    const yellowBuf = rom.readAt(FLASHING_COLORS_ADDR + f * 2, 2)

    if (mode === 'level') {
      // Level NMI writes only the yellow cycle to CGRAM $64
      if (yellowBuf) {
        patches.push({ cgramIdx: PAL_ANIM_CGRAM_LEVEL, color: bgr555ToRgba(yellowBuf.readUInt16LE(0)) })
      }
    } else {
      // Overworld NMI writes yellow → $6D and red → $7D
      if (yellowBuf) {
        patches.push({ cgramIdx: PAL_ANIM_CGRAM_YELLOW, color: bgr555ToRgba(yellowBuf.readUInt16LE(0)) })
      }
      const redBuf = rom.readAt(FLASHING_COLORS_ADDR + 0x10 + f * 2, 2)
      if (redBuf) {
        patches.push({ cgramIdx: PAL_ANIM_CGRAM_RED, color: bgr555ToRgba(redBuf.readUInt16LE(0)) })
      }
    }

    frames.push(patches)
  }

  return { frameCount: PAL_ANIM_FRAME_COUNT, intervalMs: PAL_ANIM_INTERVAL_MS, frames }
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
      frame.map(p => ({ cgramIdx: p.cgramIdx, r: p.color[0], g: p.color[1], b: p.color[2], a: p.color[3] }))
    ),
  }
}

export interface SerializedPaletteAnimData {
  frameCount: number
  intervalMs: number
  frames: Array<Array<{ cgramIdx: number; r: number; g: number; b: number; a: number }>>
}
