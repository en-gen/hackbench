/**
 * BallAndChainAppearance.test.ts: sprite $9E part layout coverage.
 *
 * Test tree:
 *   fromTables() - part count
 *     - 24 parts: 8 chain (2 × 16×16) + 16 sphere (4 × 16×16)
 *     - all parts use palette 9
 *   fromTables() - chain link 1 (bigTile $E8 at TL=(0,+16) no flip)
 *     - 4 parts: chars $5E8/$5E9/$5F8/$5F9, no flip, dx=0/8/0/8, dy=+16/+16/+24/+24
 *   fromTables() - chain link 2 (bigTile $E8 at TL=(0,+32) no flip)
 *     - same char pattern shifted to dy=+32..+40
 *   fromTables() - sphere Q0 no flip (bigTile $EA at TL=(−8,+48))
 *     - CORNER_OFF.none: chars $5EA/$5EB/$5FA/$5FB, positions (−8,+48),(0,+48),(−8,+56),(0,+56)
 *   fromTables() - sphere Q1 X-flip (bigTile $EA at TL=(+8,+48))
 *     - CORNER_OFF.flipX: chars $5EB/$5EA/$5FB/$5FA, flipX=true, dx=+8/+16/+8/+16
 *   fromTables() - sphere Q2 Y-flip (bigTile $EA at TL=(−8,+64))
 *     - CORNER_OFF.flipY: chars $5FA/$5FB/$5EA/$5EB, flipY=true, dy=+64/+64/+72/+72
 *   fromTables() - sphere Q3 XY-flip (bigTile $EA at TL=(+8,+64))
 *     - CORNER_OFF.both: chars $5FB/$5FA/$5EB/$5EA, both flips, dx=+8/+16, dy=+64/+72
 *   fromTables() - missing chars → placeholder for all parts
 *   hitRect - includes anchor tile (dy=0) and full sphere extent
 *     - dx=−8 (sphere Q0/Q2 leftmost), dy=0 (anchor tile), w=32, h=80
 */

import { describe, it, expect } from 'vitest'
import { BallAndChainAppearance } from '../../../../src/rom/model/sprites/appearances/BallAndChainAppearance'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OBJ_BASE = 0x400
const CHAR_HIGH = 0x100
const CHAIN_BASE = 0xe8 // CODE_02D750 chain tile
const SPHERE_BASE = 0xea // CODE_02D813 sphere tile (NOP=$EA trick)

function makeChar(idx: number): Char {
  return new Char(idx, new StaticPixelsBehavior(new Uint8Array(64)))
}

// All 8 distinct chars: chain $E8/$E9/$F8/$F9 + sphere $EA/$EB/$FA/$FB
function makeChars(): Map<number, Char> {
  const m = new Map<number, Char>()
  for (const off of [0x00, 0x01, 0x10, 0x11]) {
    const ck = OBJ_BASE + CHAR_HIGH + CHAIN_BASE + off
    const sk = OBJ_BASE + CHAR_HIGH + SPHERE_BASE + off
    m.set(ck, makeChar(ck))
    m.set(sk, makeChar(sk))
  }
  return m
}

const placeholder = makeChar(0)

// ── fromTables - part count and palette ──────────────────────────────────────

describe('BallAndChainAppearance.fromTables - part list', () => {
  it('produces 24 parts: 8 chain (2×16×16) + 16 sphere (4×16×16)', () => {
    const app = BallAndChainAppearance.fromTables(makeChars(), placeholder)
    expect(app.parts).toHaveLength(24)
  })

  it('all parts use palette 9 (OAM attr $33: OBJ pal 1 → CGRAM 8+1=9)', () => {
    const app = BallAndChainAppearance.fromTables(makeChars(), placeholder)
    for (const p of app.parts) {
      expect(p.palette).toBe(9)
    }
  })
})

// ── fromTables - chain link 1 (parts 0–3) ────────────────────────────────────

