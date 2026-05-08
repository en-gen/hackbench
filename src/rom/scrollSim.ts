/**
 * scrollSim.ts — frame-based simulator for SMW's scroll routines.
 *
 * Computes `Layer1XPos / Layer1YPos / Layer2XPos / Layer2YPos` (and all
 * intermediate state) at any frame N for a given level. Faithful port of
 * the per-frame routines in `bank_05.asm` + `bank_00.asm`'s
 * `UpdateScreenPosition`.
 *
 * Why this exists: the table-init values from CODE_05D8B7
 * (`readInitialLayer{1,2}YPos`) describe a single frame at level entry
 * before any per-frame logic runs. Mid-gameplay positions diverge as
 * `CODE_05C04D` (parallax) and per-cmd handlers update state every frame,
 * and as `UpdateScreenPosition` (bank_00:13631-13835) makes the camera
 * track Mario vertically. The L2 viewport's perceived motion relative to
 * L1 — which is what the editor needs to render — is the integral of all
 * those per-frame mutations.
 *
 * Validation strategy: the per-frame state is captured by
 * `tools/mesen/l2_dump.lua` into `l2_scroll.csv`. Each row of that CSV
 * is one frame's full WRAM snapshot. Tests load a CSV, replay the
 * simulator from frame 0, and assert the simulator's state matches the
 * Mesen capture row-for-row.
 *
 * Scope (incremental):
 *   - Phase 1 (this file): scaffolding, ScrollState type, dispatcher
 *     skeleton, no-op cmds ($00 default, $07 nullroutine, $09 nullroutine).
 *   - Phase 2: port CODE_05C04D parallax + cmd $01 horizontal auto-scroll +
 *     UpdateScreenPosition Mario-Y tracking. Validate against $009 capture.
 *   - Phase 3: remaining cmds ($02..$06, $08, $0A..$0E) one per session,
 *     each verified against a level that exercises it.
 *
 * Cmd dispatch (verified via earlier survey + bank_05.asm:4518-4566):
 *   L1 per-frame  CODE_05BC76 (lines 4518-4541)
 *   L2 per-frame  CODE_05BCA5 (lines 4542-4566)
 */

import type { RomFile } from './RomFile'
import { applyNext } from './scroll/applyNext'
import { cmd01L1, cmd01L2 } from './scroll/cmd01'
import { cmd02L2 } from './scroll/cmd02'
import { cmd03 } from './scroll/cmd03'
import { cmd08 } from './scroll/cmd08'
import { cmd09L2 } from './scroll/cmd09'
import { cmd0bL2 } from './scroll/cmd0b'
import { cmd0cL1 } from './scroll/cmd0c'
import { cmd0eL2 } from './scroll/cmd0e'
import { applyParallaxDerivation, computeBackgroundVertOffset } from './scroll/parallaxDerivation'
import { applyCmdSetup } from './scroll/setup'

// ── ScrollState ──────────────────────────────────────────────────────────

/**
 * The minimum WRAM state needed to deterministically advance one frame.
 * Mirrors the columns recorded by `tools/mesen/l2_dump.lua` so a single
 * CSV row decodes 1:1 into a `ScrollState`.
 *
 * All values are unsigned 8/16-bit ROM-faithful integers (i.e., wrap at
 * 256 / 65536), NOT JS numbers in disguise — see `wrap8` / `wrap16`.
 */
export interface ScrollState {
  /** Frames elapsed since level entry (1-based, matching the Lua dumper). */
  frame: number

  // Camera / BG positions — 16-bit each.
  layer1XPos: number
  layer1YPos: number
  layer2XPos: number
  layer2YPos: number

  // Scroll cmd dispatch state ($143E..$1441).
  layer1ScrollCmd:  number
  layer2ScrollCmd:  number
  layer1ScrollBits: number
  layer2ScrollBits: number

  // Per-axis parallax accumulators (CODE_05C04D state).
  layer1ScrollType:  number
  layer2ScrollType:  number
  layer1ScrollTimer: number
  layer2ScrollTimer: number
  /** 16-bit signed speed accumulators (CODE_05C04D / CODE_05C4F9). */
  layer1ScrollXSpeed: number
  layer1ScrollYSpeed: number
  layer2ScrollXSpeed: number
  layer2ScrollYSpeed: number
  /** 16-bit fractional carry accumulators ($144E..$1455). */
  layer1ScrollXPosUpd: number
  layer1ScrollYPosUpd: number
  layer2ScrollXPosUpd: number
  layer2ScrollYPosUpd: number

