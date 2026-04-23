import type { RgbaColor } from '../../GraphicsDecoder'
import type { LevelHeader } from '../../LevelParser'
import { loadPaletteAnimData } from '../../PaletteAnimationLoader'
import { buildLevelCgram, loadBackAreaColors, loadRomPalettes } from '../../PaletteLoader'
import type { RomFile } from '../../RomFile'
import { Color } from './Color'
import { Palette } from './Palette'
import { CyclingColorBehavior } from './behaviors/CyclingColorBehavior'
import { StaticColorBehavior } from './behaviors/StaticColorBehavior'

/**
 * Build a level's palette from ROM per the level header.
 *
 * CGRAM cells that participate in the NMI palette animation ($64 in
 * level mode) are wrapped in `CyclingColorBehavior` using the ROM's
 * FlashingColors frames. All other cells get `StaticColorBehavior`. This means
 * frame 0 is already applied on initial render (matching legacy's
 * `applyPalAnimFrame(0)` kick-off), and advancing `ctx.palAnimFrame`
 * cycles them automatically.
 */
export function buildPalette(rom: RomFile, header: LevelHeader): Palette {
  const romPalettes = loadRomPalettes(rom, header.bgPalette)
  const cgram = buildLevelCgram(
    romPalettes,
    header.bgPalette,
    header.fgPalette,
    header.spriteSet,
  )

  const animByCgramIdx = collectPaletteAnimFrames(rom)
  const cells = cgram.rows.map((row, r) =>
    row.map((rgba, c) => {
      const cgramIdx = (r << 4) | c
      const frames = animByCgramIdx.get(cgramIdx)
      if (frames) return new Color(new CyclingColorBehavior(frames))
      return new Color(new StaticColorBehavior(rgba))
    }),
  )

  const backAreas = loadBackAreaColors(rom)
  const backArea: RgbaColor = backAreas[header.bgColor] ?? [0, 0, 0, 255]
  return new Palette(cells, new Color(new StaticColorBehavior(backArea)))
}

/**
 * Transpose level-mode palette animation data (per-frame patch list)
 * into per-cell frame lists. Only cells with all frames populated are
 * returned — partial entries fall back to static rendering.
 */
function collectPaletteAnimFrames(rom: RomFile): Map<number, RgbaColor[]> {
  const out = new Map<number, RgbaColor[]>()
  const anim = loadPaletteAnimData(rom, 'level')
  if (!anim) return out
  for (let f = 0; f < anim.frameCount; f++) {
    for (const patch of anim.frames[f]) {
      let frames = out.get(patch.cgramIdx)
      if (!frames) {
        frames = new Array(anim.frameCount)
        out.set(patch.cgramIdx, frames)
      }
      frames[f] = patch.color
    }
  }
  for (const [idx, frames] of out) {
    if (frames.some(f => !f)) out.delete(idx)
  }
  return out
}
