/**
 * BouncinChuckAppearance — locks the OAM composition for sprite $93 in pose
 * $06 (active arms-up bounce, set by CODE_02C53C bank_02.asm:9204 once
 * SpriteTableC2 advances to $06 after the chuck triggers).
 *
 * The values asserted below are the literal outputs of the chuck OAM-emit asm
 * (CODE_02C81A → CODE_02C88C / 02CA27 / 02CA9D). Misc151C is always $00 or
 * $04 for chucks (InitChuck DATA_018526 / CODE_02C556 DATA_02C639), so the
 * head tile is always $06 — only the head hflip toggles with face direction.
 * The two $0C arm slots are hardcoded and do NOT mirror with face direction.
 *
 * Test tree
 * ─────────
 *   face-right (Mario to chuck's right, Misc151C=$00)
 *     - parts count = head 4 + body1 4 + body2 4 + arm1 1 + arm2 1 = 14
 *     - head tile $06, dx 0, dy -12, hflip TRUE (DATA_02C885[$00]=$40)
 *     - body1 ($40) at +4, hflip TRUE
 *     - body2 ($40) at -4, hflip FALSE
 *     - arm1 ($0C) at -6, hflip FALSE
 *     - arm2 ($0C) at +14, hflip TRUE
 *   face-left (Mario to chuck's left, Misc151C=$04)
 *     - head tile $06 (same as face-right — ChuckHeadTiles[$04]=$06)
 *     - head hflip FALSE (DATA_02C885[$04]=$00)
 *     - body1 swaps to -4 with hflip FALSE
 *     - body2 swaps to +4 with hflip TRUE
 *     - arms keep face-right offsets and hflips (they don't mirror)
 *   palette / charHigh propagation, placeholder fallback
 */
import { describe, expect, it } from 'vitest'
import { Char } from '../../../src/rom/model/chars/Char'
import { BouncinChuckAppearance } from '../../../src/rom/model/sprites/appearances/BouncinChuckAppearance'

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

type PartShape = { id: number; palette: number; flipX: boolean; dx: number; dy: number }
function shape(id: number, palette: number, flipX: boolean, dx: number, dy: number): PartShape {
  return { id, palette, flipX, dx, dy }
}
function partShape(p: { char: Char; palette: number; flipX: boolean; flipY: boolean; dx: number; dy: number }): PartShape {
  expect(p.flipY).toBe(false)
  return { id: p.char.id, palette: p.palette, flipX: p.flipX, dx: p.dx, dy: p.dy }
}