  // Cross-axis state.
  scrollLayerIndex: number   // 0=L1, 4=L2
  layer1ScrollDir:  number   // 0=neg, 2=pos

  // Target positions — written by CODE_05C04D / cmd handlers, then
  // applied to Layer{1,2}{X,Y}Pos by ProcScreenScrollCmds.
  nextLayer1XPos: number
  nextLayer1YPos: number
  nextLayer2XPos: number
  nextLayer2YPos: number

  // External inputs the simulator can't generate itself.
  /** Mario's projected position. UpdateScreenPosition reads this to
   *  decide whether to nudge the camera. Driven by gameplay; for the
   *  editor we treat it as a slider input or replay it from a Mesen
   *  capture. */
  playerXPosNext: number
  playerYPosNext: number
  /** Constant unless an earthquake / POW event is firing. Most levels
   *  hold this at 0 throughout. */
  screenShakeYOffset: number

  // Per-level parallax settings ($1413/$1414). Constant across frames
  // for a given level — repeated here purely so the CSV row carries the
  // full state without needing a separate per-level descriptor.
  horizLayer2Setting: number
  vertLayer2Setting:  number

  /**
   * `BackgroundVertOffset` ($7E:1A). Calibrated ONCE at level entry
   * (`bank_00.asm:5095-5112`) so the per-frame parallax derivation
   * reproduces the seeded `Layer2YPos` from the seeded `Layer1YPos`.
   * Constant across frames for a given level. Stored signed-by-wrap16.
   */
  backgroundVertOffset: number

  /**
   * `OnOffSwitch` ($7E:14B8). CMD $0B (CODE_05C727) reads this to pick
   * the scroll direction: 0 → moving toward DATA_05C71B[0] (Y=$0020),
   * non-zero → moving toward DATA_05C71B[2] (Y=$00C1). Set to 0 when
   * the "off" target is reached; toggled by On/Off switch blocks in
   * the level. The webview surfaces a checkbox so users can simulate
   * the toggle.
   */
  onOffSwitch: number

  /**
   * `Layer2Touched` ($7E:1471). CMD $0E (CODE_05C81C) gates its
   * speed/move path on `Layer1ScrollType OR Layer2Touched`. Set when
   * Mario stands on a Layer 2 platform tile. The webview surfaces a
   * checkbox so users can simulate the touch.
   */
  layer2Touched: number

  /**
   * `LastScreenHoriz` ($7E:0117). Per-level constant set at level entry
   * from the level header. Cmd $0C (CODE_05C787, auto-scroll level)
   * compares NextLayer1XPos to `(LastScreenHoriz - 1) << 8` to detect
   * the camera reaching the last screen, at which point the auto-scroll
   * speed is forced to 0.
   */
  lastScreenHoriz: number
}

/** A simulator built for one level. Pure / deterministic. */
export interface ScrollSimulator {
  /** State at frame 0 (level entry, before any per-frame routine runs). */
  readonly initial: ScrollState
  /** The seed this simulator was built from. Stashed for serialization
   *  to the webview — same seed in == same behavior out. */
  readonly seed: ScrollSimSeed
  /** Compute the next frame's state. Pure function of `s`. */
  tick(s: ScrollState): ScrollState
  /** Memoized: state at frame N (>= 0). `stateAtFrame(0) === initial`. */
  stateAtFrame(frame: number): ScrollState
}

// ── 8/16-bit wrap helpers ────────────────────────────────────────────────

export function wrap8(n: number): number  { return ((n | 0) & 0xFF) >>> 0 }
export function wrap16(n: number): number { return ((n | 0) & 0xFFFF) >>> 0 }

// ── Initial-state builder ────────────────────────────────────────────────

/**
 * Fields populated by external code (level loader, scroll-sprite setup,
 * Mario spawn). The simulator constructor combines these with all-zero
 * defaults for the per-axis accumulators.
 */