describe('BallAndChainAppearance.fromTables - chain link 1 bigTile', () => {
  // bigTile($E8, tlDx=0, tlDy=+16, no flip) → CORNER_OFF.none = [0x00,0x01,0x10,0x11]
  // CODE_02D750: tile $E8, 16×16; half-step = 16 px from pivot
  const CASES = [
    { i: 0, key: OBJ_BASE + CHAR_HIGH + 0xe8, flipX: false, flipY: false, dx: 0, dy: 16 },
    { i: 1, key: OBJ_BASE + CHAR_HIGH + 0xe9, flipX: false, flipY: false, dx: 8, dy: 16 },
    { i: 2, key: OBJ_BASE + CHAR_HIGH + 0xf8, flipX: false, flipY: false, dx: 0, dy: 24 },
    { i: 3, key: OBJ_BASE + CHAR_HIGH + 0xf9, flipX: false, flipY: false, dx: 8, dy: 24 },
  ] as const

  for (const c of CASES) {
    it(`part[${c.i}]: char=$${c.key.toString(16)}, no flip, dx=${c.dx}, dy=${c.dy}`, () => {
      const chars = makeChars()
      const app = BallAndChainAppearance.fromTables(chars, placeholder)
      const p = app.parts[c.i]!
      expect(p.char).toBe(chars.get(c.key))
      expect(p.flipX).toBe(c.flipX)
      expect(p.flipY).toBe(c.flipY)
      expect(p.dx).toBe(c.dx)
      expect(p.dy).toBe(c.dy)
    })
  }
})

// ── fromTables - chain link 2 (parts 4–7) ────────────────────────────────────

describe('BallAndChainAppearance.fromTables - chain link 2 bigTile', () => {
  // bigTile($E8, tlDx=0, tlDy=+32, no flip) - same char pattern, dy shifted +16
  // CODE_02D750 iteration 2 → full-step = 32 px from pivot
  const CASES = [
    { i: 4, key: OBJ_BASE + CHAR_HIGH + 0xe8, dx: 0, dy: 32 },
    { i: 5, key: OBJ_BASE + CHAR_HIGH + 0xe9, dx: 8, dy: 32 },
    { i: 6, key: OBJ_BASE + CHAR_HIGH + 0xf8, dx: 0, dy: 40 },
    { i: 7, key: OBJ_BASE + CHAR_HIGH + 0xf9, dx: 8, dy: 40 },
  ] as const

  for (const c of CASES) {
    it(`part[${c.i}]: char=$${c.key.toString(16)}, no flip, dx=${c.dx}, dy=${c.dy}`, () => {
      const chars = makeChars()
      const app = BallAndChainAppearance.fromTables(chars, placeholder)
      const p = app.parts[c.i]!
      expect(p.char).toBe(chars.get(c.key))
      expect(p.flipX).toBe(false)
      expect(p.flipY).toBe(false)
      expect(p.dx).toBe(c.dx)
      expect(p.dy).toBe(c.dy)
    })
  }
})

// ── fromTables - sphere Q0 no flip (parts 8–11) ──────────────────────────────

describe('BallAndChainAppearance.fromTables - sphere Q0 no flip', () => {
  // bigTile($EA, tlDx=−8, tlDy=+48, no flip) → CORNER_OFF.none → offsets $00/$01/$10/$11
  // DATA_02D80F[0]=$33; DATA_02D807[0]=$F8=−8, DATA_02D80B[0]=$F8=−8 from sphere centre (0,+56)
  const CASES = [
    { i: 8, key: OBJ_BASE + CHAR_HIGH + 0xea, flipX: false, flipY: false, dx: -8, dy: 48 },
    { i: 9, key: OBJ_BASE + CHAR_HIGH + 0xeb, flipX: false, flipY: false, dx: 0, dy: 48 },
    { i: 10, key: OBJ_BASE + CHAR_HIGH + 0xfa, flipX: false, flipY: false, dx: -8, dy: 56 },
    { i: 11, key: OBJ_BASE + CHAR_HIGH + 0xfb, flipX: false, flipY: false, dx: 0, dy: 56 },
  ] as const

  for (const c of CASES) {
    it(`part[${c.i}]: char=$${c.key.toString(16)}, no flip, dx=${c.dx}, dy=${c.dy}`, () => {
      const chars = makeChars()
      const app = BallAndChainAppearance.fromTables(chars, placeholder)
      const p = app.parts[c.i]!
      expect(p.char).toBe(chars.get(c.key))
      expect(p.flipX).toBe(c.flipX)
      expect(p.flipY).toBe(c.flipY)
      expect(p.dx).toBe(c.dx)
      expect(p.dy).toBe(c.dy)
    })
  }
})

