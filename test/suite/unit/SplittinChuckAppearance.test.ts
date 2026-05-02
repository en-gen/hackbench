/**
 * SplittinChuckAppearance — locks the OAM composition for sprite $92 in the
 * running pose with body $2D mirrored across the chuck's centerline.
 * Geometry verified directly via Mesen sprite inspector against a face-LEFT
 * Splittin' Chuck on level $001 (VS2).
 *
 * Test tree
 * ─────────
 *   face-left (Mario to chuck's left, Mesen capture orientation)
 *     - 12 parts: head 4 + body1 4 + body2 4
 *     - head $06 16x16 at (0, -4) NO flip
 *     - body1 $2D 16x16 at (-4, 0) NO flip
 *     - body2 $2D 16x16 at (+4, 0) HFLIP — body2FlipXor=$40
 *   face-right (mirror)
 *     - head $06 hflipped (DATA_02C885[Misc151C=0]=$40)
 *     - body1 swaps to (+4, 0) HFLIP
 *     - body2 swaps to (-4, 0) NO flip
 */
import { describe, expect, it } from 'vitest'
import { Char } from '../../../src/rom/model/chars/Char'
import { SplittinChuckAppearance } from '../../../src/rom/model/sprites/appearances/SplittinChuckAppearance'

const OBJ_BASE = 0x400
function syntheticChar(id: number): Char { return new Char(id, { getPixels: () => new Uint8Array(64) }) }
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

describe('SplittinChuckAppearance.fromTables', () => {
  describe('face-left (Mesen capture orientation)', () => {
    const a = SplittinChuckAppearance.fromTables(buildChars(), placeholder, BODY_PAL, BODY_HIGH, false)
    const parts = a.parts.map(partShape)

    it('emits 12 parts (head 4 + body1 4 + body2 4)', () => {
      expect(parts).toHaveLength(12)
    })

    it('head $06 at (0, -4) NO flip — DATA_02C885[Misc151C=4]=$00', () => {
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x06, BODY_PAL, false, 0, -4),
        shape(OBJ_BASE + BODY_HIGH + 0x07, BODY_PAL, false, 8, -4),
        shape(OBJ_BASE + BODY_HIGH + 0x16, BODY_PAL, false, 0,  4),
        shape(OBJ_BASE + BODY_HIGH + 0x17, BODY_PAL, false, 8,  4),
      ])
    })

    it('body1 $2D at (-4, 0) NO flip — DATA_02C9BF[$04]=$00', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x2D, BODY_PAL, false, -4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x2E, BODY_PAL, false,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x3D, BODY_PAL, false, -4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x3E, BODY_PAL, false,  4, 8),
      ])
    })

    it('body2 $2D at (+4, 0) HFLIP — body2FlipXor=$40 mirrors body1 across center', () => {
      expect(parts.slice(8, 12)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x2E, BODY_PAL, true,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x2D, BODY_PAL, true, 12, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x3E, BODY_PAL, true,  4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x3D, BODY_PAL, true, 12, 8),
      ])
    })
  })

  describe('face-right (mirror)', () => {
    const a = SplittinChuckAppearance.fromTables(buildChars(), placeholder, BODY_PAL, BODY_HIGH, true)
    const parts = a.parts.map(partShape)

    it('head $06 hflipped at (0, -4) — DATA_02C885[Misc151C=0]=$40', () => {
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x07, BODY_PAL, true, 0, -4),
        shape(OBJ_BASE + BODY_HIGH + 0x06, BODY_PAL, true, 8, -4),
        shape(OBJ_BASE + BODY_HIGH + 0x17, BODY_PAL, true, 0,  4),
        shape(OBJ_BASE + BODY_HIGH + 0x16, BODY_PAL, true, 8,  4),
      ])
    })

    it('body halves swap their flip flags and X positions mirror', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x2E, BODY_PAL, true,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x2D, BODY_PAL, true, 12, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x3E, BODY_PAL, true,  4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x3D, BODY_PAL, true, 12, 8),
      ])
      expect(parts.slice(8, 12)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x2D, BODY_PAL, false, -4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x2E, BODY_PAL, false,  4, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x3D, BODY_PAL, false, -4, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x3E, BODY_PAL, false,  4, 8),
      ])
    })
  })

  describe('placeholder fallback', () => {
    it('uses placeholder when chars map is empty', () => {
      const a = SplittinChuckAppearance.fromTables(new Map(), placeholder, BODY_PAL, BODY_HIGH, false)
      for (const part of a.parts) expect(part.char).toBe(placeholder)
    })
  })
})