export interface ScrollSimSeed {
  layer1XPos: number
  layer1YPos: number
  layer2XPos: number
  layer2YPos: number
  layer1ScrollCmd:  number
  layer2ScrollCmd:  number
  layer1ScrollBits: number
  layer2ScrollBits: number
  horizLayer2Setting: number
  vertLayer2Setting:  number
  /** Mario's spawn pixel position. Used to seed `playerYPosNext` so the
   *  camera-tracking branch of UpdateScreenPosition starts at a sensible
   *  Mario-Y rather than 0. */
  marioSpawnX: number
  marioSpawnY: number
  /** ScrMode byte ($7E:0100). Bit 0 = `ScrMode_Layer1Vert`. Constant
   *  for the level once loaded; passed through to `parallaxTick` to
   *  decide which axis's sign feeds `Layer1ScrollDir`. */
  screenMode: number
  /** Optional: `LastScreenHoriz` ($7E:0117) for cmd $0C auto-scroll
   *  end-of-level stop. Default high value ($1F) means cmd $0C never
   *  triggers the stop in levels that don't carry this in their seed. */
  lastScreenHoriz?: number
  /** Optional: initial `OnOffSwitch` ($7E:14B8) state. Defaults to 0
   *  (switch "off"). cmd $0B (L2 On/Off Switch Y-scroll) reads this
   *  to pick the active scroll target — Y=$20 when 0, Y=$C1 when 2.
   *  The webview surfaces a checkbox for this so users can simulate
   *  Mario hitting an On/Off switch block in-game. */
  onOffSwitch?: number
  /** Optional: initial `Layer2Touched` ($7E:1471) state. Defaults to
   *  0 (Mario not on L2). cmd $0E (L2 sink/rise) gates its speed/move
   *  path on `Layer1ScrollType OR Layer2Touched`. The webview
   *  surfaces a checkbox for this so users can simulate Mario
   *  standing on an L2 platform. */
  layer2Touched?: number
}

function makeInitialState(seed: ScrollSimSeed): ScrollState {
  return {
    frame: 0,
    layer1XPos: wrap16(seed.layer1XPos),
    layer1YPos: wrap16(seed.layer1YPos),
    layer2XPos: wrap16(seed.layer2XPos),
    layer2YPos: wrap16(seed.layer2YPos),
    layer1ScrollCmd:  wrap8(seed.layer1ScrollCmd),
    layer2ScrollCmd:  wrap8(seed.layer2ScrollCmd),
    layer1ScrollBits: wrap8(seed.layer1ScrollBits),
    layer2ScrollBits: wrap8(seed.layer2ScrollBits),
    layer1ScrollType:    0,
    layer2ScrollType:    0,
    layer1ScrollTimer:   0,
    layer2ScrollTimer:   0,
    layer1ScrollXSpeed:  0,
    layer1ScrollYSpeed:  0,
    layer2ScrollXSpeed:  0,
    layer2ScrollYSpeed:  0,
    layer1ScrollXPosUpd: 0,
    layer1ScrollYPosUpd: 0,
    layer2ScrollXPosUpd: 0,
    layer2ScrollYPosUpd: 0,
    scrollLayerIndex:    0,
    layer1ScrollDir:     0,
    // Targets begin equal to the starting positions so cmds that don't
    // recompute them on frame 1 (e.g., cmd $00 static) hold position.
    nextLayer1XPos: wrap16(seed.layer1XPos),
    nextLayer1YPos: wrap16(seed.layer1YPos),
    nextLayer2XPos: wrap16(seed.layer2XPos),
    nextLayer2YPos: wrap16(seed.layer2YPos),
    playerXPosNext: wrap16(seed.marioSpawnX),
    playerYPosNext: wrap16(seed.marioSpawnY),
    screenShakeYOffset: 0,
    horizLayer2Setting: wrap8(seed.horizLayer2Setting),
    vertLayer2Setting:  wrap8(seed.vertLayer2Setting),
    onOffSwitch:   wrap8(seed.onOffSwitch ?? 0),
    layer2Touched: wrap8(seed.layer2Touched ?? 0),
    lastScreenHoriz: wrap8(seed.lastScreenHoriz ?? 0x1F),
    backgroundVertOffset: computeBackgroundVertOffset(
      wrap16(seed.layer1YPos),
      wrap16(seed.layer2YPos),
      wrap8(seed.vertLayer2Setting),
    ),
  }
}

