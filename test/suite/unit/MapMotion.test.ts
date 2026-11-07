/**
 * MapMotion: the run over synthetic carts (CI has no ROM) and the vanilla corpus (skipped without it).
 * The synthetic scroll routines are the cart's own code; each verdict is proven to change when the cart does.
 */
import { describe, expect, it } from 'vitest'
import {
  motionEntries,
  motionFromWram,
  relativeShift,
  runMapMotion,
  type MotionResult,
} from '../../../src/rom/MapMotion'
import { buildScrollSimulator } from '../../../src/rom/scrollSim'
import { freshRom, hasRom, VANILLA } from '../support/corpus'
import {
  motionCart,
  motionWram,
  SCREEN,
  SCROLL,
  type MotionRoutine,
} from '../support/syntheticMotionRom'

const ok = (r: MotionResult) => {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}: ${JSON.stringify(r)}`)
  return r
}
const run = (routine: MotionRoutine, step?: number, wram = motionWram()) =>
  motionFromWram(motionCart({ routine, step }), wram)

describe('synthetic carts', () => {
  it('a routine that moves by itself is own-motion, and its table step sets the range', () => {
    const slow = ok(run('rise', 3))
    const fast = ok(run('rise', 11))
    expect(slow.kind).toBe('own-motion')
    expect(slow.cameraMoved).toBe(false)
    expect(slow.frames.l2y[0]).toBe(0)
    // The routine stops at $0100 in steps of the ROM word: the last frame differs with the step.
    expect(slow.frames.l2y.at(-1)).toBe(0x102)
    expect(fast.frames.l2y.at(-1)).toBe(0x108)
    expect(slow.frames.l2y.length).toBeGreaterThan(fast.frames.l2y.length)
    expect(slow.end).toBe('settled')
  })

  it('runs the screen routine before the scroll routine, as CODE_00A28A does', () => {
    const r = ok(run('rise', 3))
    // The screen routine copies the previous frame's Next words, so the rise shows one frame later.
    expect(r.frames.l2y.slice(0, 4)).toEqual([0, 0, 3, 6])
  })

  it('takes each routine from its own call site and masks the $80 mirror bank', () => {
    for (const mirror of [false, true])
      expect(motionEntries(motionCart({ routine: 'rise', mirror }))).toEqual({
        screen: SCREEN,
        scroll: SCROLL,
      })
    ok(motionFromWram(motionCart({ routine: 'rise', mirror: true }), motionWram()))
  })

  it('draw offsets are the change in (camera minus Layer 2), zero at frame 0', () => {
    const r = ok(run('rise', 3))
    expect(r.shiftY[0]).toBe(0)
    r.frames.l2y.forEach((y, i) => expect(r.shiftY[i]).toBe(r.frames.l1y[i]! - y))
    expect(r.shiftY.at(-1)).toBe(-0x102)
  })

  it('frame 0 is the base even when the load state has Layer 2 away from the camera', () => {
    const w = motionWram()
    w.set([0xc0, 0], 0x1c) // L1Y
    w.set([0x64, 0], 0x20) // L2Y
    w.set([0xc0, 0], 0x1464)
    w.set([0x64, 0], 0x1468)
    const r = ok(run('rise', 3, w))
    expect(r.shiftY[0]).toBe(0)
    expect(r.shiftY.at(-1)).toBe(0x64 - r.frames.l2y.at(-1)!)
  })

  it('a camera that moves with Layer 2 draws offset 0 at every frame', () => {
    const r = ok(run('follow', 3))
    expect(r.frames.l1y.at(-1)).toBe(0x102)
    expect(r.frames.l2y.at(-1)).toBe(0x102)
    expect(r.shiftY.every(v => v === 0)).toBe(true)
    expect(r.cameraMoved).toBe(true)
  })

  it('a camera that moves only sideways still shows the camera frame', () => {
    const r = ok(run('followx', 3))
    expect(r.frames.l1y.every(v => v === 0)).toBe(true)
    expect(r.frames.l1x.at(-1)).toBe(0x102)
    expect(r.cameraMoved).toBe(true)
    expect(r.shiftY.every(v => v === 0)).toBe(true)
  })

  it('relativeShift: sampled where the camera has moved, off a nonzero base, and across the 16-bit wrap', () => {
    const f = { l1x: [0, 0, 0], l1y: [192, 150, 80], l2x: [0, 0, 0], l2y: [192, 100, 210] }
    // Camera minus Layer 2: 0, 50, -130; frame 0 is the base.
    expect(relativeShift(f)).toEqual({ y: [0, 50, -130], x: [0, 0, 0], xMoves: false })
    const off = { l1x: [0, 0], l1y: [192, 192], l2x: [0, 0], l2y: [100, 90] }
    expect(relativeShift(off).y).toEqual([0, 10])
    // Positions near the wrap: 0 - 65535 is +1, 0 - 1 is -1, so the offset is -2.
    const wrap = { l1x: [0, 0], l1y: [0, 0], l2x: [0, 0], l2y: [65535, 1] }
    expect(relativeShift(wrap).y).toEqual([0, -2])
    expect(relativeShift({ ...f, l2x: [0, 0, 4] }).xMoves).toBe(true)
  })

  it('a routine that waits for Mario runs with the inputs stated and says so', () => {
    const r = ok(run('touch'))
    expect(r.kind).toBe('needs-mario')
    expect(r.note).toMatch(/Mario/)
    expect(r.cameraMoved).toBe(false)
    expect(r.frames.l2y.at(-1)).toBeGreaterThan(0)
  })

  it('states the camera and Mario X it forces: a routine that reads them runs', () => {
    const r = ok(run('camTouch'))
    expect(r.kind).toBe('needs-mario')
    expect(r.frames.l2y.at(-1)).toBe(0x102)
    // The camera is placed a screen in for the run, against Layer 2 at the same X.
    expect(r.frames.l1x.at(-1)).toBe(256)
    expect(r.frames.l2x.at(-1)).toBe(256)
  })

  it('a routine the placed camera alone moves depends on where Mario is, and is refused', () => {
    const r = run('camOnly')
    expect(r).toMatchObject({ status: 'refused', kind: 'mario-dependent' })
    expect('frames' in r).toBe(false)
  })

  it('a routine whose motion follows Mario is refused even though it moves by itself', () => {
    expect(run('marioDrive')).toMatchObject({ status: 'refused', kind: 'mario-dependent' })
  })

  it('a dependence that shows only after the first frames is still found', () => {
    // The rise takes 256 frames at step 1; Mario's Y reaches Layer 1 only from frame 200.
    expect(run('lateMario', 1)).toMatchObject({ status: 'refused', kind: 'mario-dependent' })
  })

  it('Mario stays moved on every frame of the dependence run', () => {
    // The routine zeroes his Y each frame and reads it from frame 3: moved once, the difference would vanish.
    expect(run('marioHeld')).toMatchObject({ status: 'refused', kind: 'mario-dependent' })
  })

  it('a camera that follows Mario, with Layer 2 following the camera, is refused with its own reason', () => {
    const r = run('camFollow')
    expect(r).toMatchObject({ status: 'refused', kind: 'camera-follows-mario' })
    if (r.status === 'refused') expect(r.reason).toMatch(/camera follows Mario/)
  })

  it('code that faults only in the Mario run, or only in the camera run, is an interpreter refusal', () => {
    expect(run('brkIfMario')).toMatchObject({ status: 'refused', kind: 'interpreter' })
    expect(run('brkIfCam')).toMatchObject({ status: 'refused', kind: 'interpreter' })
    // Faulting in the camera run alone must not be lost to the run after it, which goes on to say no-motion.
    expect(run('brkCamOnly')).toMatchObject({ status: 'refused', kind: 'interpreter' })
  })

  it('a start later than 60 frames is still found', () => {
    const r = ok(run('late'))
    expect(r.kind).toBe('own-motion')
    expect(r.frames.l2y.at(-1)).toBe(0x102)
    expect(r.frames.l2y.indexOf(3)).toBeGreaterThan(140)
  })

  it('each run starts from the load state: a counter one run left behind is not the next one', () => {
    const r = ok(run('counterTouch'))
    expect(r.kind).toBe('needs-mario')
    // The forced run's own counter reaches 100 at frame 100; an earlier run's count would start it at once.
    expect(r.frames.l2y[50]).toBe(0)
    expect(r.frames.l2y[110]).toBeGreaterThan(0)
  })

  it('a routine that moves nothing even with the inputs is refused, with no frames', () => {
    const r = run('idle')
    expect(r).toMatchObject({ status: 'refused', kind: 'no-motion' })
    expect('frames' in r).toBe(false)
  })

  it('a map with no scroll command reports no routine, before any entry is checked', () => {
    const none = new Uint8Array(0x20000)
    expect(motionFromWram(motionCart({ routine: 'rise' }), none)).toEqual({
      status: 'none',
      kind: 'no-routine',
    })
    // An unrecognized hack puts no button on a map that has no routine.
    expect(motionFromWram(motionCart({ routine: 'rise', badSite: true }), none)).toEqual({
      status: 'none',
      kind: 'no-routine',
    })
  })

  it('code the interpreter refuses moves nothing and says why', () => {
    const r = run('brk')
    expect(r).toMatchObject({ status: 'refused', kind: 'interpreter' })
    expect('frames' in r).toBe(false)
  })

  it('Layer 2 moving sideways is refused in plain words', () => {
    expect(run('sideways')).toMatchObject({ status: 'refused', kind: 'sideways' })
  })

  it('a call site or destination that is not the expected shape is refused before any run', () => {
    expect(typeof motionEntries(motionCart({ routine: 'rise', badSite: true }))).toBe('string')
    expect(typeof motionEntries(motionCart({ routine: 'rise', badCallee: true }))).toBe('string')
    const r = motionFromWram(motionCart({ routine: 'rise', badSite: true }), motionWram())
    expect(r).toMatchObject({ status: 'refused', kind: 'unrecognized-code' })
    expect(typeof motionEntries(motionCart({ routine: 'rise' }))).toBe('object')
  })

  it('the caller keeps its WRAM', () => {
    const w = motionWram()
    motionFromWram(motionCart({ routine: 'rise' }), w)
    expect(w[0x1468]).toBe(0)
  })
})

/** The refusals a vanilla slot may end in: never the loader, the entries or the interpreter. */
const KEPT_REFUSALS = ['no-motion', 'sideways', 'mario-dependent', 'camera-follows-mario']

/** Every vanilla slot with a scroll command, and what the run says for it (the sweep, one machine, 2026-11-07). */
const PINNED: Record<number, string> = {
  0x009: 'ok:own-motion',
  0x1e2: 'ok:needs-mario',
  0x1ec: 'ok:needs-mario',
  0x1ef: 'ok:needs-mario',
  ...Object.fromEntries(
    [0x00c, 0x01f, 0x0c8, 0x0e7, 0x1c8, 0x1d4, 0x1fc].map(n => [n, 'refused:sideways']),
  ),
  ...Object.fromEntries([0x01a, 0x111, 0x122, 0x1d1].map(n => [n, 'refused:mario-dependent'])),
  ...Object.fromEntries(
    [0x0d4, 0x0dc, 0x115, 0x1ce, 0x1cf, 0x1e3, 0x1f3].map(n => [n, 'refused:camera-follows-mario']),
  ),
}

describe.skipIf(!hasRom(VANILLA))('vanilla corpus', () => {
  const rom = () => freshRom(VANILLA)

  it('$009 moves Layer 2 and the camera by itself, with Layer 2 as the camera X', () => {
    const r = ok(runMapMotion(rom(), 0x009))
    expect(r.kind).toBe('own-motion')
    expect(r.cameraMoved).toBe(true)
    expect(r.shiftY[0]).toBe(0)
    expect(r.frames.l1x.every((x, i) => x === r.frames.l2x[i])).toBe(true)
    expect(r.frames.l2y.length).toBeGreaterThan(1000)
    expect(r.end).toBe('settled')
  })

  it('$009 agrees with the hand port in scrollSim.ts on every frame', () => {
    const r = ok(runMapMotion(rom(), 0x009))
    // The port is seeded with $009's load state and sprite setup, as its own capture test does; no capture is read.
    const sim = buildScrollSimulator(rom(), {
      layer1XPos: 0,
      layer1YPos: 0xc0,
      layer2XPos: 0,
      layer2YPos: 0xc0,
      layer1ScrollCmd: 1,
      layer2ScrollCmd: 1,
      layer1ScrollBits: 1,
      layer2ScrollBits: 0,
      horizLayer2Setting: 0,
      vertLayer2Setting: 0,
      marioSpawnX: 16,
      marioSpawnY: 224,
      screenMode: 0,
    })
    const bad: string[] = []
    r.frames.l1x.forEach((_, f) => {
      const st = sim.stateAtFrame(f)
      const want = [st.layer1XPos, st.layer1YPos, st.layer2XPos, st.layer2YPos]
      const got = [r.frames.l1x[f], r.frames.l1y[f], r.frames.l2x[f], r.frames.l2y[f]]
      if (want.some((v, i) => v !== got[i])) bad.push(`${f}: ${got} vs ${want}`)
    })
    expect(bad.slice(0, 3)).toEqual([])
    expect(r.frames.l1x.length).toBeGreaterThan(7000)
  })

  it('$1EF needs Mario, sinks to the floor, and the camera frame is not shown', () => {
    const r = ok(runMapMotion(rom(), 0x1ef))
    expect(r.kind).toBe('needs-mario')
    expect(r.cameraMoved).toBe(false)
    // The whole sink: from the load height to the floor, and nothing after it.
    expect(r.frames.l2y.at(-1)).toBe(0)
    expect(r.shiftY.at(-1)).toBe(r.frames.l2y[0])
    expect(r.frames.l2y.length).toBeGreaterThan(400)
    expect(r.end).toBe('settled')
  })

  it('Layer 2 Smash maps and the Mario-driven $122 depend on where Mario is', () => {
    for (const level of [0x01a, 0x111, 0x122])
      expect(runMapMotion(rom(), level), level.toString(16)).toMatchObject({
        status: 'refused',
        kind: 'mario-dependent',
      })
  })

  it('a map with no scroll command reports none', () => {
    expect(runMapMotion(rom(), 0x105)).toEqual({ status: 'none', kind: 'no-routine' })
  })

  it('every slot runs: none is refused by the loader, the entries or the interpreter', () => {
    const r = rom()
    const seen = new Map<string, number>()
    const wrong: string[] = []
    for (let level = 0; level < 0x200; level++) {
      const m = runMapMotion(r, level)
      const key = m.status === 'refused' ? `refused:${m.kind}` : `${m.status}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
      const got = m.status === 'ok' ? `ok:${m.kind}` : m.status === 'none' ? 'none' : key
      if (got !== (PINNED[level] ?? 'none')) wrong.push(`${level.toString(16)}: ${got}`)
      if (m.status === 'refused')
        expect(KEPT_REFUSALS, `slot ${level.toString(16)}: ${m.reason}`).toContain(m.kind)
    }
    expect(wrong).toEqual([])
    expect(Object.fromEntries(seen)).toEqual({
      none: 490,
      ok: 4,
      'refused:sideways': 7,
      'refused:mario-dependent': 4,
      'refused:camera-follows-mario': 7,
    })
  }, 600_000)
})
