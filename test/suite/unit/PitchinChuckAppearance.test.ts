/**
 * PitchinChuckAppearance - locks the OAM composition for sprite $98 in the
 * throw-cycle pose $18 with the baseball composed at the captured runtime
 * offset. Geometry verified directly via Mesen sprite inspector against a
 * face-LEFT Pitchin' Chuck on level $015 (DP1).
 *
 * Test tree
 * ─────────
 *   face-left (Mario to chuck's left, Mesen capture orientation)
 *     - 10 parts: head 4 + body2 4 + body1 + baseball
 *     - head $06 16x16 at (-8, -8) NO flip (DATA_02C885[Misc151C=4]=$00)
 *     - body2 $A4 16x16 at (0, 0) NO flip
 *     - body1 $BD 8x8 single at (-8, 0) NO flip - DATA_02C909[$18]=-8
 *     - baseball $AD 8x8 at (-20, 0) HFLIP, palette 12 (CGRAM row 12)
 *   face-right (mirror)
 *     - head $06 still hflipped (DATA_02C885[0]=$40)
 *     - body1 swaps to (+16, 0) hflip - DATA_02C909[$18+$1A]=+16, NOT a simple mirror
 *     - body2 stays at (0, 0) hflipped
 *     - baseball at (+20, 0) NO flip (default tile faces right)
 */
import { describe, expect, it } from 'vitest'
import { Char } from '../../../src/rom/model/chars/Char'
import { PitchinChuckAppearance } from '../../../src/rom/model/sprites/appearances/PitchinChuckAppearance'

const OBJ_BASE = 0x400
function syntheticChar(id: number): Char {
  return new Char(id, { getPixels: () => new Uint8Array(64) })
}
const placeholder = syntheticChar(-1)
function buildChars(): Map<number, Char> {
  const map = new Map<number, Char>()
  for (let id = 0; id < 0x800; id++) map.set(id, syntheticChar(id))
  return map
}
const BODY_PAL = 13
const BODY_HIGH = 0x100
const BALL_PAL = 12
const BALL_HIGH = 0x100

type PartShape = { id: number; palette: number; flipX: boolean; dx: number; dy: number }
function shape(id: number, palette: number, flipX: boolean, dx: number, dy: number): PartShape {
  return { id, palette, flipX, dx, dy }
}
function partShape(p: {
  char: Char
  palette: number
  flipX: boolean
  flipY: boolean
  dx: number
  dy: number
}): PartShape {
  expect(p.flipY).toBe(false)
  return { id: p.char.id, palette: p.palette, flipX: p.flipX, dx: p.dx, dy: p.dy }
}

describe('PitchinChuckAppearance.fromTables', () => {
  describe('face-left (Mesen capture orientation)', () => {
    const a = PitchinChuckAppearance.fromTables(
      buildChars(),
      placeholder,
      BODY_PAL,
      BODY_HIGH,
      false,
    )
    const parts = a.parts.map(partShape)

    it('emits 10 parts (head 4 + body2 4 + body1 + baseball)', () => {
      expect(parts).toHaveLength(10)
    })

    it('head $06 at (-8, -8) NO flip - DATA_02C885[Misc151C=4]=$00', () => {
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x06, BODY_PAL, false, -8, -8),
        shape(OBJ_BASE + BODY_HIGH + 0x07, BODY_PAL, false, 0, -8),
        shape(OBJ_BASE + BODY_HIGH + 0x16, BODY_PAL, false, -8, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x17, BODY_PAL, false, 0, 0),
      ])
    })

    it('body2 $A4 16x16 at (0, 0) NO flip', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0xa4, BODY_PAL, false, 0, 0),
        shape(OBJ_BASE + BODY_HIGH + 0xa5, BODY_PAL, false, 8, 0),
        shape(OBJ_BASE + BODY_HIGH + 0xb4, BODY_PAL, false, 0, 8),
        shape(OBJ_BASE + BODY_HIGH + 0xb5, BODY_PAL, false, 8, 8),
      ])
    })

    it('body1 $BD 8x8 single tile at (-8, 0) - DATA_02C9F3[$18]=$00, DATA_02C909[$18]=-8', () => {
      expect(parts[8]).toEqual(shape(OBJ_BASE + BODY_HIGH + 0xbd, BODY_PAL, false, -8, 0))
    })

    it('baseball $AD 8x8 at (-20, 0) hflip, palette 12 - flying left away from chuck', () => {
      expect(parts[9]).toEqual(shape(OBJ_BASE + BALL_HIGH + 0xad, BALL_PAL, true, -20, 0))
    })
  })

  describe('face-right (mirror)', () => {
    const a = PitchinChuckAppearance.fromTables(
      buildChars(),
      placeholder,
      BODY_PAL,
      BODY_HIGH,
      true,
    )
    const parts = a.parts.map(partShape)

    it('head $06 hflipped at (+8, -8) - DATA_02C885[Misc151C=0]=$40 forces hflip', () => {
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x07, BODY_PAL, true, 8, -8),
        shape(OBJ_BASE + BODY_HIGH + 0x06, BODY_PAL, true, 16, -8),
        shape(OBJ_BASE + BODY_HIGH + 0x17, BODY_PAL, true, 8, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x16, BODY_PAL, true, 16, 0),
      ])
    })

    it('body2 $A4 at (0, 0) hflipped', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0xa5, BODY_PAL, true, 0, 0),
        shape(OBJ_BASE + BODY_HIGH + 0xa4, BODY_PAL, true, 8, 0),
        shape(OBJ_BASE + BODY_HIGH + 0xb5, BODY_PAL, true, 0, 8),
        shape(OBJ_BASE + BODY_HIGH + 0xb4, BODY_PAL, true, 8, 8),
      ])
    })

    it('body1 face-right dx=+16 (NOT simple mirror) - DATA_02C909[$18+$1A]=+16', () => {
      expect(parts[8]).toEqual(shape(OBJ_BASE + BODY_HIGH + 0xbd, BODY_PAL, true, 16, 0))
    })

    it('baseball at (+20, 0) NO flip - flying right; default tile faces right', () => {
      expect(parts[9]).toEqual(shape(OBJ_BASE + BALL_HIGH + 0xad, BALL_PAL, false, 20, 0))
    })
  })

  describe('placeholder fallback', () => {
    it('uses placeholder when chars map is empty', () => {
      const a = PitchinChuckAppearance.fromTables(
        new Map(),
        placeholder,
        BODY_PAL,
        BODY_HIGH,
        false,
      )
      for (const part of a.parts) expect(part.char).toBe(placeholder)
    })
  })
})