// ── Per-cmd strategy stubs ───────────────────────────────────────────────
//
// Each strategy is a pure function `(s) → newState`. The dispatcher picks
// the strategy by `Layer{1,2}ScrollCmd` and applies them in the order
// SMW's main loop does (L1 first via CODE_05BC76, then L2 via CODE_05BCA5).
//
// Strategies for cmds we haven't ported yet fall through to `cmdHold` —
// returning the input state unchanged. This keeps the simulator usable
// for those levels (it'll just report no motion) without crashing.

type CmdStrategy = (s: ScrollState, rom: RomFile, screenMode: number) => ScrollState

/**
 * Per-frame strategy for each Layer/Cmd combination. The dispatcher
 * (`scrollSim.tick`) sets `scrollLayerIndex` to 0 (L1) or 4 (L2) before
 * invoking, and the BEQ guards mirror `CODE_05BC76` line 4523 (L1) and
 * `CODE_05BCA5` line 4546 (L2): a cmd of zero never reaches dispatch.
 */

/** Cmd $07 — explicit no-op routine (`Return05BFF5`). */
const cmdNoop: CmdStrategy = (s) => s

/** Fallback for cmds we haven't decoded yet. Returns state unchanged so
 *  the simulator keeps working; logs once per cmd id to surface what's
 *  missing. */
const cmdHold: CmdStrategy = (s) => {
  const cmd = s.layer1ScrollCmd
  if (!loggedHold.has(cmd)) {
    loggedHold.add(cmd)
    console.warn(
      `[scrollSim] cmd $${cmd.toString(16).padStart(2, '0')} not yet ported — ` +
      `returning state unchanged. Level positions will be static.`,
    )
  }
  return s
}
const loggedHold = new Set<number>()

/**
 * L1 cmd → strategy. Indexed by `layer1ScrollCmd`. cmd $00 is OMITTED:
 * the SNES `BEQ Return05BC49` guard at `CODE_05BC76:4523` ensures cmd
 * $00 never dispatches per-frame, so an L1 strategy for cmd $00 would
 * be unreachable (and was actively wrong before — calling parallaxTick
 * on a layer with timer=0 is a no-op only by accident).
 */
const L1_STRATEGIES: Record<number, CmdStrategy> = {
  0x01: (s, r, sm) => cmd01L1(s, r, sm),
  0x07: cmdNoop,
  0x08: (s, r, sm) => cmd08(s, r, 'l1', sm),
  0x0C: (s, r) => cmd0cL1(s, r),
}

/**
 * L2 cmd → strategy. Same shape as L1. cmd $00 is omitted for the same
 * BEQ-guard reason (`CODE_05BCA5:4546`). cmd $05 dispatches to
 * `Return05BC49` (no-op) per the ASM table at line 4556.
 *
 * cmd $0D dispatches to `CODE_05C7BC` which is `LDA BGFastScrollActive
 * / BEQ skip` then falls into `CODE_05C7C1` (cmd $09). We treat
 * `BGFastScrollActive` as always set, so cmd $0D becomes a thin
 * wrapper around `cmd09L2`. Levels that toggle the flag dynamically
 * may diverge.
 */
const L2_STRATEGIES: Record<number, CmdStrategy> = {
  0x01: (s, r, sm) => cmd01L2(s, r, sm),
  0x02: (s, r) => cmd02L2(s, r),
  0x03: (s, r, sm) => cmd03(s, r, 'l2', sm),
  0x05: cmdNoop,
  0x07: cmdNoop,
  0x08: (s, r, sm) => cmd08(s, r, 'l2', sm),
  0x09: (s) => cmd09L2(s),
  0x0B: (s, r) => cmd0bL2(s, r),
  0x0D: (s) => cmd09L2(s),
  0x0E: (s, r) => cmd0eL2(s, r),
}

// ── Simulator factory ────────────────────────────────────────────────────

/**
 * Build a deterministic per-frame simulator from a level's initial state.
 *
 * The seed comes from the existing `simulateScrollSetup` (cmds + bits),
 * `readInitialLayer{1,2}YPos` (positions), and the level header
 * (parallax settings + Mario spawn). The simulator from there is pure
 * — no ROM reads needed at tick time except for the parallax data tables
 * (DATA_05CA6E etc.), which are pre-loaded into the strategy closures.
 */
