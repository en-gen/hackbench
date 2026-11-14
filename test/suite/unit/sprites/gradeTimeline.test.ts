import { describe, expect, it } from 'vitest'
import {
  gradedPass,
  isTimed,
  mapStartPass,
  MAX_GRADED_PASS,
  requireGateFrame,
  settleGradedPass,
  timelineFor,
  writeMarioStart,
} from '../../support/gradeTimeline'
import { grade, type RecordedPiece } from '../../support/spriteGrade'
import type { SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'

describe('gradedPass (no ROM)', () => {
  it('counts passes from the anchor when the anchor is after INIT', () => {
    expect(gradedPass(943, 987, 1052, 1)).toBe(65)
    expect(gradedPass(946, 998, 1062, 1)).toBe(64)
  })

  it('counts from the frame after INIT when the anchor came first', () => {
    expect(gradedPass(552, 492, 556, 1)).toBe(3)
  })

  it('sweeps the anchor across the INIT frame', () => {
    // The base is max(anchor, init + 1): anchor at init-1, init and init+1 all start at init+1.
    for (const anchor of [99, 100, 101]) expect(gradedPass(100, anchor, 110, 1)).toBe(9)
    expect(gradedPass(100, 102, 110, 1)).toBe(8)
    expect(gradedPass(100, 110, 110, 1)).toBe(0)
  })

  it('falls back (undefined) on missing fields and out-of-range k', () => {
    expect(gradedPass(undefined, 987, 1052, 1)).toBeUndefined()
    expect(gradedPass(943, undefined, 1052, 1)).toBeUndefined()
    expect(gradedPass(943, 987, undefined, 1)).toBeUndefined()
    expect(gradedPass(943, 987, 986, 1)).toBeUndefined() // drawn before MAIN could run
    expect(gradedPass(5, 5, 6 + MAX_GRADED_PASS, 1)).toBe(MAX_GRADED_PASS)
    expect(gradedPass(5, 5, 7 + MAX_GRADED_PASS, 1)).toBeUndefined()
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
    const t = timelineFor(rec, 90, { x: 0x1234, y: 0x56 }, 1)
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
    const t = timelineFor({ ...rec, drawnFrame: 400, trueFrame: 3 }, 90, { x: 0, y: 0 }, 1)
    expect(t.k).toBeUndefined() // 400 - 101 = 299 > MAX_GRADED_PASS
    const u = timelineFor({ ...rec, drawnFrame: 301, trueFrame: 3 }, 90, { x: 0, y: 0 }, 1)
    expect(u.k).toBe(200)
    expect(u.mainPasses).toBe(201)
    expect(u.seedExtra.trueFrame).toBe((3 - 1 - 200) & 0xff)
  })

  it('falls back to the old grade with no seed, probe or extra passes', () => {
    for (const t of [
      timelineFor({ ...rec, drawnFrame: undefined }, 90, { x: 1, y: 1 }, 1),
      timelineFor(rec, undefined, { x: 1, y: 1 }, 1),
      timelineFor(rec, 90, undefined, 1), // k is fine, marioStart missing
    ]) {
      expect(t.timed).toBe(false)
      expect(t.mainPasses).toBe(64)
      expect(t.seedExtra).toEqual({})
      expect(t.probe).toBeUndefined()
    }
  })
})

/**
 * #875: a map-start sprite (INIT in GM12, `initFrame <= gateFrame`) is counted from `gateFrame`, the last GM13
 * frame; the frames before it are not passes. Scope: maps without an entrance reload (docs/testing.md,
 * "Map-start sprites in the sprite grader"). Frame numbers are map 0C3 $49 (init 444, gate 488, anchor 518,
 * drawn 519), map 130 $76 (init 447, gate 503, anchor 518, drawn 552) and map 0D0 $6F list index 29
 * (init 451, gate 495, anchor 526, drawn 557), the rows #875 and #1369 name. Expected passes are literals.
 */
describe('gradedPass with the gate frame (no ROM)', () => {
  it.each([
    ['0C3 $49', 444, 518, 519, 488, 31, 1],
    ['130 $76', 447, 518, 552, 503, 49, 34],
    ['0D0 $6F idx 29', 451, 526, 557, 495, 62, 31],
  ])(
    '%s: pass drawn - gate (literal), not drawn - anchor',
    (_n, init, anchor, drawn, gate, want, anchorRule) => {
      expect(gradedPass(init, anchor, drawn, gate)).toBe(want)
      expect(mapStartPass(init, gate, drawn)).toBe(want)
      expect(gradedPass(init, anchor, drawn, 1)).toBe(anchorRule) // gate 1: INIT is after it, so the anchor rule
    },
  )

  it('a map-start sprite drawn at or before the gate is pass 0, never out of range', () => {
    expect(gradedPass(447, 518, 473, 503)).toBe(0) // the capture's incomplete first draw at 473, gate 503
    expect(gradedPass(447, 518, 502, 503)).toBe(0)
    expect(gradedPass(447, 518, 503, 503)).toBe(0)
    expect(gradedPass(447, 518, 504, 503)).toBe(1)
  })

  it('where the anchor is the gate the anchor rule gives the same pass', () => {
    expect(gradedPass(447, 492, 544, 492)).toBe(52) // map 127 $16: 52 both ways
    expect(gradedPass(447, 492, 544, 1)).toBe(52)
  })

  // The boundary, from the trace and not the data (no capture has an INIT within 3 frames of its gate): the
  // loader's INIT is in GM12 (SMWDisX bank_05.asm:72) and GM13 runs no sprite code (bank_00.asm:4075-4103), so
  // no INIT is stamped between GM12 and the gate frame G, the last GM13 frame: INIT at or before G is GM12's.
  // From G + 1 on a sprite is spawned by GM14, its first MAIN the frame after INIT, and the anchor rule applies.
  // Latent, no corpus record reaches it: with IRQNMICommand negative only the loader's call is skipped
  // (bank_02.asm:5171), GM12 still reaches CODE_009860 (bank_00.asm:2826), so such a sprite would INIT there, have
  // its first MAIN at G + 1 and be graded one pass late.
  describe('spawn sweep around the gate (gate 500, anchor 530, drawn 560)', () => {
    const [gate, anchor, drawn] = [500, 530, 560]
    it('INIT at gate - 1 is map start: pass 60', () => {
      expect(mapStartPass(gate - 1, gate, drawn)).toBe(60)
      expect(gradedPass(gate - 1, anchor, drawn, gate)).toBe(60)
    })
    it('INIT at the gate frame is map start too: pass 60', () => {
      expect(mapStartPass(gate, gate, drawn)).toBe(60)
      expect(gradedPass(gate, anchor, drawn, gate)).toBe(60)
    })
    it('INIT at gate + 1 is spawned in play: the anchor rule, 30', () => {
      expect(mapStartPass(gate + 1, gate, drawn)).toBeUndefined()
      expect(gradedPass(gate + 1, anchor, drawn, gate)).toBe(30)
    })
    it('INIT well before the gate (GM12) is map start: pass 60', () => {
      expect(mapStartPass(gate - 56, gate, drawn)).toBe(60)
    })
    it('a sprite spawned in play keeps the anchor rule, INIT + 1 deciding the start', () => {
      expect(mapStartPass(570, 488, 576)).toBeUndefined()
      expect(gradedPass(570, 518, 576, 488)).toBe(5)
      expect(gradedPass(942, 992, 993, 500)).toBe(1) // spawned during a long hold: the anchor still starts it
    })
  })

  it('an out-of-range map-start k falls back', () => {
    expect(gradedPass(0, 500, 488 + MAX_GRADED_PASS + 1, 488)).toBeUndefined()
    expect(gradedPass(0, 500, 488 + MAX_GRADED_PASS, 488)).toBe(MAX_GRADED_PASS)
  })

  it('timelineFor seeds the counters for the gate-based pass', () => {
    const t = timelineFor(
      { initFrame: 444, drawnFrame: 519, trueFrame: 200, effFrame: 47 },
      518,
      { x: 24, y: 306 },
      488,
    )
    expect(t.k).toBe(31)
    expect(t.mainPasses).toBe(64)
    expect(t.seedExtra).toEqual({
      trueFrame: (200 - 1 - 31) & 0xff,
      effFrame: (47 - 1 - 31) & 0xff,
    })
  })
})

describe('requireGateFrame refuses a capture with no usable gate (no ROM)', () => {
  it('returns a positive integer gate', () => {
    expect(requireGateFrame('0c3', 488)).toBe(488)
  })
  it.each([[undefined], [null], [0], [-5], [4.5], ['488'], [NaN]])(
    'refuses %s, naming the map',
    bad => {
      expect(() => requireGateFrame('0c3', bad)).toThrow(
        /^map 0c3: capture_summary\.json has no usable gateFrame/,
      )
    },
  )
})

describe('the graded-pass counters (no ROM)', () => {
  const part = {}
  const model = (parts: number[]) => ({
    chosen: undefined as number | undefined,
    passes: parts.map(n => ({ parts: Array.from({ length: n }, () => part) })),
  })

  it('a timed record whose graded pass drew nothing is a miss at k and grades at k', () => {
    const tally = { fallbacks: 0, missAtK: 0 }
    const m = model([0, 0, 0, 1])
    settleGradedPass(m, 1, true, tally)
    expect(tally).toEqual({ fallbacks: 0, missAtK: 1 })
    expect(m.chosen).toBe(1)
  })

  it('a timed record whose graded pass drew is graded there and is no miss', () => {
    const tally = { fallbacks: 0, missAtK: 0 }
    const m = model([0, 0, 0, 1])
    settleGradedPass(m, 3, true, tally)
    expect(tally).toEqual({ fallbacks: 0, missAtK: 0 })
    expect(m.chosen).toBe(3)
  })

  it('a graded pass past the passes run changes nothing', () => {
    const tally = { fallbacks: 0, missAtK: 0 }
    const m = model([1])
    settleGradedPass(m, 9, true, tally)
    expect(tally).toEqual({ fallbacks: 0, missAtK: 0 })
    expect(m.chosen).toBeUndefined()
  })

  it('an untimed record is a fallback, counted, and keeps the first drawing pass', () => {
    const tally = { fallbacks: 0, missAtK: 0 }
    const m = { ...model([1]), chosen: 0 }
    settleGradedPass(m, undefined, false, tally)
    expect(tally).toEqual({ fallbacks: 1, missAtK: 0 })
    expect(m.chosen).toBe(0)
  })

  it('isTimed needs both a pass and a Mario start', () => {
    expect(isTimed(3, { x: 1, y: 2 })).toBe(true)
    expect(isTimed(0, { x: 0, y: 0 })).toBe(true)
    expect(isTimed(undefined, { x: 1, y: 2 })).toBe(false)
    expect(isTimed(3, undefined)).toBe(false)
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
    const old = timelineFor({ initFrame: 444, drawnFrame: 519 }, 518, { x: 0, y: 0 }, 1)
    expect(old.k).toBe(1)
    expect(grade({ ...model, chosen: old.k }, [[piece]]).verdict).toBe('wrong') // pass 1 has no parts
  })
})
