/**
 * What a map's layer 3 is drawn from, and whether it is drawn at all (#561, #562).
 * Beside `buildL1Inputs` / `buildL2Inputs`: data, not pixels.
 *
 * Drawn on every level mode except the Mode 7 boss rooms (`LevelScreenTables`),
 * at its load-time Y (`l3LoadTimeY`), with no animation (#115). The verdict also
 * carries what the compositor needs whether or not layer 3 draws: the per-screen
 * plane lists (`ScreenPlanes`), the effective CGADSUB and the layer 2 role. The
 * rest are refusals carrying their reason, never a guess. Camera-locked layer 3
 * ($81-$BF) is world-locked and draws from the entrance camera (#563,
 * docs/rom/layer3-world-locked.md); $00 off Castle1 and Underground1, mode 0E and
 * vertical maps still refuse. The main/sub designations only mean BG1/BG2/BG3 in
 * BG mode 1, so an unverified mode keeps the old stacking and no math.
 */
import type { RomFile } from '../RomFile'
import type { RgbaColor } from '../GraphicsDecoder'
import { readL3Chars, type GfxSheet } from '../GfxLoader'
import type { BgModeResult } from '../BgMode'
import { layoutRefusal, readModeLayouts } from '../LevelScreenTables'
import { HOOKED_L3_CODE, readL3CodeGate, type L3CodeGate } from '../L3CodeGate'
import { l3LoadTimeY, loadL3Tilemap, readInitialLayer1YPos } from '../L3Loader'
import { CAMERA_HOOKED, entranceCameraX, readEntranceCameraGate } from '../L3EntranceCamera'
import { readMarioStartPos } from '../MarioStartPos'
import { readL3SmashLoadPos, type L3SmashResult } from '../L3Smash'
import { readLayer3Setting } from '../ObjectExpander'
import type { MapEntrances } from '../SmwRom'
import type { L1Inputs } from './L1Model'
import { entrancePositionGate } from '../SubmapFlagGate'
import { effectiveCgadsub } from './ColorMath'
import { FALLBACK_SCREENS, screenPlanes, type ScreenPlanes } from './ScreenPlanes'

/** Passed as `entrances` when the exit graph itself failed; distinct from a map the graph never reaches. */
export const GRAPH_UNAVAILABLE = 'graph-unavailable'

/**
 * Said when the exit graph could not be built (a hooked hack, #910): which entrance starts the map
 * is then unknown, so `chooseEntrance` falls back to the primary row, a guess a secondary-only map
 * would contradict. Reads after "Layer 3 position unverified: ".
 */
export const EXIT_GRAPH_UNAVAILABLE =
  'HackBench could not work out which entrance starts this map, so this layer is placed as if the map were entered from its main entrance.' // prettier-ignore

/**
 * A world-locked Layer 3 is anchored at the camera of a direct load; a map entered by a screen exit starts
 * from the previous map's camera, which is not known here (docs/rom/layer3-world-locked.md). Reads after
 * "Layer 3 position unverified: ".
 */
export const SCREEN_EXIT_CAMERA =
  "this map is entered from another map, and that map's camera decides where this layer starts." // prettier-ignore

