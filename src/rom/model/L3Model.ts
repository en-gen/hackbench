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
import { readL3SmashLoadPos, type L3SmashResult } from '../L3Smash'
import { readLayer3Setting } from '../ObjectExpander'
import type { MapEntrances } from '../SmwRom'
import type { L1Inputs } from './L1Model'
import { entrancePositionGate } from '../SubmapFlagGate'
import { effectiveCgadsub } from './ColorMath'
import { FALLBACK_SCREENS, screenPlanes, type ScreenPlanes } from './ScreenPlanes'

export interface L3Inputs {
  /** The 64 x 64 BG3 tilemap, index = row * 64 + col, HUD rows included (the drawing skips them). */
  tilemap: Uint16Array
  /** GFX28-GFX2B, 128 chars each. */
  chars: GfxSheet[]
  /** CGRAM; BG3's 2bpp palette P is colors P*4..P*4+3. */
  colors: RgbaColor[]
  /** Layer3XPos at load (0 unless a smash sprite sets it, #807); camera X at load is 0. Absent: 0. */
  xPx?: number
  /** Layer3YPos at load, and Layer1YPos at load: a tile row R sits at level Y R*8 - yPx + camYPx;
   * a vertical map omits camYPx (screen-locked: bank_05.asm:5569-5572 is never reached). */
  yPx: number
  camYPx: number
  /** A vertical map: screens stack downward, 32 tiles wide and 16 tall, and X is not paged. */
  isVertical?: boolean
  /** A tide ($00-$7F settings byte) tiles every 256 px and draws one copy of its two-copy tilemap. */
  tide: boolean
  /** Set when the code that reads `camYPx` is not stock (#860): the value is a best reading, not confirmed. */
  camYUnverified?: string
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
  smash: (rom: RomFile, index: number) => L3SmashResult = readL3SmashLoadPos,
  entrances?: MapEntrances,
  startSpans?: Parameters<typeof entrancePositionGate>[1],
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
  // Vertical maps draw only the traced $81-$BF Y $C0 case (CODE_009FFA, bank_00.asm:4175-4182; the
  // derivation is in docs/rom/level-rendering.md). Tides, $80 and camera-locked Y stay refused.
  if (l1.isVertical && !(yPx === 0xc0 && load.settingsByte < 0xc0)) {
    return none('Layer 3 not drawn yet: vertical map with an untraced layer 3 type')
  }
  // A $80 byte's Y is $D0 until a loaded Layer 3 Smash sprite writes X and Y from its own place (#807).
  let pos = { x: 0, y: yPx }
  if (load.settingsByte === 0x80) {
    const found = smash(rom, index)
    if (!found.ok) return none(found.reason)
    if (found.pos) pos = found.pos
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
      xPx: pos.x,
      yPx: pos.y,
      camYPx: readInitialLayer1YPos(rom, index, false, entrances),
      isVertical: l1.isVertical || undefined,
      // A vertical map's band is screen-locked and ignores camYPx, so there is nothing to be unverified.
      camYUnverified: l1.isVertical
        ? undefined
        : (entrancePositionGate(rom, startSpans) ?? undefined),
      // $00 is Layer3TideSetting 0: no tide (it is camera-locked or Castle1/Underground1's half-speed scroll).
      tide: load.settingsByte !== 0 && load.settingsByte < 0x80,
    },
  }
}