export function buildScrollSimulator(
  rom: RomFile,
  seed: ScrollSimSeed,
): ScrollSimulator {
  // Run the cmd setup routine once at level entry. Mirrors the
  // sprite-$E7..$F5 spawn → CODE_05BCE9 → cmd-specific setup chain.
  // For cmds we haven't ported a setup for, this is a pass-through.
  const initial = applyCmdSetup(makeInitialState(seed), rom)
  const cache: ScrollState[] = [initial]

  const screenMode = seed.screenMode

  /**
   * Per-frame state evolution mirroring SMW's main-loop ordering:
   *
   *   1. UpdateScreenPosition (bank_00:13631-13835): commits
   *      `NextLayer*` → `Layer*` at FRAME START. Modeled here via
   *      `applyNext` BEFORE the cmd handlers — confirmed against the
   *      `$009` capture: row 24 shows `l1x=0` while `nl1x=1`, meaning
   *      end-of-frame-23 has the new target queued but the visible
   *      position still lags by one frame. The Mario-Y nudge (lines
   *      13809-13833) is a pending follow-up that layers on top here.
   *   2. ProcScreenScrollCmds (bank_05.asm:4457): runs L1 cmd handler
   *      then L2 cmd handler. Each handler may call `parallaxTick`
   *      which mutates `NextLayer{1,2}{X,Y}Pos` for that layer.
   *
   * State at END of frame N:
   *   - `Layer*Pos`     = NextLayer*Pos as of END of frame N-1.
   *   - `NextLayer*Pos` = post-cmd-handler value for frame N.
   * That's how the capture rows decode.
   */
  const tick: ScrollSimulator['tick'] = (s) => {
    // 1. Implicit PPU commit: previous frame's Next* → Layer*. Models
    //    the BG{1,2}{H,V}OFS register transfer that happens between
    //    frames before bank_00 / bank_05 logic runs.
    let s2 = applyNext(s)
    // 2. bank_00 `UpdateScreenPosition` parallax derivation +
    //    8-byte Layer→Next copy (CODE_00F79D / CODE_00F7AA, see
    //    `parallaxDerivation.ts`). Re-derives Layer2*Pos from
    //    Layer1*Pos based on the level's parallax-rate bytes, then
    //    propagates Layer* → Next*. This is what makes the L2 plane
    //    scroll at the per-level rate even when its cmd handler is
    //    BEQ'd out (l2cmd=0).
    s2 = applyParallaxDerivation(s2)
    // 2b. Approximate Mario-X camera advancement for cmds whose
    //     per-frame logic is conditional on `NextLayer2XPos` (cmd $02
    //     Layer 2 Smash zone-detection loop). Vanilla SMW advances
    //     the camera via bank_00's UpdateScreenPosition Mario-tracking
    //     branch (lines 13658-13691: CameraMoveTrigger / CameraLeft-
    //     /RightBuffer / CODE_00F8AB direction-aware adjustment). A
    //     full port needs Mario's gameplay-driven `PlayerXPosNext` +
    //     subpixel speed model. As an editor-grade approximation we
    //     advance NextLayer1XPos at +1 px/frame (Mario's nominal walk
    //     speed) only for cmds that read camera-X — currently just
    //     cmd $02. Result: smash zones in `DATA_05C880`/`05C8A4` fire
    //     in their natural sequence as the camera marches forward,
    //     so `$111` / `$01A` / `$1CF` show progressive smash behavior
    //     past the intro frame instead of locking at spawn.
    if (s2.layer2ScrollCmd === 0x02) {
      s2 = { ...s2, nextLayer1XPos: wrap16(s2.nextLayer1XPos + 1) }
    }
    // 3. ProcScreenScrollCmds (CODE_05BC76 + CODE_05BCA5). Each
    //    dispatch has a BEQ guard for cmd=0 so unhandled layers get
    //    skipped entirely (their Next* stays at the parallax-derived
    //    value from step 2).
    s2 = { ...s2, scrollLayerIndex: 0 }
    if (s2.layer1ScrollCmd !== 0) {
      s2 = (L1_STRATEGIES[s2.layer1ScrollCmd] ?? cmdHold)(s2, rom, screenMode)
    }
    s2 = { ...s2, scrollLayerIndex: 4 }
    if (s2.layer2ScrollCmd !== 0) {
      s2 = (L2_STRATEGIES[s2.layer2ScrollCmd] ?? cmdHold)(s2, rom, screenMode)
    }
    return { ...s2, frame: s.frame + 1 }
  }

  const stateAtFrame: ScrollSimulator['stateAtFrame'] = (frame) => {
    if (frame < 0) throw new RangeError(`stateAtFrame: frame ${frame} < 0`)
    while (cache.length <= frame) {
      cache.push(tick(cache[cache.length - 1]))
    }
    return cache[frame]
  }

  return { initial, seed, tick, stateAtFrame }
}

