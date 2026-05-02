/**
 * ClappinChuckAppearance — locks the OAM composition for sprite $95 in pose
 * $07 (clap follow-through). Geometry verified directly via Mesen sprite
 * inspector against a face-RIGHT Clappin' Chuck on level $105 (YI1) — the
 * head is empirically NOT hflipped despite what `DATA_02C885 | base`
 * algebraically predicts; we follow Mesen as the ground truth.
 *
 * Test tree
 * ─────────
 *   face-right (Mario right of chuck) — Mesen capture orientation
 *     - 16 parts: head 4 + body1 4 + body2 4 + glove 4
 *     - head $06 at (0, -11) NO hflip
 *     - body1 $42 at (+8, 0) hflip TRUE
 *     - body2 $42 at (-8, 0) NO flip
 *     - glove $44 16x16 at (0, -16) hflip TRUE
 *   face-left (mirror)
 *     - head TILE differs to $0A (ChuckHeadTiles[Misc151C=1]) hflip TRUE
 *     - body1 swaps to (-8, 0) no flip; body2 to (+8, 0) hflip
 *     - glove no flip
 */
import { describe, expect, it } from 'vitest'
import { Char } from '../../../src/rom/model/chars/Char'
import { ClappinChuckAppearance } from '../../../src/rom/model/sprites/appearances/ClappinChuckAppearance'

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

describe('ClappinChuckAppearance.fromTables', () => {
  describe('face-right (Mesen capture orientation)', () => {
    const a = ClappinChuckAppearance.fromTables(buildChars(), placeholder, BODY_PAL, BODY_HIGH, true)
    const parts = a.parts.map(partShape)

    it('emits 16 parts (head 4 + body1 4 + body2 4 + glove 4)', () => {
      expect(parts).toHaveLength(16)
    })

    it('head $06 at (0, -11) NO hflip per Mesen', () => {
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x06, BODY_PAL, false, 0, -11),
        shape(OBJ_BASE + BODY_HIGH + 0x07, BODY_PAL, false, 8, -11),
        shape(OBJ_BASE + BODY_HIGH + 0x16, BODY_PAL, false, 0,  -3),
        shape(OBJ_BASE + BODY_HIGH + 0x17, BODY_PAL, false, 8,  -3),
      ])
    })

    it('body1 $42 at (+8, 0) hflip', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x43, BODY_PAL, true,  8, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x42, BODY_PAL, true, 16, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x53, BODY_PAL, true,  8, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x52, BODY_PAL, true, 16, 8),
      ])
    })

    it('body2 $42 at (-8, 0) NO flip', () => {
      expect(parts.slice(8, 12)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x42, BODY_PAL, false, -8, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x43, BODY_PAL, false,  0, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x52, BODY_PAL, false, -8, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x53, BODY_PAL, false,  0, 8),
      ])
    })

    it('glove $44 raised at (0, -16) hflip', () => {
      expect(parts.slice(12, 16)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x45, BODY_PAL, true, 0, -16),
        shape(OBJ_BASE + BODY_HIGH + 0x44, BODY_PAL, true, 8, -16),
        shape(OBJ_BASE + BODY_HIGH + 0x55, BODY_PAL, true, 0,  -8),
        shape(OBJ_BASE + BODY_HIGH + 0x54, BODY_PAL, true, 8,  -8),
      ])
    })
  })

  describe('face-left (mirror)', () => {
    const a = ClappinChuckAppearance.fromTables(buildChars(), placeholder, BODY_PAL, BODY_HIGH, false)
    const parts = a.parts.map(partShape)

    it('head TILE swaps to $0A — ChuckHeadTiles[Misc151C=1], hflip toggled to TRUE', () => {
      expect(parts.slice(0, 4)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x0B, BODY_PAL, true, 0, -11),
        shape(OBJ_BASE + BODY_HIGH + 0x0A, BODY_PAL, true, 8, -11),
        shape(OBJ_BASE + BODY_HIGH + 0x1B, BODY_PAL, true, 0,  -3),
        shape(OBJ_BASE + BODY_HIGH + 0x1A, BODY_PAL, true, 8,  -3),
      ])
    })

    it('body halves swap their flip flags and X positions mirror', () => {
      expect(parts.slice(4, 8)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x42, BODY_PAL, false, -8, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x43, BODY_PAL, false,  0, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x52, BODY_PAL, false, -8, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x53, BODY_PAL, false,  0, 8),
      ])
      expect(parts.slice(8, 12)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x43, BODY_PAL, true,  8, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x42, BODY_PAL, true, 16, 0),
        shape(OBJ_BASE + BODY_HIGH + 0x53, BODY_PAL, true,  8, 8),
        shape(OBJ_BASE + BODY_HIGH + 0x52, BODY_PAL, true, 16, 8),
      ])
    })

    it('glove NO flip (mirror of face-right)', () => {
      expect(parts.slice(12, 16)).toEqual([
        shape(OBJ_BASE + BODY_HIGH + 0x44, BODY_PAL, false, 0, -16),
        shape(OBJ_BASE + BODY_HIGH + 0x45, BODY_PAL, false, 8, -16),
        shape(OBJ_BASE + BODY_HIGH + 0x54, BODY_PAL, false, 0,  -8),
        shape(OBJ_BASE + BODY_HIGH + 0x55, BODY_PAL, false, 8,  -8),
      ])
    })
  })

  describe('placeholder fallback', () => {
    it('uses placeholder when chars map is empty', () => {
      const a = ClappinChuckAppearance.fromTables(new Map(), placeholder, BODY_PAL, BODY_HIGH, false)
      for (const part of a.parts) expect(part.char).toBe(placeholder)
    })
  })
})
