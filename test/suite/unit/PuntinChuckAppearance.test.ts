/**
 * PuntinChuckAppearance — locks the OAM composition for sprite $97 in the
 * canonical kick wind-up pose ($11 from DATA_02C4B5 in bank_02.asm:9136),
 * verified against a Mesen sprite-inspector dump on level $1F1.
 *
 * Test tree
 * ─────────
 *   face-left (Mario to chuck's left, default cave-shot capture)
 *     - parts count = head 4 + body2 4 + body1 1 + football 4 = 13
 *     - head $06 16x16 at (-7, -10), bodyPalette / bodyCharHigh, no flip
 *     - body2 $CC 16x16 at (0, 0), bodyPalette / bodyCharHigh, no flip
 *     - body1 $CB 8x8 single at (-8, +3), bodyPalette / bodyCharHigh, no flip
 *     - football $8A 16x16 at (-20, 0), ballPalette / ballCharHigh, hflip=TRUE
 *   face-right (Mario to chuck's right)
 *     - X offsets negate (head +7, body1 +8, football +20; body2 stays at 0)
 *     - chuck parts gain hflip=true
 *     - football hflip=false (ball travels right; default tile already faces right)
 *   palette propagation
 *     - chuck parts use the bodyPalette arg (independent of ballPalette)
 *     - football parts use the ballPalette arg
 *   placeholder fallback
 *     - any tile missing from the chars map resolves to the placeholder Char
 */
import { describe, expect, it } from 'vitest'
import { Char } from '../../../src/rom/model/chars/Char'
import { PuntinChuckAppearance } from '../../../src/rom/model/sprites/appearances/PuntinChuckAppearance'

const OBJ_BASE = 0x400

// Synthetic Char with a no-op behavior; we only inspect `id` in tests.
function syntheticChar(id: number): Char {
  return new Char(id, { getPixels: () => new Uint8Array(64) })
}

const placeholder = syntheticChar(-1)

// Chars map populated for every char number an appearance might request.
// The map's `get(n)` returns a Char whose id === n so each part's lookup is
// directly inspectable.
function buildChars(): Map<number, Char> {
  const map = new Map<number, Char>()
  for (let id = 0; id < 0x800; id++) map.set(id, syntheticChar(id))
  return map
}

const BODY_PAL = 13      // OBJ pal 5 → CGRAM row 13 (chuck body)
const BODY_HIGH = 0x100  // bit 0 of Sprite166EVals[$97] = $0B
const BALL_PAL = 8       // OBJ pal 0 → CGRAM row 8 (sprite $1B)
const BALL_HIGH = 0x100  // bit 0 of Sprite166EVals[$1B] = $01

// Helpers for matching SpritePart values without hand-typing flipY false
// every line.
type PartShape = { id: number; palette: number; flipX: boolean; dx: number; dy: number }
function shape(id: number, palette: number, flipX: boolean, dx: number, dy: number): PartShape {
  return { id, palette, flipX, dx, dy }
}
function partShape(p: { char: Char; palette: number; flipX: boolean; flipY: boolean; dx: number; dy: number }): PartShape {
  expect(p.flipY).toBe(false)  // none of the chuck/football tiles ever vflip
  return { id: p.char.id, palette: p.palette, flipX: p.flipX, dx: p.dx, dy: p.dy }
}

