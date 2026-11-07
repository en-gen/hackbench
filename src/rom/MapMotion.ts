/**
 * MapMotion.ts -- what a map's own scroll routines do to Layer 1 and Layer 2, by running them.
 *
 * Loads the map with the ROM's own loader (`loadLevelState`), which also runs the sprite sweep that sets the
 * scroll commands, then steps the game's per-frame pair on the 65816 core: UpdateScreenPosition and
 * ProcScreenScrollCmds, in the order CODE_00A28A calls them (SMWDisX bank_00.asm:4498-4506). Nothing about a
 * path or a table is written here; the positions are what the ROM's code leaves in $1A-$20. See
 * docs/rom/map-layer2-motion.md.
 *
 * Idle: the routine gets nothing (kind 'own-motion', e.g. $009), and the same run is repeated with Mario moved
 * to prove the positions do not depend on him. When idle moves nothing, two runs state the inputs Mario would
 * supply (below): the camera alone, which must still move nothing, then the camera and Layer2Touched (kind
 * 'needs-mario', e.g. $1EF: the sink routine reads Layer2Touched and a camera X outside its rest window,
 * bank_05.asm:6034-6068). A map whose motion needs where Mario is, or that moves in no run, is refused.
 *
 * Evidence scope: vanilla, one machine, 2026-11-07; $009 matched a Mesen capture on 7,999 of 7,999 frames.
 * Plain TypeScript, no shell.
 */
import { callSubroutine, describe } from './cpu/call'
import { bytesAt } from './sprites/interp/Guards'
import { loadLevelState } from './sprites/interp/LevelLoader'
import { smwMachine } from './sprites/interp/Machine'
import type { RomFile } from './RomFile'

/** Layer1ScrollCmd / Layer2ScrollCmd (rammap.asm:1566-1567): either nonzero after the load means a routine. */
const SCROLL_CMDS = [0x143e, 0x143f]
const POS = { l1x: 0x1a, l1y: 0x1c, l2x: 0x1e, l2y: 0x20 } as const
const KEYS = Object.keys(POS) as (keyof typeof POS)[]
/** The inputs the forced runs state (rammap.asm): Layer2Touched, the NextLayer1/2XPos words, and Mario's X and Y. */
const TOUCHED = 0x140e
const NEXT_L1X = 0x1462
const NEXT_L2X = 0x1466
const MARIO_X = 0x94
const MARIO_Y = 0x96
/**
 * An input chosen here, not read from the ROM: one screen in, which is outside the rest windows of vanilla's sink
 * routine (its first window is the first 8 px). Mario stands 128 px into the screen.
 */
const FORCED_CAMERA_X = 256
const FORCED_MARIO_X = FORCED_CAMERA_X + 128

/** The per-frame pair's call sites inside CODE_00A28A (bank_00.asm:4505-4506). */
const SITES = { screen: 0x00a299, scroll: 0x00a29d } as const
const JSL = 0x22
const PHB = 0x8b
const CALL_STEPS = 200_000
/** Frames with no change after which a run is over, and the most frames a run may take (5.5 minutes). */
const SETTLE = 180
const FRAME_CAP = 20_000

export interface MotionFrames {
  l1x: number[]
  l1y: number[]
  l2x: number[]
  l2y: number[]
}

export type MotionResult =
  | {
      status: 'ok'
      kind: 'own-motion' | 'needs-mario'
      /** Plain words for the UI when the run needed stated inputs. */
      note?: string
      /** Frame 0 is the load state; Play restarts there. */
      frames: MotionFrames
      /** Layer 2's draw offset in rows at each frame: (L1Y - L2Y) now, less the same at frame 0. */
      shiftY: number[]
      /** True only for a run that moved the camera by itself. */
      cameraMoved: boolean
      end: 'settled' | 'cap'
    }
  | { status: 'none'; kind: 'no-routine' }
  | {
      status: 'refused'
      kind:
        | 'unrecognized-code'
        | 'loader'
        | 'interpreter'
        | 'no-motion'
        | 'sideways'
        | 'mario-dependent'
        | 'camera-follows-mario'
      reason: string
    }

/** A signed 16-bit difference. */
const diff16 = (a: number, b: number): number => ((a - b + 0x8000) & 0xffff) - 0x8000