export interface L3Inputs {
  /** The 64 x 64 BG3 tilemap, index = row * 64 + col, HUD rows included (the drawing skips them). */
  tilemap: Uint16Array
  /** GFX28-GFX2B, 128 chars each. */
  chars: GfxSheet[]
  /** CGRAM; BG3's 2bpp palette P is colors P*4..P*4+3. */
  colors: RgbaColor[]
  /** Layer3XPos drawn at camera X 0: 0 unless a smash sprite drives it (the smasher's first landing, #997). Absent: 0. */
  xPx?: number
  /** Layer3YPos at load, and Layer1YPos at load: a tile row R sits at level Y R*8 - yPx + camYPx. */
  yPx: number
  camYPx: number
  /**
   * Set for a settings byte $81-$BF off Castle1 and Underground1 (CODE_00A01F, bank_00.asm:4174): Layer 3
   * is world-locked, so tilemap column 0 sits at map X `camXPx`, the camera when the level loaded, and
   * the 512 px tilemap repeats across the map. In the game it also drifts left (#563).
   */
  worldLocked?: { camXPx: number }
  /** A tide ($00-$7F settings byte) tiles every 256 px and draws one copy of its two-copy tilemap. */
  tide: boolean
  /**
   * Why `camYPx` is a best reading, not confirmed (#860, #910), one sentence each. A list like L2's
   * `reasons`, so a reason both layers give is merged by whole sentence (#926). Absent: confirmed.
   */
  camYReasons?: string[]
  /**
   * A loaded Layer 3 Smash sprite drives this layer (#997): it rewrites Layer3XPos/YPos every frame
   * (bank_00.asm:14778-14803), X scrolling with the camera and re-rolled each smash cycle
   * (bank_02.asm:11147-11166). A whole-map view has no camera, so it draws the layer as one
   * copy and never repeats it every 512 px.
   */
  followsCamera?: boolean
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
  entrances?: MapEntrances | typeof GRAPH_UNAVAILABLE,
  startSpans?: Parameters<typeof entrancePositionGate>[1],
  cameraGate: (rom: RomFile) => L3CodeGate = readEntranceCameraGate,
): L3Verdict {
  const priority = l1.header.layer3Priority
  const via = entrances === GRAPH_UNAVAILABLE ? undefined : entrances
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
  let yPx = l3LoadTimeY(load.settingsByte, tileset)
  let worldLocked: L3Inputs['worldLocked']
  if (yPx === null) {
    // Only a $81-$BF byte skips the TRB that clears BG3 (CODE_00A01F, bank_00.asm:4174); byte $00
    // takes the tide path to CODE_00A01B (:4164) and is cleared.
    const kept = (load.settingsByte & 0x80) !== 0
    const refuse = (reason = 'Layer 3 not drawn yet: camera-locked layer 3') =>
      none(reason, {
        cgadsub: effectiveCgadsub(layout.cgadsub, !kept),
      })
    // The world-locked draw is verified for $81-$BF where BG3 is not alone on the main screen; mode 0E
    // ($018) adds it onto layers 1 and 2 and stays refused.
    if (!kept || (layout.main & 0x03) === 0) return refuse()
    const start = readMarioStartPos(rom, index)
    if (!start) return refuse()
    if (!cameraGate(rom).ok) return refuse(CAMERA_HOOKED)
    // CODE_05BE8A copied Layer1YPos into Layer3YPos before CODE_009FB8 (bank_00.asm:4869-4870), which
    // leaves it alone on this path; CODE_05C48D keeps the copy each frame (bank_05.asm:5569-5570).
    yPx = readInitialLayer1YPos(rom, index, false, via)
    worldLocked = { camXPx: entranceCameraX(start.x) }
  }
  // A $80 byte's Y is $D0 (CODE_00A007, bank_00.asm:4184-4195) until a loaded Layer 3 Smash sprite writes X and Y
  // from its own place (#807). `smash` is the sprite's first landing, worked out by SmashLanding.ts (#997); it is
  // only run for a map that lists a smasher, so every other $80 map keeps these load-time values.
  let pos = { x: 0, y: yPx }
  let followsCamera = false
  let landingNote: string | null = null
  if (load.settingsByte === 0x80) {
    const found = smash(rom, index)
    // Viewers draw, they do not blank: a smasher whose landing cannot be worked out leaves layer 3 at
    // its load-time position, with the reason as an unverified-position note.
    if (!found.ok) landingNote = found.reason
    else if (found.pos) {
      pos = found.pos
      followsCamera = true
    }
  }
  // The GFX loader (CODE_00A993) is a third piece of layer 3 code: hooked, or any file failing to load, leaves no chars.
  const sheets = chars(rom)
  if (!sheets || sheets.length === 0) return none(HOOKED_L3_CODE)
  const startGate = entrancePositionGate(rom, startSpans)
  const reasons = [
    startGate,
    landingNote,
    entrances === GRAPH_UNAVAILABLE ? EXIT_GRAPH_UNAVAILABLE : null,
    worldLocked && via && !via.overworld && (via.primary || via.secondary.length > 0) ? SCREEN_EXIT_CAMERA : null, // prettier-ignore
  ].filter((r): r is string => !!r)
  return {
    ...known,
    // The world-locked path skips the TRB that clears BG3 (CODE_00A01F), so BG3 stays in the math.
    ...(worldLocked && { cgadsub: effectiveCgadsub(layout.cgadsub, false) }),
    reason: null,
    l3: {
      tilemap: load.tilemap,
      chars: sheets,
      colors: l1.colors,
      xPx: pos.x,
      yPx: pos.y,
      ...(worldLocked && { worldLocked }),
      camYPx: readInitialLayer1YPos(rom, index, false, via),
      camYReasons: reasons.length ? reasons : undefined,
      // $00 is Layer3TideSetting 0: no tide (it is camera-locked or Castle1/Underground1's half-speed scroll).
      tide: load.settingsByte !== 0 && load.settingsByte < 0x80,
      ...(followsCamera ? { followsCamera } : {}),
    },
  }
}