describe('PuntinChuckAppearance.fromTables', () => {
  describe('face-left (Mario to chuck\'s left)', () => {
    const a = PuntinChuckAppearance.fromTables(
      buildChars(), placeholder, BODY_PAL, BODY_HIGH, BALL_PAL, BALL_HIGH, /*faceRight*/ false,
    )
    const parts = a.parts.map(partShape)

    it('emits exactly 13 parts (head 4 + body2 4 + body1 1 + football 4)', () => {
      expect(parts).toHaveLength(13)
    })

    it('head $06 expands to 4 chars at (-7, -10) using bodyPalette/bodyCharHigh', () => {
      // bigTile face-left order: [$00, $01, $10, $11], dx [0,8,0,8], dy [0,0,8,8]
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x06, BODY_PAL, false, -7, -10),
        shape(OBJ_BASE + BODY_HIGH + 0x07, BODY_PAL, false,  1, -10),
        shape(OBJ_BASE + BODY_HIGH + 0x16, BODY_PAL, false, -7,  -2),
        shape(OBJ_BASE + BODY_HIGH + 0x17, BODY_PAL, false,  1,  -2),
      ])
    })

    it('body2 $CC expands to 4 chars at (0, 0)', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0xCC, BODY_PAL, false, 0, 0),
        shape(OBJ_BASE + BODY_HIGH + 0xCD, BODY_PAL, false, 8, 0),
        shape(OBJ_BASE + BODY_HIGH + 0xDC, BODY_PAL, false, 0, 8),
        shape(OBJ_BASE + BODY_HIGH + 0xDD, BODY_PAL, false, 8, 8),
      ])
    })

    it('body1 $CB is a single 8x8 tile at (-8, +3) — DATA_02C9F3[$11] = $00', () => {
      expect(parts[8]).toEqual(
        shape(OBJ_BASE + BODY_HIGH + 0xCB, BODY_PAL, false, -8, 3),
      )
    })

    it('football $8A expands to 4 chars at (-20, 0) hflipped (ball travels left)', () => {
      // bigTile flipX order: [$01, $00, $11, $10], dx [0,8,0,8], dy [0,0,8,8]
      expect(parts.slice(9, 13)).toEqual([
        shape(OBJ_BASE + BALL_HIGH + 0x8B, BALL_PAL, true, -20, 0),
        shape(OBJ_BASE + BALL_HIGH + 0x8A, BALL_PAL, true, -12, 0),
        shape(OBJ_BASE + BALL_HIGH + 0x9B, BALL_PAL, true, -20, 8),
        shape(OBJ_BASE + BALL_HIGH + 0x9A, BALL_PAL, true, -12, 8),
      ])
    })
  })

  describe('face-right (Mario to chuck\'s right) — mirror of face-left', () => {
    const a = PuntinChuckAppearance.fromTables(
      buildChars(), placeholder, BODY_PAL, BODY_HIGH, BALL_PAL, BALL_HIGH, /*faceRight*/ true,
    )
    const parts = a.parts.map(partShape)

    it('emits exactly 13 parts', () => {
      expect(parts).toHaveLength(13)
    })

    it('head mirrors to (+7, -10) with hflip on each big-tile cell', () => {
      // bigTile flipX order: [$01, $00, $11, $10]
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x07, BODY_PAL, true,  7, -10),
        shape(OBJ_BASE + BODY_HIGH + 0x06, BODY_PAL, true, 15, -10),
        shape(OBJ_BASE + BODY_HIGH + 0x17, BODY_PAL, true,  7,  -2),
        shape(OBJ_BASE + BODY_HIGH + 0x16, BODY_PAL, true, 15,  -2),
      ])
    })

    it('body2 stays at (0, 0) — bdx is symmetric — but tiles flip', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0xCD, BODY_PAL, true, 0, 0),
        shape(OBJ_BASE + BODY_HIGH + 0xCC, BODY_PAL, true, 8, 0),
        shape(OBJ_BASE + BODY_HIGH + 0xDD, BODY_PAL, true, 0, 8),
        shape(OBJ_BASE + BODY_HIGH + 0xDC, BODY_PAL, true, 8, 8),
      ])
    })

    it('body1 mirrors to (+8, +3) with hflip', () => {
      expect(parts[8]).toEqual(
        shape(OBJ_BASE + BODY_HIGH + 0xCB, BODY_PAL, true, 8, 3),
      )
    })

    it('football mirrors to (+20, 0) with hflip OFF (ball travels right)', () => {
      // bigTile no-flip order: [$00, $01, $10, $11]
      expect(parts.slice(9, 13)).toEqual([
        shape(OBJ_BASE + BALL_HIGH + 0x8A, BALL_PAL, false, 20, 0),
        shape(OBJ_BASE + BALL_HIGH + 0x8B, BALL_PAL, false, 28, 0),
        shape(OBJ_BASE + BALL_HIGH + 0x9A, BALL_PAL, false, 20, 8),
        shape(OBJ_BASE + BALL_HIGH + 0x9B, BALL_PAL, false, 28, 8),
      ])
    })
  })

  describe('palette / charHigh propagation', () => {
    it('chuck parts use bodyPalette/bodyCharHigh; football uses ballPalette/ballCharHigh', () => {
      // Pick deliberately different values so the assertion catches any swap.
      const a = PuntinChuckAppearance.fromTables(
        buildChars(), placeholder,
        /*bodyPalette*/ 13, /*bodyCharHigh*/ 0x100,
        /*ballPalette*/  8, /*ballCharHigh*/ 0x000,  // force ball into low-page so charHigh diverges
        /*faceRight*/ false,
      )
      // First 9 parts are chuck (head + body2 + body1).
      for (const part of a.parts.slice(0, 9)) {
        expect(part.palette).toBe(13)
        expect(part.char.id).toBeGreaterThanOrEqual(OBJ_BASE + 0x100)
      }
      // Last 4 parts are the football.
      for (const part of a.parts.slice(9)) {
        expect(part.palette).toBe(8)
        // ballCharHigh = 0 → football chars are in low-page (< OBJ_BASE + 0x100).
        expect(part.char.id).toBeLessThan(OBJ_BASE + 0x100)
      }
    })
  })

  describe('placeholder fallback', () => {
    it('uses the placeholder Char for any tile missing from chars map', () => {
      const emptyChars = new Map<number, Char>()
      const a = PuntinChuckAppearance.fromTables(
        emptyChars, placeholder, BODY_PAL, BODY_HIGH, BALL_PAL, BALL_HIGH, false,
      )
      for (const part of a.parts) {
        expect(part.char).toBe(placeholder)
      }
    })
  })
})