// ── Layer2YPos range derivation ─────────────────────────────────────────────

export interface Layer2YRange {
  /** Smallest `Layer2YPos` value the simulator produces over the level's
   *  lifetime (until the auto-scroll camera reaches the level end or the
   *  simulator stops advancing). */
  min: number
  /** Largest `Layer2YPos`. `min === max` means the cmd produced no L2
   *  Y motion — slider has no useful range. */
  max: number
}

const VIEWPORT_PX_W = 256
/**
 * Frame cap for `computeLayer2YRange`. After fixing the SIGNED-`_0`
 * preservation in `parallaxCore.ts`, the simulator is frame-accurate
 * against the `$009` Mesen capture for 7,681 of 7,739 frames (~99%).
 * Cap at 7,800 frames (~2.2 minutes at 60 fps) — long enough to walk
 * even very long auto-scroll levels through their full L2 Y range.
 * The walk also terminates early via the `camX + VIEWPORT >=
 * levelPixelW` and stagnation checks, so non-auto-scroll levels exit
 * within a few dozen frames.
 */
const RANGE_WALK_FRAMES = 7800

/**
 * Walk the simulator for the first `RANGE_WALK_FRAMES` frames (or until
 * the camera stops advancing, indicating a non-auto-scroll level),
 * tracking the min and max `Layer2YPos` reached. Returns the `[min,
 * max]` pair the Layer-2 slider should clamp to so it can only scrub
 * through L2 viewport positions the cmd's parallax handlers actually
 * produce.
 *
 * The slider's value, when applied, becomes the "live" `Layer2YPos`.
 * `L2ObjectStream.render` then computes the L1↔L2 viewport offset as
 * `dy = mapStore.initialCameraYPx − liveLayer2YPx` — the same shift
 * SMW's BG2VOFS register applies on the actual SNES.
 *
 * For `$009` (sprite $E8 / cmd $01) the simulator now produces the
 * full L2 Y motion the auto-scroll routine drives — Mario-Y tracking
 * is NOT involved (the user clarified: in auto-scroll mode the
 * viewport path is fully script-driven by the scroll sprite, Mario
 * is dragged along). Range walk yields the actual `[$0E, $D2]` span
 * Mesen records.
 */
export function computeLayer2YRange(
  sim: ScrollSimulator,
  levelPixelW: number,
): Layer2YRange {
  let yMin = Number.POSITIVE_INFINITY
  let yMax = Number.NEGATIVE_INFINITY
  let lastCamX = -1
  let stagnantFrames = 0
  for (let f = 0; f < RANGE_WALK_FRAMES; f++) {
    const s = sim.stateAtFrame(f)
    const y = s.layer2YPos
    if (y < yMin) yMin = y
    if (y > yMax) yMax = y
    const camX = s.layer1XPos
    if (camX + VIEWPORT_PX_W >= levelPixelW) break
    if (camX === lastCamX) {
      stagnantFrames++
      if (stagnantFrames > 60) break
    } else {
      stagnantFrames = 0
      lastCamX = camX
    }
  }
  if (yMin === Number.POSITIVE_INFINITY) {
    return { min: sim.initial.layer2YPos, max: sim.initial.layer2YPos }
  }
  return { min: yMin, max: yMax }
}

/** Per-column raw experienced viewport-offset range. */
export interface ColumnDyRange {
  /** Smallest `(Layer1YPos − Layer2YPos)` delta this column experienced
   *  while inside the camera viewport during the simulator walk. */
  min: number
  /** Largest delta. `min === max === 0` is the sentinel meaning the
   *  camera never reached this column. */
  max: number
}

