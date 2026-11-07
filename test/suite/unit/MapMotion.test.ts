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
import { freshRom, hasRom, VANILLA } from '../support/corpus'
import { motionCart, motionWram } from '../support/syntheticMotionRom'

const ok = (r: MotionResult) => {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`)
  return r
}

describe('synthetic carts', () => {
  it('a routine that moves by itself is own-motion, and its table step sets the range', () => {
    const slow = ok(motionFromWram(motionCart({ routine: 'rise', step: 3 }), motionWram()))
    const fast = ok(motionFromWram(motionCart({ routine: 'rise', step: 11 }), motionWram()))
    expect(slow.kind).toBe('own-motion')
    expect(slow.cameraMoved).toBe(false)
    expect(slow.frames.l2y[0]).toBe(0)
    // The routine stops at $0100 in steps of the ROM word: the last frame differs with the step.
    expect(slow.frames.l2y.at(-1)).toBe(0x102)
    expect(fast.frames.l2y.at(-1)).toBe(0x108)
    expect(slow.frames.l2y.length).toBeGreaterThan(fast.frames.l2y.length)
    expect(slow.end).toBe('settled')
  })

  it('draw offsets are the change in (camera minus Layer 2), zero at frame 0', () => {
    const r = ok(motionFromWram(motionCart({ routine: 'rise', step: 3 }), motionWram()))
    expect(r.shiftY[0]).toBe(0)
    r.frames.l2y.forEach((y, i) => expect(r.shiftY[i]).toBe(r.frames.l1y[i]! - y))
    expect(r.shiftY.at(-1)).toBe(-0x102)
  })

  it('a camera that moves with Layer 2 draws offset 0 at every frame', () => {
    const r = ok(motionFromWram(motionCart({ routine: 'follow', step: 3 }), motionWram()))
    expect(r.frames.l1y.at(-1)).toBe(0x102)
    expect(r.frames.l2y.at(-1)).toBe(0x102)
    expect(r.shiftY.every(v => v === 0)).toBe(true)
    expect(r.cameraMoved).toBe(true)
  })

  it('relativeShift sampled where the camera has moved', () => {
    const f = { l1x: [0, 0, 0], l1y: [192, 150, 80], l2x: [0, 0, 0], l2y: [192, 100, 210] }
    // Camera minus Layer 2: 0, 50, -130; frame 0 is the base.
    expect(relativeShift(f)).toEqual({ y: [0, 50, -130], xMoves: false })
  })

  it('a routine that waits for Mario runs with the inputs stated and says so', () => {
    const r = ok(motionFromWram(motionCart({ routine: 'touch' }), motionWram()))
    expect(r.kind).toBe('needs-mario')
    expect(r.note).toMatch(/Mario/)
    expect(r.cameraMoved).toBe(false)
    expect(r.frames.l2y.at(-1)).toBeGreaterThan(0)
  })

  it('a routine that moves nothing even with the inputs is refused, with no frames', () => {
    const r = motionFromWram(motionCart({ routine: 'idle' }), motionWram())
    expect(r).toMatchObject({ status: 'refused', kind: 'no-motion' })
    expect('frames' in r).toBe(false)
  })

  it('a map with no scroll command reports no routine', () => {
    const r = motionFromWram(motionCart({ routine: 'rise' }), new Uint8Array(0x20000))
    expect(r).toEqual({ status: 'none', kind: 'no-routine' })
  })

  it('code the interpreter refuses moves nothing and says why', () => {
    const r = motionFromWram(motionCart({ routine: 'brk' }), motionWram())
    expect(r).toMatchObject({ status: 'refused', kind: 'interpreter' })
    expect('frames' in r).toBe(false)
  })

  it('Layer 2 moving sideways is refused in plain words', () => {
    const r = motionFromWram(motionCart({ routine: 'sideways' }), motionWram())
    expect(r).toMatchObject({ status: 'refused', kind: 'sideways' })
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

  it('$1EF needs Mario, and the camera frame is not shown', () => {
    const r = ok(runMapMotion(rom(), 0x1ef))
    expect(r.kind).toBe('needs-mario')
    expect(r.cameraMoved).toBe(false)
    expect(r.shiftY.at(-1)).toBeGreaterThan(0)
  })

  it('a map with no scroll command reports none', () => {
    expect(runMapMotion(rom(), 0x105)).toEqual({ status: 'none', kind: 'no-routine' })
  })

  it('every slot runs: none is refused by the loader, the entries or the interpreter', () => {
    const r = rom()
    const seen = new Map<string, number>()
    for (let level = 0; level < 0x200; level++) {
      const m = runMapMotion(r, level)
      const key = m.status === 'refused' ? `refused:${m.kind}` : m.status
      seen.set(key, (seen.get(key) ?? 0) + 1)
      if (m.status === 'refused')
        expect(['no-motion', 'sideways'], `slot ${level.toString(16)}: ${m.reason}`).toContain(
          m.kind,
        )
    }
    expect(seen.get('ok')).toBeGreaterThan(5)
  }, 600_000)
})
