/**
 * WhistlinChuckAppearance — locks the OAM composition for sprite $94 in the
 * active whistle pose $06 with head tile $4B. Geometry verified directly via
 * Mesen sprite inspector against a face-LEFT Whistlin' Chuck on level $120
 * (FoI2). Body and arm geometry is byte-for-byte identical to BouncinChuck's
 * pose $06 frame; only the head tile differs ($4B whistling lips vs. $06).
 *
 * The Whistlin' Chuck head animates independently of face direction —
 * CODE_02C37B (bank_02.asm:8963) cycles Misc151C through DATA_02C373 =
 * $05,$05,$05,$02,$02,$06,$06,$06, so the head goes through $4B no flip
 * (3/8), $0E no flip (2/8), $4B hflip (3/8). The editor freezes the cycle
 * at Misc151C=$05 (no-flip $4B, the dominant stable pose) for face-LEFT and
 * mirrors hflip for face-RIGHT — both are valid asm-emitted phases.
 *
 * Test tree
 * ─────────
 *   face-left (Mario to chuck's left, Mesen capture orientation)
 *     - parts count = head 4 + body1 4 + body2 4 + arm1 1 + arm2 1 = 14
 *     - head $4B at (0, -12) NO flip — ChuckHeadTiles[$05]=$4B,
 *       DATA_02C885[$05]=$00
 *     - body1 ($40) at -4, NO flip — DATA_02C909[$06]=-4, DATA_02C9BF=$00
 *     - body2 ($40) at +4, hflip — DATA_02C93D[$06]=+4, DATA_02C9D9=$40
 *     - arm1 ($0C) at -6, NO flip — DATA_02CA93[0]=-6
 *     - arm2 ($0C) at +14, hflip — DATA_02CA95[0]=+14, attr | $40
 *   face-right (mirror)
 *     - head $4B hflipped — mirrors face-LEFT cycle phase Misc151C=$06
 *     - body1 swaps to +4 with hflip
 *     - body2 swaps to -4 with no flip
 *     - arms keep face-LEFT offsets and hflips (they don't mirror)
 *   placeholder fallback
 */
import { describe, expect, it } from 'vitest'
import { Char } from '../../../src/rom/model/chars/Char'
import { WhistlinChuckAppearance } from '../../../src/rom/model/sprites/appearances/WhistlinChuckAppearance'

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

describe('WhistlinChuckAppearance.fromTables', () => {
  describe('face-left (Mario to chuck\'s left) — Mesen capture orientation', () => {
    const a = WhistlinChuckAppearance.fromTables(
      buildChars(), placeholder, BODY_PAL, BODY_HIGH, /*faceRight*/ false,
    )
    const parts = a.parts.map(partShape)

    it('emits 14 parts (head 4 + body 4+4 + arms 1+1)', () => {
      expect(parts).toHaveLength(14)
    })

    it('head $4B at (0, -12) un-flipped — ChuckHeadTiles[$05]=$4B, DATA_02C885[$05]=$00', () => {
      // bigTile no-flip order on $4B: [$4B, $4C, $5B, $5C]
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x4B, BODY_PAL, false, 0,  -12),
        shape(OBJ_BASE + BODY_HIGH + 0x4C, BODY_PAL, false, 8,  -12),
        shape(OBJ_BASE + BODY_HIGH + 0x5B, BODY_PAL, false, 0,   -4),
        shape(OBJ_BASE + BODY_HIGH + 0x5C, BODY_PAL, false, 8,   -4),
      ])
    })

    it('body1 $40 at (-4, 0) un-flipped — DATA_02C909[$06]=-4, DATA_02C9BF=$00', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x40, BODY_PAL, false, -4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x41, BODY_PAL, false,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x50, BODY_PAL, false, -4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x51, BODY_PAL, false,  4, 8),
      ])
    })

    it('body2 $40 at (+4, 0) hflipped — DATA_02C93D[$06]=+4, base XOR DATA_02C9D9=$40', () => {
      expect(parts.slice(8, 12)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x41, BODY_PAL, true,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x40, BODY_PAL, true, 12, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x51, BODY_PAL, true,  4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x50, BODY_PAL, true, 12, 8),
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

  describe('face-right (Mario to chuck\'s right) — mirror', () => {
    const a = WhistlinChuckAppearance.fromTables(
      buildChars(), placeholder, BODY_PAL, BODY_HIGH, /*faceRight*/ true,
    )
    const parts = a.parts.map(partShape)

    it('head $4B hflipped — mirrors face-LEFT, matches Misc151C=$06 cycle phase', () => {
      // bigTile flipX order on $4B: [$4C, $4B, $5C, $5B]
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x4C, BODY_PAL, true, 0,  -12),
        shape(OBJ_BASE + BODY_HIGH + 0x4B, BODY_PAL, true, 8,  -12),
        shape(OBJ_BASE + BODY_HIGH + 0x5C, BODY_PAL, true, 0,   -4),
        shape(OBJ_BASE + BODY_HIGH + 0x5B, BODY_PAL, true, 8,   -4),
      ])
    })

    it('body1 swaps to (+4, 0) hflipped — DATA_02C909[$06+$1A]=+4', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x41, BODY_PAL, true,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x40, BODY_PAL, true, 12, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x51, BODY_PAL, true,  4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x50, BODY_PAL, true, 12, 8),
      ])
    })

    it('body2 swaps to (-4, 0) un-flipped — DATA_02C93D[$06+$1A]=-4', () => {
      expect(parts.slice(8, 12)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x40, BODY_PAL, false, -4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x41, BODY_PAL, false,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x50, BODY_PAL, false, -4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x51, BODY_PAL, false,  4, 8),
      ])
    })

    it('arms keep their face-LEFT offsets and hflips — they don\'t mirror', () => {
      expect(parts[12]).toEqual(
        shape(OBJ_BASE + BODY_HIGH + 0x0C, BODY_PAL, false, -6, -8),
      )
      expect(parts[13]).toEqual(
        shape(OBJ_BASE + BODY_HIGH + 0x0C, BODY_PAL, true,  14, -8),
      )
    })
  })

  describe('placeholder fallback', () => {
    it('uses placeholder when chars map is empty', () => {
      const a = WhistlinChuckAppearance.fromTables(
        new Map(), placeholder, BODY_PAL, BODY_HIGH, false,
      )
      for (const part of a.parts) expect(part.char).toBe(placeholder)
    })
  })
})
