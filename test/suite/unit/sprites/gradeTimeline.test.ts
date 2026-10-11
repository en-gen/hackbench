import { describe, expect, it } from 'vitest'
import { gradedPass, MAX_GRADED_PASS, writeMarioStart } from '../../support/gradeTimeline'

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