// ── fromTables - sphere Q1 X-flip (parts 12–15) ──────────────────────────────

describe('BallAndChainAppearance.fromTables - sphere Q1 X-flip', () => {
  // bigTile($EA, tlDx=+8, tlDy=+48, flipX=true) → CORNER_OFF.flipX → offsets $01/$00/$11/$10
  // DATA_02D80F[1]=$73; TL at (+8,+48). Chars reversed horizontally: $EB/$EA/$FB/$FA
  const CASES = [
    { i: 12, key: OBJ_BASE + CHAR_HIGH + 0xeb, flipX: true, flipY: false, dx: 8, dy: 48 },
    { i: 13, key: OBJ_BASE + CHAR_HIGH + 0xea, flipX: true, flipY: false, dx: 16, dy: 48 },
    { i: 14, key: OBJ_BASE + CHAR_HIGH + 0xfb, flipX: true, flipY: false, dx: 8, dy: 56 },
    { i: 15, key: OBJ_BASE + CHAR_HIGH + 0xfa, flipX: true, flipY: false, dx: 16, dy: 56 },
  ] as const

  for (const c of CASES) {
    it(`part[${c.i}]: char=$${c.key.toString(16)}, flipX, dx=${c.dx}, dy=${c.dy}`, () => {
      const chars = makeChars()
      const app = BallAndChainAppearance.fromTables(chars, placeholder)
      const p = app.parts[c.i]!
      // CORNER_OFF.flipX[0]=$01→$EB at visual-TL; CORNER_OFF.flipX[1]=$00→$EA at visual-TR
      expect(p.char).toBe(chars.get(c.key))
      expect(p.flipX).toBe(c.flipX)
      expect(p.flipY).toBe(c.flipY)
      expect(p.dx).toBe(c.dx)
      expect(p.dy).toBe(c.dy)
    })
  }
})

// ── fromTables - sphere Q2 Y-flip (parts 16–19) ──────────────────────────────

describe('BallAndChainAppearance.fromTables - sphere Q2 Y-flip', () => {
  // bigTile($EA, tlDx=−8, tlDy=+64, flipY=true) → CORNER_OFF.flipY → offsets $10/$11/$00/$01
  // DATA_02D80F[2]=$B3; TL at (−8,+64). Chars reversed vertically: $FA/$FB/$EA/$EB
  const CASES = [
    { i: 16, key: OBJ_BASE + CHAR_HIGH + 0xfa, flipX: false, flipY: true, dx: -8, dy: 64 },
    { i: 17, key: OBJ_BASE + CHAR_HIGH + 0xfb, flipX: false, flipY: true, dx: 0, dy: 64 },
    { i: 18, key: OBJ_BASE + CHAR_HIGH + 0xea, flipX: false, flipY: true, dx: -8, dy: 72 },
    { i: 19, key: OBJ_BASE + CHAR_HIGH + 0xeb, flipX: false, flipY: true, dx: 0, dy: 72 },
  ] as const

  for (const c of CASES) {
    it(`part[${c.i}]: char=$${c.key.toString(16)}, flipY, dx=${c.dx}, dy=${c.dy}`, () => {
      const chars = makeChars()
      const app = BallAndChainAppearance.fromTables(chars, placeholder)
      const p = app.parts[c.i]!
      // CORNER_OFF.flipY[0]=$10→$FA at visual-TL; CORNER_OFF.flipY[2]=$00→$EA at visual-BL
      expect(p.char).toBe(chars.get(c.key))
      expect(p.flipX).toBe(c.flipX)
      expect(p.flipY).toBe(c.flipY)
      expect(p.dx).toBe(c.dx)
      expect(p.dy).toBe(c.dy)
    })
  }
})

