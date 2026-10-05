/**
 * What a map's layer 3 is drawn from, and whether it is drawn at all (#561, #562).
 * Beside `buildL1Inputs` / `buildL2Inputs`: data, not pixels.
 *
 * Drawn on every level mode except the Mode 7 boss rooms (`LevelScreenTables`),
 * at its load-time Y (`l3LoadTimeY`), with no animation (#115). The verdict also
 * carries what the compositor needs whether or not layer 3 draws: the per-screen
 * plane lists (`ScreenPlanes`), the effective CGADSUB and the layer 2 role. The
 * rest are refusals carrying their reason, never a guess: camera-locked layer 3
 * has no fixed place (#563). The main/sub designations only mean BG1/BG2/BG3 in
 * BG mode 1, so an unverified mode keeps the old stacking and no math.
 */
import type { RomFile } from '../RomFile'
import type { RgbaColor } from '../GraphicsDecoder'
import { readL3Chars, type GfxSheet } from '../GfxLoader'
import type { BgModeResult } from '../BgMode'
import { layoutRefusal, readModeLayouts } from '../LevelScreenTables'
import { HOOKED_L3_CODE, readL3CodeGate, type L3CodeGate } from '../L3CodeGate'
import { l3LoadTimeY, loadL3Tilemap, readInitialLayer1YPos } from '../L3Loader'
import { readLayer3Setting } from '../ObjectExpander'
import type { L1Inputs } from './L1Model'
import { effectiveCgadsub } from './ColorMath'
import { FALLBACK_SCREENS, screenPlanes, type ScreenPlanes } from './ScreenPlanes'

export interface L3Inputs {
  /** The 64 x 64 BG3 tilemap, index = row * 64 + col, HUD rows included (the drawing skips them). */
  tilemap: Uint16Array
  /** GFX28-GFX2B, 128 chars each. */
  chars: GfxSheet[]
  /** CGRAM; BG3's 2bpp palette P is colors P*4..P*4+3. */
  colors: RgbaColor[]
  /** Layer3YPos at load, and Layer1YPos at load: a tile row R sits at level Y R*8 - yPx + camYPx. */
  yPx: number
  camYPx: number
  /** A tide ($00-$7F settings byte) tiles every 256 px and draws one copy of its two-copy tilemap. */
  tide: boolean
}

export interface L3Verdict {
  /** Planes per SNES screen, bottom to top. The old BG1/BG2 stacking when the tables are unverified. */
  screens: ScreenPlanes
  /** CGADSUB as the game leaves it (BG3 cleared by CODE_009FB8); null: unverified or refused, no math. */
  cgadsub: number | null
  /** VerticalTable bit 7: layer 2 is the interactive foreground (bank_00.asm:11736-11738). */
  layer2Interactive: boolean
  /** Header byte 2 bit 7: BG3's priority-1 pass goes in front of BG1 (set) or behind it (clear). */
  priority: boolean
  l3: L3Inputs | null
  /** Why `l3` is null (also when the map simply has no layer 3). */
  reason: string | null
}

type Wanted = Pick<L1Inputs, 'header' | 'isVertical' | 'colors'>

export function buildL3Verdict(
  rom: RomFile,
  index: number,
  l1: Wanted,
  bg: BgModeResult,
  chars: (rom: RomFile) => GfxSheet[] | null = readL3Chars,
  gate: L3CodeGate = readL3CodeGate(rom),
): L3Verdict {
  const priority = l1.header.layer3Priority
  const base = { priority, screens: FALLBACK_SCREENS, cgadsub: null, layer2Interactive: false }
  const other = (reason: string): L3Verdict => ({ ...base, l3: null, reason })
  if (!bg.ok) return other(`Layer 3 not drawn: ${bg.reason}`)
  // The tables decide how the screens stack whether or not the map has a layer 3, so they are
  // read first; the reason a map says is the more specific one, "no layer 3" before the layout's.
  const layouts = readModeLayouts(rom)
  if (!layouts.ok) {
    return other(
      readLayer3Setting(rom, index) === 0
        ? 'This map has no layer 3'
        : `Layer 3 not drawn: ${layouts.reason}`,
    )
  }
  const layout = layouts.layouts[l1.header.levelMode & 0x1f]!
  const refusal = layoutRefusal(layout)
  const known = refusal
    ? base
    : {
        priority,
        screens: screenPlanes(layout.main, layout.sub, priority),
        // BG3 leaves CGADSUB on every path but the camera-locked one (bank_00.asm:4170-4199).
        cgadsub: effectiveCgadsub(layout.cgadsub, true),
        layer2Interactive: (layout.vertical & 0x80) !== 0,
      }
  const none = (reason: string, over: Partial<L3Verdict> = {}): L3Verdict => ({
    ...known,
    l3: null,
    reason,
    ...over,
  })
  if (readLayer3Setting(rom, index) === 0) return none('This map has no layer 3')
  if (refusal) return none(refusal)
  // Y at load is not read for vertical maps: a sublevel's entry never reads F600 (bank_05.asm:7116-7162).
  if (l1.isVertical) return none('Layer 3 not drawn yet: vertical maps')
  if (!gate.ok) return none(HOOKED_L3_CODE)
  const tileset = l1.header.objectTileset
  const load = loadL3Tilemap(rom, index, tileset, l1.header.timeLimit)
  if (!load) return none("This map's layer 3 tilemap cannot be read")
  const yPx = l3LoadTimeY(load.settingsByte, tileset)
  if (yPx === null) {
    // Only a $81-$BF byte skips the TRB that clears BG3 (CODE_00A01F, bank_00.asm:4174); byte $00
    // takes the tide path to CODE_00A01B (:4164) and is cleared. #563 draws the kept case.
    const kept = (load.settingsByte & 0x80) !== 0
    return none('Layer 3 not drawn yet: camera-locked layer 3', {
      cgadsub: effectiveCgadsub(layout.cgadsub, !kept),
    })
  }
  // The GFX loader (CODE_00A993) is a third piece of layer 3 code: hooked, or any file failing to load, leaves no chars.
  const sheets = chars(rom)
  if (!sheets || sheets.length === 0) return none(HOOKED_L3_CODE)
  return {
    ...known,
    reason: null,
    l3: {
      tilemap: load.tilemap,
      chars: sheets,
      colors: l1.colors,
      yPx,
      camYPx: readInitialLayer1YPos(rom, index),
      // $00 is Layer3TideSetting 0: no tide (it is camera-locked or Castle1/Underground1's half-speed scroll).
      tide: load.settingsByte !== 0 && load.settingsByte < 0x80,
    },
  }
}
