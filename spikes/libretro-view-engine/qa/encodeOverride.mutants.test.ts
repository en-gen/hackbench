// Proves encodeOverride.test.ts can actually fail. Each mutant below is a
// deliberately broken copy of the spec's own formula (never T1's code) and
// is checked with the exact same oracle (findViolations, from ./contract)
// that the real contract test uses. If a mutant produces zero violations,
// the suite cannot tell it apart from a correct implementation -- that is
// called out explicitly rather than hidden.

import { describe, it, expect } from 'vitest'
import { findViolations, fullRange, type EncodeFn } from './contract'

// One parameterized copy of the reference formula, so each mutant is a
// one-field diff from the spec instead of a hand-retyped function (which
// would risk introducing an unrelated second bug alongside the intended one).
function mkCandidate(opts: {
  plusAmount?: number
  branchLow?: number
  branchInclusive?: boolean
  cutoff?: number
  rejectZero?: boolean
  submapThreshold?: number
}): EncodeFn {
  const { plusAmount = 0x24, branchLow = 0x25, branchInclusive = false, cutoff = 0xdb, rejectZero = true, submapThreshold = 0x100 } = opts
  return (levelId) => {
    if (levelId < 0 || levelId > 0x1ff) return null
    const submapFlag = (levelId >= submapThreshold ? 1 : 0) as 0 | 1
    const lowByte = levelId % 0x100
    if (rejectZero && lowByte === 0) return null
    if (lowByte > cutoff) return null
    const belowBranch = branchInclusive ? lowByte <= branchLow : lowByte < branchLow
    const overrideByte = belowBranch ? lowByte : lowByte + plusAmount
    return { overrideByte, submapFlag }
  }
}

it('mutant: + 0x24 changed to + 0x25 is caught', () => {
  expect(findViolations(mkCandidate({ plusAmount: 0x25 }), fullRange())).not.toEqual([])
})

it('mutant: < 0x25 changed to <= 0x25 is caught', () => {
  expect(findViolations(mkCandidate({ branchInclusive: true }), fullRange())).not.toEqual([])
})

it('mutant: cutoff > 0xDB changed to > 0xDC is caught', () => {
  expect(findViolations(mkCandidate({ cutoff: 0xdc }), fullRange())).not.toEqual([])
})

it('mutant: lowByte === 0 rejection removed is caught', () => {
  expect(findViolations(mkCandidate({ rejectZero: false }), fullRange())).not.toEqual([])
})

describe('mutant: submapFlag from levelId >= 0xFF instead of >= 0x100', () => {
  // This is a genuine EQUIVALENT MUTANT, not a hole in the suite. The only
  // levelId where ">= 0xFF" and ">= 0x100" disagree is 0x0FF itself, and
  // 0x0FF's low byte (0xFF) is already rejected by the independent cutoff
  // guard (lowByte > 0xDB) before submapFlag is ever read back out. No input
  // in the documented 0x000-0x1FF domain can observe the difference, so no
  // black-box test over that domain -- this suite included -- can catch it.
  // Verified exhaustively (zero violations), not asserted as caught.
  it('produces zero observable difference across the whole domain', () => {
    expect(findViolations(mkCandidate({ submapThreshold: 0xff }), fullRange())).toEqual([])
  })

  // A sharper version of the same bug class IS observable: shifting the
  // threshold to 0x102 misclassifies level 0x101, whose low byte (0x01) is
  // valid and untouched by any other guard. This is the mutant that stands
  // in for "wrong submap threshold" in this suite.
  it('a sharper off-by-N version of the same bug is caught', () => {
    expect(findViolations(mkCandidate({ submapThreshold: 0x102 }), fullRange())).not.toEqual([])
  })
})

it('own mutant: branch threshold shifted down (< 0x25 -> < 0x24) is caught', () => {
  // Round-trip alone does NOT catch this one: shifting the branch down just
  // moves which override values get used and leaves a gap (0x24-0x47 never
  // produced), so decode still inverts whatever IS produced correctly. Only
  // the exact-value check in findViolations (comparing against the spec's
  // own formula, per contract.ts's expectedEncode) catches it. Confirms the
  // brief's item 4 (named boundary values) is load-bearing, not redundant
  // with item 2 (round-trip).
  const violations = findViolations(mkCandidate({ branchLow: 0x24 }), fullRange())
  expect(violations).not.toEqual([])
  expect(violations.some((line) => line.includes('0x024'))).toBe(true)
})

it('own mutant: missing the out-of-range guard is caught by the range-edge boundary', () => {
  const mutant: EncodeFn = (levelId) => {
    const submapFlag = (levelId >= 0x100 ? 1 : 0) as 0 | 1
    const lowByte = ((levelId % 0x100) + 0x100) % 0x100
    if (lowByte === 0) return null
    if (lowByte > 0xdb) return null
    const overrideByte = lowByte < 0x25 ? lowByte : lowByte + 0x24
    return { overrideByte, submapFlag }
  }
  // 0x201 has the same low byte as 0x001 but is out of range; a sweep
  // confined to 0x000-0x1FF alone cannot see this bug, so this test supplies
  // the extra point deliberately, the same way the boundary suite does.
  expect(findViolations(mutant, [...fullRange(), 0x201])).not.toEqual([])
})