/** The entries the ROM's own calls name, or the site whose instruction is not the one expected. */
export function motionEntries(rom: RomFile): { screen: number; scroll: number } | string {
  const out: Record<string, number> = {}
  for (const [name, at] of Object.entries(SITES)) {
    const b = bytesAt(rom, at, 4)
    if (!b || b[0] !== JSL) return `the per-frame scroll call at $${at.toString(16).toUpperCase()}`
    const entry = ((b[3]! & 0x7f) << 16) | (b[2]! << 8) | b[1]!
    // Both routines open with PHB; an entry that exists is not an entry that is reached, so the call
    // site above is the reached half and this is the destination's.
    if (bytesAt(rom, entry, 1)?.[0] !== PHB)
      return `the ${name} routine at $${entry.toString(16).toUpperCase()}`
    out[name] = entry
  }
  return { screen: out.screen!, scroll: out.scroll! }
}

/** Layer 2's draw offsets: how far its position against Layer 1 has moved from frame 0. */
export function relativeShift(f: MotionFrames): { y: number[]; x: number[]; xMoves: boolean } {
  const y0 = diff16(f.l1y[0]!, f.l2y[0]!)
  const x0 = diff16(f.l1x[0]!, f.l2x[0]!)
  const x = f.l1x.map((_, i) => diff16(diff16(f.l1x[i]!, f.l2x[i]!), x0))
  const y = f.l1y.map((_, i) => diff16(diff16(f.l1y[i]!, f.l2y[i]!), y0))
  return { y, x, xMoves: x.some(v => v !== 0) }
}

interface Pass {
  frames: MotionFrames
  end: 'settled' | 'cap'
  refused?: string
}

/** What a run is given: nothing, the camera placed, the camera placed and Layer2Touched, or Mario moved. */
type Force = 'none' | 'camera' | 'camera+touch' | 'mario'

/** Mario's offset in the dependence run: far from where the loader put him on both axes. */
const MARIO_MOVE = { x: 160, y: -48 }

function runPass(
  rom: RomFile,
  wram: Uint8Array,
  entries: { screen: number; scroll: number },
  force: Force,
  /** Run exactly this many frames, with no settle rule (the dependence run). */
  exact?: number,
): Pass {
  const { bus, cpu } = smwMachine(rom, wram)
  const w = bus.wram
  const word = (a: number) => w[a]! | (w[a + 1]! << 8)
  const put = (a: number, v: number) => {
    w[a] = v & 255
    w[a + 1] = v >> 8
  }
  const frames: MotionFrames = { l1x: [], l1y: [], l2x: [], l2y: [] }
  const record = () => KEYS.forEach(k => frames[k].push(word(POS[k])))
  record()
  const mario0 = { x: word(MARIO_X), y: word(MARIO_Y) }
  let lastChange = 0
  for (let f = 1; f <= (exact ?? FRAME_CAP); f++) {
    if (force === 'camera' || force === 'camera+touch') {
      if (force === 'camera+touch') w[TOUCHED] = 1
      put(NEXT_L1X, FORCED_CAMERA_X)
      put(NEXT_L2X, FORCED_CAMERA_X)
      put(MARIO_X, FORCED_MARIO_X)
    } else if (force === 'mario') {
      put(MARIO_X, mario0.x + MARIO_MOVE.x)
      put(MARIO_Y, mario0.y + MARIO_MOVE.y)
    }
    for (const entry of [entries.screen, entries.scroll]) {
      const why = describe(
        callSubroutine(cpu, entry, { kind: 'jsl', maxSteps: CALL_STEPS, regs: { db: 0 } }),
        CALL_STEPS,
      )
      if (why) return { frames, end: 'settled', refused: why }
    }
    record()
    if (exact !== undefined) continue
    if (KEYS.some(k => frames[k][f] !== frames[k][f - 1])) lastChange = f
    if (f - lastChange >= SETTLE) {
      for (const k of KEYS) frames[k].length = lastChange + 1
      return { frames, end: 'settled' }
    }
  }
  return { frames, end: exact === undefined ? 'cap' : 'settled' }
}

const moved = (f: MotionFrames): boolean => KEYS.some(k => f[k].some(v => v !== f[k][0]))

const NO_MOTION =
  'This map has a scroll routine, but it moves nothing on its own. It waits for something Play cannot supply (a switch, a trigger or a timer).'