describe('BouncinChuckAppearance.fromTables', () => {
  describe('face-right (Mario to chuck\'s right, Misc151C=$00)', () => {
    const a = BouncinChuckAppearance.fromTables(
      buildChars(), placeholder, BODY_PAL, BODY_HIGH, /*faceRight*/ true,
    )
    const parts = a.parts.map(partShape)

    it('emits 14 parts (head 4 + body 4+4 + arms 1+1)', () => {
      expect(parts).toHaveLength(14)
    })

    it('head $06 expands to 4 chars at (0, -12) hflipped — DATA_02C885[$00]=$40', () => {
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x07, BODY_PAL, true, 0,  -12),
        shape(OBJ_BASE + BODY_HIGH + 0x06, BODY_PAL, true, 8,  -12),
        shape(OBJ_BASE + BODY_HIGH + 0x17, BODY_PAL, true, 0,   -4),
        shape(OBJ_BASE + BODY_HIGH + 0x16, BODY_PAL, true, 8,   -4),
      ])
    })

    it('body1 $40 at (+4, 0) hflipped — DATA_02C909[$06+$1A]=+4, DATA_02C9BF=$00', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x41, BODY_PAL, true,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x40, BODY_PAL, true, 12, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x51, BODY_PAL, true,  4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x50, BODY_PAL, true, 12, 8),
      ])
    })

    it('body2 $40 at (-4, 0) un-flipped — DATA_02C93D[$06+$1A]=-4, DATA_02C9D9=$40 cancels base hflip', () => {
      expect(parts.slice(8, 12)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x40, BODY_PAL, false, -4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x41, BODY_PAL, false,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x50, BODY_PAL, false, -4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x51, BODY_PAL, false,  4, 8),
      ])
    })

    it('arm1 $0C at (-6, -8) un-flipped, arm2 $0C at (+14, -8) hflipped', () => {
      expect(parts[12]).toEqual(
        shape(OBJ_BASE + BODY_HIGH + 0x0C, BODY_PAL, false, -6, -8),
      )
      expect(parts[13]).toEqual(
        shape(OBJ_BASE + BODY_HIGH + 0x0C, BODY_PAL, true,  14, -8),
      )
    })
  })

  describe('face-left (Mario to chuck\'s left, Misc151C=$04)', () => {
    const a = BouncinChuckAppearance.fromTables(
      buildChars(), placeholder, BODY_PAL, BODY_HIGH, /*faceRight*/ false,
    )
    const parts = a.parts.map(partShape)

    it('emits 14 parts', () => {
      expect(parts).toHaveLength(14)
    })

    it('head $06 at (0, -12) un-flipped — ChuckHeadTiles[$04]=$06, DATA_02C885[$04]=$00', () => {
      // bigTile no-flip order on $06: [$06, $07, $16, $17]
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x06, BODY_PAL, false, 0,  -12),
        shape(OBJ_BASE + BODY_HIGH + 0x07, BODY_PAL, false, 8,  -12),
        shape(OBJ_BASE + BODY_HIGH + 0x16, BODY_PAL, false, 0,   -4),
        shape(OBJ_BASE + BODY_HIGH + 0x17, BODY_PAL, false, 8,   -4),
      ])
    })

    it('body1 swaps to (-4, 0) un-flipped — DATA_02C909[$06]=-4, base XOR $00 = no flip', () => {
      // bigTile no-flip order on $40: [$40, $41, $50, $51]
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x40, BODY_PAL, false, -4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x41, BODY_PAL, false,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x50, BODY_PAL, false, -4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x51, BODY_PAL, false,  4, 8),
      ])
    })

    it('body2 swaps to (+4, 0) hflipped — DATA_02C93D[$06]=+4, base XOR $40 = hflip', () => {
      expect(parts.slice(8, 12)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x41, BODY_PAL, true,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x40, BODY_PAL, true, 12, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x51, BODY_PAL, true,  4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x50, BODY_PAL, true, 12, 8),
      ])
    })

    it('arms keep face-right offsets and hflips — they don\'t mirror', () => {
      expect(parts[12]).toEqual(
        shape(OBJ_BASE + BODY_HIGH + 0x0C, BODY_PAL, false, -6, -8),
      )
      expect(parts[13]).toEqual(
        shape(OBJ_BASE + BODY_HIGH + 0x0C, BODY_PAL, true,  14, -8),
      )
    })
  })

  describe('palette / charHigh propagation', () => {
    it('all parts use bodyPalette and bodyCharHigh', () => {
      const a = BouncinChuckAppearance.fromTables(
        buildChars(), placeholder, /*bodyPalette*/ 13, /*bodyCharHigh*/ 0x100, false,
      )
      for (const part of a.parts) {
        expect(part.palette).toBe(13)
        expect(part.char.id).toBeGreaterThanOrEqual(OBJ_BASE + 0x100)
      }
    })
  })

  describe('placeholder fallback', () => {
    it('uses placeholder when chars map is empty', () => {
      const emptyChars = new Map<number, Char>()
      const a = BouncinChuckAppearance.fromTables(
        emptyChars, placeholder, BODY_PAL, BODY_HIGH, false,
      )
      for (const part of a.parts) {
        expect(part.char).toBe(placeholder)
      }
    })
  })
})