/** A single camera-viewport snapshot at one frame. */
export interface ViewportSample {
  /** Frame index. */
  f: number
  /** Layer1XPos at this frame (camera left edge in L1 plane). */
  l1x: number
  /** Layer1YPos at this frame (camera top edge in L1 plane). */
  l1y: number
  /** Layer2XPos at this frame (= L1X for cmd-$01-locked levels). */
  l2x: number
  /** Layer2YPos at this frame (camera top in L2 plane). */
  l2y: number
}

/**
 * Walk the simulator forward and emit a viewport-trajectory sample
 * every `step` frames until the camera reaches the level's end. Used
 * by the editor's "Scroll path" overlay to draw the L1 / L2 camera
 * traces on the map view.
 *
 * Default step (1) yields one sample per frame. Drawing 8000+ points
 * is fine for a polyline; for periodic rectangle overlays the caller
 * can subsample further.
 */
export function sampleViewportPath(
  sim: ScrollSimulator,
  levelPixelW: number,
  step = 1,
): ViewportSample[] {
  const out: ViewportSample[] = []
  let lastCamX = -1
  let stagnantFrames = 0
  for (let f = 0; f < RANGE_WALK_FRAMES; f += step) {
    const s = sim.stateAtFrame(f)
    out.push({ f, l1x: s.layer1XPos, l1y: s.layer1YPos, l2x: s.layer2XPos, l2y: s.layer2YPos })
    const camX = s.layer1XPos
    if (camX + VIEWPORT_PX_W >= levelPixelW) break
    if (camX === lastCamX) {
      stagnantFrames++
      if (stagnantFrames > 60) break
    } else {
      stagnantFrames = 0
      lastCamX = camX
    }
  }
  return out
}

/**
 * Walk the simulator forward and, for each frame, record the current
 * `(Layer1YPos − Layer2YPos)` delta for every level-X column inside
 * the camera's 256-px horizontal viewport. Returns the raw per-column
 * `(min, max)` pair for each column's visibility window.
 *
 * `L2Factory.buildTileDyRanges` consumes these raw ranges and groups
 * tiles by 2D connected component (BFS flood-fill), so each
 * contiguous region of adjacent L2 tiles shares a single `(min, max)`
 * derived from the union of its constituent columns' raw ranges.
 * `MapEditorProvider` also calls this directly (no grid available
 * there) and uses the result purely as a truthy slider-mode sentinel.
 */
export function computeColumnDyRanges(
  sim: ScrollSimulator,
  levelPixelW: number,
): (ColumnDyRange | null)[] {
  const cols = Math.max(1, Math.ceil(levelPixelW / 16))
  const rawMin = new Array<number>(cols).fill(Number.POSITIVE_INFINITY)
  const rawMax = new Array<number>(cols).fill(Number.NEGATIVE_INFINITY)
  let lastCamX = -1
  let stagnantFrames = 0
  for (let f = 0; f < RANGE_WALK_FRAMES; f++) {
    const s = sim.stateAtFrame(f)
    const camX = s.layer1XPos
    // Signed (L1Y − L2Y) delta. Both are 16-bit unsigned; for vanilla
    // SMW the values fit in 0..255 and the delta lands in
    // -32768..32767 once we re-interpret as signed.
    let dy = (s.layer1YPos - s.layer2YPos) | 0
    dy = ((dy + 0x8000) & 0xFFFF) - 0x8000
    const colStart = Math.max(0, Math.floor(camX / 16))
    const colEnd   = Math.min(cols, Math.ceil((camX + VIEWPORT_PX_W) / 16))
    for (let c = colStart; c < colEnd; c++) {
      if (dy < rawMin[c]) rawMin[c] = dy
      if (dy > rawMax[c]) rawMax[c] = dy
    }
    if (camX + VIEWPORT_PX_W >= levelPixelW) break
    if (camX === lastCamX) {
      stagnantFrames++
      if (stagnantFrames > 60) break
    } else {
      stagnantFrames = 0
      lastCamX = camX
    }
  }
  return Array.from({ length: cols }, (_, c) =>
    rawMin[c] === Number.POSITIVE_INFINITY
      ? null
      : { min: rawMin[c], max: rawMax[c] },
  )
}
