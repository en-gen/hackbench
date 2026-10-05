/**
 * What a map's layer 3 is drawn from, and whether it is drawn at all (#561).
 * Beside `buildL1Inputs` / `buildL2Inputs`: data, not pixels.
 *
 * Drawn only on the standard layer layout (`LevelScreenTables`), at its
 * load-time Y (`l3LoadTimeY`), with no animation (#115). Everything else is a
 * refusal carrying its reason, never a guess: interactive and other layouts
 * stack differently (#562), camera-locked layer 3 has no fixed place (#563).
 * "Standard" also needs BG mode 1, because the main/sub designations only mean
 * BG1/BG2/BG3 there; an unverified mode is `layout: 'other'`.
 */
import type { RomFile } from '../RomFile'
import type { RgbaColor } from '../GraphicsDecoder'
import { loadL3Chars, type GfxSheet } from '../GfxLoader'
import type { BgModeResult } from '../BgMode'
import { layoutRefusal, readModeLayouts } from '../LevelScreenTables'
import { HOOKED_L3_CODE, readL3CodeGate, type L3CodeGate } from '../L3CodeGate'
import { l3LoadTimeY, loadL3Tilemap, readInitialLayer1YPos } from '../L3Loader'
import { readLayer3Setting } from '../ObjectExpander'
import type { L1Inputs } from './L1Model'

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
  /** 'standard': BG2 is on the sub screen only. 'other' (or unverified): the old BG mode 1 stacking. */
  layout: 'standard' | 'other'
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
  chars: (rom: RomFile) => GfxSheet[] = loadL3Chars,
  gate: L3CodeGate = readL3CodeGate(rom),
): L3Verdict {
  const priority = l1.header.layer3Priority
  const other = (reason: string): L3Verdict => ({ layout: 'other', priority, l3: null, reason })
  if (!bg.ok) return other(`Layer 3 not drawn: ${bg.reason}`)
  // The layout decides how layer 2 stacks whether or not the map has a layer 3, so it is read
  // first; the reason a map says is the more specific one, "no layer 3" before the layout's.
  const layouts = readModeLayouts(rom)
  const refusal = layouts.ok ? layoutRefusal(layouts.layouts[l1.header.levelMode & 0x1f]!) : null
  const layout = layouts.ok && !refusal ? 'standard' : 'other'
  const none = (reason: string): L3Verdict => ({ layout, priority, l3: null, reason })
  if (readLayer3Setting(rom, index) === 0) return none('This map has no layer 3')
  if (!layouts.ok) return none(`Layer 3 not drawn: ${layouts.reason}`)
  if (refusal) return none(refusal)
  // Y at load is not read for vertical maps: a sublevel's entry never reads F600 (bank_05.asm:7116-7162).
  if (l1.isVertical) return none('Layer 3 not drawn yet: vertical maps')
  if (!gate.ok) return none(HOOKED_L3_CODE)
  const tileset = l1.header.objectTileset
  const load = loadL3Tilemap(rom, index, tileset, l1.header.timeLimit)
  if (!load) return none("This map's layer 3 tilemap cannot be read")
  const yPx = l3LoadTimeY(load.settingsByte, tileset)
  if (yPx === null) return none('Layer 3 not drawn yet: camera-locked layer 3')
  return {
    layout: 'standard',
    priority,
    reason: null,
    l3: {
      tilemap: load.tilemap,
      chars: chars(rom),
      colors: l1.colors,
      yPx,
      camYPx: readInitialLayer1YPos(rom, index),
      tide: load.settingsByte < 0x80,
    },
  }
}
