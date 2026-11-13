import { describe, expect, it } from 'vitest'
import {
  gradedPass,
  LEVEL_START_PASS_OFFSET as OFF,
  levelStartPass,
  MAX_GRADED_PASS,
  timelineFor,
  writeMarioStart,
} from '../../support/gradeTimeline'
import { grade, type RecordedPiece } from '../../support/spriteGrade'
import type { SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'

describe('gradedPass (no ROM)', () => {
  it('counts passes from the anchor when the anchor is after INIT', () => {
    expect(gradedPass(943, 987, 1052)).toBe(65)
    expect(gradedPass(946, 998, 1062)).toBe(64)
  })

  it('counts from the frame after INIT when the anchor came first', () => {
    expect(gradedPass(552, 492, 556)).toBe(3)
  })

  it('sweeps the anchor across the INIT frame', () => {
    // The base is max(anchor, init + 1): anchor at init-1, init and init+1 all start at init+1.
    for (const anchor of [99, 100, 101]) expect(gradedPass(100, anchor, 110)).toBe(9)
    expect(gradedPass(100, 102, 110)).toBe(8)
    expect(gradedPass(100, 110, 110)).toBe(0)
  })

  it('falls back (undefined) on missing fields and out-of-range k', () => {
    expect(gradedPass(undefined, 987, 1052)).toBeUndefined()
    expect(gradedPass(943, undefined, 1052)).toBeUndefined()
    expect(gradedPass(943, 987, undefined)).toBeUndefined()
    expect(gradedPass(943, 987, 986)).toBeUndefined() // drawn before MAIN could run
    expect(gradedPass(0, 0, 1 + MAX_GRADED_PASS)).toBe(MAX_GRADED_PASS)
    expect(gradedPass(0, 0, 2 + MAX_GRADED_PASS)).toBeUndefined()
  })

  it('writes marioStart to all four cells, both bytes each', () => {
    const w = new Uint8Array(0x100)
    writeMarioStart(w, { x: 0x1234, y: 0x0156 })
    expect([w[0x94], w[0x95], w[0xd1], w[0xd2]]).toEqual([0x34, 0x12, 0x34, 0x12])
    expect([w[0x96], w[0x97], w[0xd3], w[0xd4]]).toEqual([0x56, 0x01, 0x56, 0x01])
  })
})

describe('timelineFor (no ROM)', () => {
  const rec = { initFrame: 100, drawnFrame: 110, trueFrame: 50, effFrame: 60 }

  it('seeds pass k, the frame counters and Mario for a timed record', () => {
    const t = timelineFor(rec, 90, { x: 0x1234, y: 0x56 })
    expect(t.k).toBe(9) // 110 - max(90, 101)
    expect(t.timed).toBe(true)
    expect(t.mainPasses).toBe(64)
    expect(t.seedExtra).toEqual({ trueFrame: (50 - 1 - 9) & 0xff, effFrame: (60 - 1 - 9) & 0xff })
    const w = new Uint8Array(0x100)
    t.probe!(0, w) // only the pass -1 hook (after INIT) writes Mario
    expect(w[0x94]).toBe(0)
    t.probe!(-1, w)
    expect([w[0x94], w[0x95], w[0x96], w[0xd1], w[0xd3]]).toEqual([0x34, 0x12, 0x56, 0x34, 0x56])
  })

  it('runs enough passes to reach a late k and wraps the counters to a byte', () => {
    const t = timelineFor({ ...rec, drawnFrame: 400, trueFrame: 3 }, 90, { x: 0, y: 0 })
    expect(t.k).toBeUndefined() // 400 - 101 = 299 > MAX_GRADED_PASS
    const u = timelineFor({ ...rec, drawnFrame: 301, trueFrame: 3 }, 90, { x: 0, y: 0 })
    expect(u.k).toBe(200)
    expect(u.mainPasses).toBe(201)
    expect(u.seedExtra.trueFrame).toBe((3 - 1 - 200) & 0xff)
  })

  it('falls back to the old grade with no seed, probe or extra passes', () => {
    for (const t of [
      timelineFor({ ...rec, drawnFrame: undefined }, 90, { x: 1, y: 1 }),
      timelineFor(rec, undefined, { x: 1, y: 1 }),
      timelineFor(rec, 90, undefined), // k is fine, marioStart missing
    ]) {
      expect(t.timed).toBe(false)
      expect(t.mainPasses).toBe(64)
      expect(t.seedExtra).toEqual({})
      expect(t.probe).toBeUndefined()
    }
  })
})

/**
 * #875: a level-start sprite (INIT in GM12, `initFrame <= gateFrame`) is counted from `gateFrame`, the last GM13
 * frame; the frames before it are not passes. The offset is `LEVEL_START_PASS_OFFSET` (see gradeTimeline.ts)
 * and every expectation below is written against it. Frame numbers are map 0C3 $49
 * (init 444, gate 488, anchor 518, drawn 519), map 130 $76 (init 447, gate 503, anchor 518, drawn 552) and
 * map 0D0 $6F list index 29 (init 451, gate 495, anchor 526, drawn 557), the rows #875 and #1369 name.
 */
describe('gradedPass with the gate frame (no ROM)', () => {
  it.each([
    ['0C3 $49', 444, 518, 519, 488, 31],
    ['130 $76', 447, 518, 552, 503, 49],
    ['0D0 $6F idx 29', 451, 526, 557, 495, 62],
  ])('%s: pass drawn - gate, not drawn - anchor', (_n, init, anchor, drawn, gate, want) => {
    expect(gradedPass(init, anchor, drawn, gate)).toBe(want + OFF)
    expect(levelStartPass(init, gate, drawn)).toBe(want + OFF)
    expect(gradedPass(init, anchor, drawn)).toBe(drawn - anchor) // the anchor rule: 1, 34, 31
  })

  it('a level-start sprite drawn at or before the gate is pass 0 (+ offset), never out of range', () => {
    expect(gradedPass(447, 518, 473, 503)).toBe(0) // the capture's incomplete first draw at 473, gate 503
    expect(gradedPass(447, 518, 502, 503)).toBe(0)
    expect(gradedPass(447, 518, 503, 503)).toBe(OFF)
    expect(gradedPass(447, 518, 504, 503)).toBe(1 + OFF)
  })

  it('where the anchor is the gate both rules agree up to the offset', () => {
    expect(gradedPass(447, 492, 544, 492)).toBe(gradedPass(447, 492, 544) + OFF) // map 127 $16
  })

  // The boundary, from the trace and not the data (no capture has an INIT within 3 frames of its gate): the
  // loader's INIT is in GM12 (SMWDisX bank_05.asm:72) and GM13 runs no sprite code (bank_00.asm:4075-4103), so
  // no INIT is stamped between GM12 and the gate frame G, the last GM13 frame: INIT at or before G is GM12's.
  // From G + 1 on a sprite is spawned by GM14, its first MAIN the frame after INIT, and the anchor rule applies.
  describe('spawn sweep around the gate (gate 500, anchor 530, drawn 560)', () => {
    const [gate, anchor, drawn] = [500, 530, 560]
    it('INIT at gate - 1 is level start: pass drawn - gate', () => {
      expect(levelStartPass(gate - 1, gate, drawn)).toBe(60 + OFF)
      expect(gradedPass(gate - 1, anchor, drawn, gate)).toBe(60 + OFF)
    })
    it('INIT at the gate frame is level start too: pass drawn - gate', () => {
      expect(levelStartPass(gate, gate, drawn)).toBe(60 + OFF)
      expect(gradedPass(gate, anchor, drawn, gate)).toBe(60 + OFF)
    })
    it('INIT at gate + 1 is spawned in play: the anchor rule', () => {
      expect(levelStartPass(gate + 1, gate, drawn)).toBeUndefined()
      expect(gradedPass(gate + 1, anchor, drawn, gate)).toBe(drawn - anchor)
    })
    it('INIT well before the gate (GM12) is level start', () => {
      expect(levelStartPass(gate - 56, gate, drawn)).toBe(60 + OFF)
    })
    it('a sprite spawned in play after the anchor keeps the anchor rule, INIT + 1 deciding the start', () => {
      expect(levelStartPass(570, 488, 576)).toBeUndefined()
      expect(gradedPass(570, 518, 576, 488)).toBe(5)
      expect(gradedPass(942, 992, 993, 500)).toBe(1) // spawned during a long hold: the anchor still starts it
    })
  })

  it('without a gate frame the old rule stands', () => {
    expect(gradedPass(444, 518, 519, undefined)).toBe(1)
    expect(gradedPass(444, 518, 519)).toBe(1)
  })

  it('an out-of-range level-start k falls back', () => {
    expect(gradedPass(0, 500, 488 + MAX_GRADED_PASS - OFF + 1, 488)).toBeUndefined()
    expect(gradedPass(0, 500, 488 + MAX_GRADED_PASS - OFF, 488)).toBe(MAX_GRADED_PASS)
  })

  it('timelineFor seeds the counters for the gate-based pass', () => {
    const t = timelineFor(
      { initFrame: 444, drawnFrame: 519, trueFrame: 200, effFrame: 47 },
      518,
      { x: 24, y: 306 },
      488,
    )
    const k = 31 + OFF
    expect(t.k).toBe(k)
    expect(t.mainPasses).toBe(64)
    expect(t.seedExtra).toEqual({ trueFrame: (200 - 1 - k) & 0xff, effFrame: (47 - 1 - k) & 0xff })
  })
})

describe('a sprite whose first draw is pass N grades at the pass the capture recorded (no ROM)', () => {
  const N = 5 // GrowingPipeMain draws first on pass 5 (SMWDisX bank_02.asm:13846-13890)
  const piece: RecordedPiece = { dx: 0, dy: -1, tile: 0xa4, attr: 43, large: true }
  const part = { oam: 0, char: 0xa4, size: 16, palette: 13, priority: 0, flipX: false, flipY: false, dx: 0, dy: -1, attr: 43, ox: 0, oy: 0 } // prettier-ignore
  const at = { x: 208, y: 352 }
  const model = {
    chosen: N,
    steps: [],
    passes: Array.from({ length: 64 }, (_, p) => ({
      pass: p,
      pos: at,
      origin: at,
      parts: p >= N ? [part] : [],
    })),
  } as unknown as SpriteModel

  it('drawn 31 frames after the gate has drawn; the anchor rule graded pass 1, which has not', () => {
    const t = timelineFor({ initFrame: 444, drawnFrame: 519 }, 518, { x: 0, y: 0 }, 488)
    expect(grade({ ...model, chosen: t.k }, [[piece]]).verdict).toBe('exact')
    const old = timelineFor({ initFrame: 444, drawnFrame: 519 }, 518, { x: 0, y: 0 })
    expect(old.k).toBe(1)
    expect(grade({ ...model, chosen: old.k }, [[piece]]).verdict).toBe('wrong') // pass 1 has no parts
  })
})