// ── fromTables - sphere Q3 XY-flip (parts 20–23) ─────────────────────────────

describe('BallAndChainAppearance.fromTables - sphere Q3 XY-flip', () => {
  // bigTile($EA, tlDx=+8, tlDy=+64, flipX=true, flipY=true) → CORNER_OFF.both → $11/$10/$01/$00
  // DATA_02D80F[3]=$F3; TL at (+8,+64). Chars: $FB/$FA/$EB/$EA
  const CASES = [
    { i: 20, key: OBJ_BASE + CHAR_HIGH + 0xfb, flipX: true, flipY: true, dx: 8, dy: 64 },
    { i: 21, key: OBJ_BASE + CHAR_HIGH + 0xfa, flipX: true, flipY: true, dx: 16, dy: 64 },
    { i: 22, key: OBJ_BASE + CHAR_HIGH + 0xeb, flipX: true, flipY: true, dx: 8, dy: 72 },
    { i: 23, key: OBJ_BASE + CHAR_HIGH + 0xea, flipX: true, flipY: true, dx: 16, dy: 72 },
  ] as const

  for (const c of CASES) {
    it(`part[${c.i}]: char=$${c.key.toString(16)}, flipXY, dx=${c.dx}, dy=${c.dy}`, () => {
      const chars = makeChars()
      const app = BallAndChainAppearance.fromTables(chars, placeholder)
      const p = app.parts[c.i]!
      // CORNER_OFF.both[0]=$11→$FB at visual-TL; CORNER_OFF.both[3]=$00→$EA at visual-BR
      expect(p.char).toBe(chars.get(c.key))
      expect(p.flipX).toBe(c.flipX)
      expect(p.flipY).toBe(c.flipY)
      expect(p.dx).toBe(c.dx)
      expect(p.dy).toBe(c.dy)
    })
  }
})

// ── fromTables - missing chars → placeholder ─────────────────────────────────

describe('BallAndChainAppearance.fromTables - placeholder fallback', () => {
  it('empty chars map → all 24 parts use placeholder', () => {
    const app = BallAndChainAppearance.fromTables(new Map(), placeholder)
    expect(app.parts).toHaveLength(24)
    for (const p of app.parts) {
      expect(p.char).toBe(placeholder)
    }
  })
})

// ── hitRect - includes anchor tile ───────────────────────────────────────────

describe('BallAndChainAppearance.hitRect - anchor tile coverage', () => {
  // partsHitRect would give dy=16 (chain link 1 is the topmost part).
  // The override forces dy=0 so the anchor/pivot tile at dy=0..16 is clickable.
  // Lateral: sphere Q0/Q2 reach dx=−8; Q1/Q3 end at dx+8=24 → w=32.
  // Vertical: dy=0 (anchor) to dy=72+8=80 (sphere Q2/Q3 BR) → h=80.
  it('dx=−8: sphere quadrants extend 8 px left of pivot', () => {
    const app = BallAndChainAppearance.fromTables(makeChars(), placeholder)
    expect(app.hitRect.dx).toBe(-8)
  })

  it('dy=0: anchor tile at dy=0..16 is included (not dy=16 from partsHitRect)', () => {
    const app = BallAndChainAppearance.fromTables(makeChars(), placeholder)
    expect(app.hitRect.dy).toBe(0)
  })

  it('w=32: lateral span from dx=−8 to dx+8=24', () => {
    const app = BallAndChainAppearance.fromTables(makeChars(), placeholder)
    expect(app.hitRect.w).toBe(32)
  })

  it('h=80: vertical span from dy=0 (anchor) to dy=72+8=80 (sphere Q2/Q3 BR)', () => {
    const app = BallAndChainAppearance.fromTables(makeChars(), placeholder)
    expect(app.hitRect.h).toBe(80)
  })
})

// ── renderOverlay - guard ─────────────────────────────────────────────────────