const SIDEWAYS =
  'Layer 2 moves sideways against the screen on this map. Play shows only up and down motion.'
type Refused = Extract<MotionResult, { status: 'refused' }>
const refuse = (kind: Refused['kind'], reason: string): Refused => ({
  status: 'refused',
  kind,
  reason,
})

export const NEEDS_MARIO_NOTE = 'Shown as if Mario is standing on Layer 2.'

/** Runs the map's own scroll routines from its load state; see the file comment. */
export function runMapMotion(rom: RomFile, level: number): MotionResult {
  const load = loadLevelState(rom, level)
  if (!load.ok) return { status: 'refused', kind: 'loader', reason: load.reason }
  return motionFromWram(rom, load.wram)
}

/** Layer 2 against the camera moved at some frame: the only motion a forced run may claim. */
const relMoved = (f: MotionFrames): boolean => {
  const r = relativeShift(f)
  return r.xMoves || r.y.some(v => v !== 0)
}

const MARIO_DEPENDENT =
  'What this map moves depends on where Mario is, so Play cannot show it on its own.'
const CAMERA_FOLLOWS = 'The camera follows Mario here, and Play has no Mario to follow.'

const same = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

/** The same from a loaded map's WRAM (copied into each run's own machine, so the caller's array is not touched). */
export function motionFromWram(rom: RomFile, wram: Uint8Array): MotionResult {
  // No scroll command: nothing to play, whatever the ROM's scroll code looks like.
  if (SCROLL_CMDS.every(a => wram[a] === 0)) return { status: 'none', kind: 'no-routine' }
  const entries = motionEntries(rom)
  if (typeof entries === 'string')
    return refuse(
      'unrecognized-code',
      `This ROM's scroll code is not the vanilla shape (${entries}), so Play will not run it.`,
    )
  const run = (force: Force, n?: number) => runPass(rom, wram, entries, force, n)
  const failed = (p: Pass): Refused | null =>
    p.refused
      ? refuse('interpreter', `The game's scroll code could not be run: ${p.refused}`)
      : null
  let kind: 'own-motion' | 'needs-mario' = 'own-motion'
  let pass = run('none')
  if (failed(pass)) return failed(pass)!
  if (moved(pass.frames)) {
    // The same frames with Mario somewhere else. What Play draws is Layer 2 against the camera: if that
    // differs he drives the motion; if only the camera differs, the camera follows him.
    const other = run('mario', pass.frames.l1x.length - 1)
    if (failed(other)) return failed(other)!
    const [a, b] = [relativeShift(pass.frames), relativeShift(other.frames)]
    if (!same(a.y, b.y)) return refuse('mario-dependent', MARIO_DEPENDENT)
    // The offsets match: a camera that differs is the cause, even where it also moves Layer 2 sideways (parallax).
    const cameraSame =
      same(pass.frames.l1x, other.frames.l1x) && same(pass.frames.l1y, other.frames.l1y)
    if (!cameraSame) return refuse('camera-follows-mario', CAMERA_FOLLOWS)
    if (!same(a.x, b.x)) return refuse('mario-dependent', MARIO_DEPENDENT)
  } else {
    kind = 'needs-mario'
    // The camera alone must move nothing: a routine the placed camera moves depends on where Mario is.
    const camera = run('camera')
    if (failed(camera)) return failed(camera)!
    if (relMoved(camera.frames)) return refuse('mario-dependent', MARIO_DEPENDENT)
    pass = run('camera+touch')
    if (failed(pass)) return failed(pass)!
  }
  const shift = relativeShift(pass.frames)
  const still = kind === 'needs-mario' ? !relMoved(pass.frames) : !moved(pass.frames)
  if (still) return refuse('no-motion', NO_MOTION)
  if (shift.xMoves) return refuse('sideways', SIDEWAYS)
  const f = pass.frames
  return {
    status: 'ok',
    kind,
    ...(kind === 'needs-mario' && { note: NEEDS_MARIO_NOTE }),
    frames: f,
    shiftY: shift.y,
    cameraMoved:
      kind === 'own-motion' && (f.l1x.some(v => v !== f.l1x[0]) || f.l1y.some(v => v !== f.l1y[0])),
    end: pass.end,
  }
}
