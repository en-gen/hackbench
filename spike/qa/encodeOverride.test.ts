// Contract test for encodeOverride(levelId), written from the spec in
// tools/mesen/headless_capture.lua (the "TRACED MECHANISM" comment block and
// the encodeOverride() reference implementation beneath it), NOT from T1's
// implementation in spike/t1/. T1 is building the real thing concurrently;
// this file must never import from spike/t1/.
//
// TO WIRE UP THE REAL IMPLEMENTATION: change the import below from
//   import { expectedEncode as encodeOverride } from './contract'
// to
//   import { encodeOverride } from '../t1/encodeOverride'
// That is the whole change. If T1's return shape is not
// { overrideByte, submapFlag } | null (e.g. a tuple, or a Lua-style
// [value, reason] pair), adapt it in this one import line, not in the tests
// below it.
//
// Until that swap happens, `encodeOverride` here IS the spec's own formula
// (expectedEncode from ./contract), so the exact-value sub-checks in the
// sweep below are trivially true against themselves. That is expected and
// harmless: the accept/reject-vs-reachable-set, output-range and round-trip
// checks do not depend on the forward formula at all, and
// encodeOverride.mutants.test.ts proves the exact-value check itself has
// teeth by planting bugs in independent copies of the formula.

import { describe, it, expect } from 'vitest'
import {
  expectedEncode as encodeOverride,
  buildReachableSet,
  decodeOverride,
  findViolations,
  fullRange,
} from './contract'

describe('full sweep: all 512 level slots (0x000-0x1FF)', () => {
  it('every slot either encodes correctly or is correctly rejected', () => {
    expect(findViolations(encodeOverride, fullRange())).toEqual([])
  })
})

describe('round-trip property over the reachable set', () => {
  // The strongest oracle: checks against the ROM's own inverse decode
  // (bank_05.asm:7216-7227), not against a restatement of encodeOverride's
  // own formula.
  it('decode(encode(levelId)) === levelId for every accepted level', () => {
    const failures: string[] = []
    for (const levelId of fullRange()) {
      const result = encodeOverride(levelId)
      if (result === null) continue
      const decoded = decodeOverride(result.overrideByte, result.submapFlag)
      if (decoded !== levelId) failures.push(`0x${levelId.toString(16)} -> 0x${decoded.toString(16)}`)
    }
    expect(failures).toEqual([])
  })
})

describe('exact reachable-set membership', () => {
  it('accepts precisely [0x001,0x0DB] union [0x101,0x1DB], size 438', () => {
    const expected = buildReachableSet()
    const actual = new Set(fullRange().filter((levelId) => encodeOverride(levelId) !== null))
    expect(actual).toEqual(expected)
    expect(actual.size).toBe(2 * 0xdb)
  })
})

describe('boundary cases', () => {
  it('0x024 stays below the branch: overrideByte === lowByte', () => {
    expect(encodeOverride(0x024)).toEqual({ overrideByte: 0x24, submapFlag: 0 })
  })
  it('0x025 crosses the branch: overrideByte === lowByte + 0x24', () => {
    expect(encodeOverride(0x025)).toEqual({ overrideByte: 0x49, submapFlag: 0 })
  })
  it('0x0DB is the last reachable low byte: overrideByte === 0xFF exactly', () => {
    expect(encodeOverride(0x0db)).toEqual({ overrideByte: 0xff, submapFlag: 0 })
  })
  it('0x0DC is one past the cutoff: rejected', () => {
    expect(encodeOverride(0x0dc)).toBeNull()
  })
  it('0x000 is rejected: override=0 falls through to the overworld-cursor path (bank_05.asm:7167-7168)', () => {
    expect(encodeOverride(0x000)).toBeNull()
  })
  it('0x100 is rejected: the same zero-low-byte rule applies in the submap range', () => {
    expect(encodeOverride(0x100)).toBeNull()
  })
  it('0x1FF is inside the input range but still rejected: low byte 0xFF exceeds the cutoff', () => {
    expect(encodeOverride(0x1ff)).toBeNull()
  })
  it('0x200 is rejected: one past the documented input range', () => {
    expect(encodeOverride(0x200)).toBeNull()
  })
  it('0x124 in the submap range, below the branch: submapFlag === 1', () => {
    expect(encodeOverride(0x124)).toEqual({ overrideByte: 0x24, submapFlag: 1 })
  })
  it('0x125 in the submap range, crosses the branch: submapFlag === 1', () => {
    expect(encodeOverride(0x125)).toEqual({ overrideByte: 0x49, submapFlag: 1 })
  })
  it('0x1DB is the last reachable submap level: overrideByte === 0xFF exactly', () => {
    expect(encodeOverride(0x1db)).toEqual({ overrideByte: 0xff, submapFlag: 1 })
  })
  it('0x1DC is one past the cutoff in the submap range: rejected', () => {
    expect(encodeOverride(0x1dc)).toBeNull()
  })
})

describe('output range invariant', () => {
  it('overrideByte is always 0-255 for every accepted input, including the 0xDB edge', () => {
    // Why 0xDB, not 0xDC, is the cutoff: 0xDB + 0x24 lands exactly on 0xFF.
    expect(0xdb + 0x24).toBe(0xff)
    for (const levelId of fullRange()) {
      const result = encodeOverride(levelId)
      if (result === null) continue
      expect(result.overrideByte).toBeGreaterThanOrEqual(0)
      expect(result.overrideByte).toBeLessThanOrEqual(255)
    }
  })
})
