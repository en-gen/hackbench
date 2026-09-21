/**
 * ChuckAppearance - covers the shared static helpers used by every chuck-
 * family appearance ($91 Chargin', $93 Bouncin', $95 Clappin', $97 Puntin').
 *
 * Test tree
 * ─────────
 *   bodyAttrs (decodes Sprite166EVals format `vhopppcc`)
 *     - bit 0 = charHigh select ($100 / $000)
 *     - bits 3-1 = OBJ palette N → CGRAM row 8+N
 *     - representative chuck attr $0B → palette 13, charHigh $100
 *   facesMario (mirrors SubHorizPos bank_01.asm:6124)
 *     - Mario right of chuck → face right (true)
 *     - Mario left of chuck → face left (false)
 *     - Mario equal to chuck X → face right (>= tiebreaker, matches BPL)
 *   bigTile / smallTile (delegated through builders)
 *     - bigTile expansion order respects flipX
 *     - smallTile single tile, placeholder fallback for missing chars
 */
import { describe, expect, it } from 'vitest'
import { Char } from '../../../src/rom/model/chars/Char'
import { ChuckAppearance } from '../../../src/rom/model/sprites/appearances/ChuckAppearance'

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

describe('ChuckAppearance.bodyAttrs', () => {
  it('decodes Sprite166EVals[$91-$98] = $0B → palette 13, charHigh $100', () => {
    expect(ChuckAppearance.bodyAttrs(0x0b)).toEqual({ palette: 13, charHigh: 0x100 })
  })

  it('low-page sprite (charHigh bit 0 clear) → charHigh = 0', () => {
    expect(ChuckAppearance.bodyAttrs(0x0a)).toEqual({ palette: 13, charHigh: 0 })
  })

  it('OBJ palette index N is bits 3-1; result is CGRAM row 8+N', () => {
    // $00 → palette 0 → row 8
    expect(ChuckAppearance.bodyAttrs(0x00)).toEqual({ palette: 8, charHigh: 0 })
    // $0E → palette 7 → row 15
    expect(ChuckAppearance.bodyAttrs(0x0e)).toEqual({ palette: 15, charHigh: 0 })
    // $07 → palette 3 → row 11 (chuck football's ChuckGfxProp attr)
    expect(ChuckAppearance.bodyAttrs(0x07)).toEqual({ palette: 11, charHigh: 0x100 })
  })

  it('priority/X/V flag bits 6-4 do not bleed into palette/charHigh', () => {
    // $E0 = 11100000 → palette 0, charHigh 0; high bits ignored here
    expect(ChuckAppearance.bodyAttrs(0xe0)).toEqual({ palette: 8, charHigh: 0 })
  })
})

describe('ChuckAppearance.facesMario', () => {
  it('Mario right of chuck (Mario.x > sprite.x) → face right', () => {
    expect(ChuckAppearance.facesMario(/*spritePx*/ 100, /*marioStartPx*/ 200)).toBe(true)
  })

  it('Mario left of chuck (Mario.x < sprite.x) → face left', () => {
    expect(ChuckAppearance.facesMario(/*spritePx*/ 200, /*marioStartPx*/ 100)).toBe(false)
  })

  it('Mario at same X as chuck → face right (>= tiebreaker matches SubHorizPos BPL)', () => {
    expect(ChuckAppearance.facesMario(/*spritePx*/ 100, /*marioStartPx*/ 100)).toBe(true)
  })
})

describe('ChuckAppearance.bigTile', () => {
  const chars = buildChars()

  it('no-flip: 4 chars at +0/+1/+10/+11 with dx [0,8,0,8] dy [0,0,8,8]', () => {
    const parts = ChuckAppearance.bigTile(chars, placeholder, 0x06, 10, -12, false, 5, 0x100)
    expect(parts).toHaveLength(4)
    expect(parts.map(p => ({ id: p.char.id, dx: p.dx, dy: p.dy, flipX: p.flipX }))).toEqual([
      { id: OBJ_BASE + 0x100 + 0x06, dx: 10, dy: -12, flipX: false },
      { id: OBJ_BASE + 0x100 + 0x07, dx: 18, dy: -12, flipX: false },
      { id: OBJ_BASE + 0x100 + 0x16, dx: 10, dy: -4, flipX: false },
      { id: OBJ_BASE + 0x100 + 0x17, dx: 18, dy: -4, flipX: false },
    ])
  })

  it('flipX: char order swaps to [+1,+0,+11,+10] so the visible left/right halves swap', () => {
    const parts = ChuckAppearance.bigTile(chars, placeholder, 0x06, 0, 0, true, 5, 0x100)
    expect(parts.map(p => p.char.id)).toEqual([
      OBJ_BASE + 0x100 + 0x07,
      OBJ_BASE + 0x100 + 0x06,
      OBJ_BASE + 0x100 + 0x17,
      OBJ_BASE + 0x100 + 0x16,
    ])
    for (const p of parts) expect(p.flipX).toBe(true)
  })

  it('falls back to placeholder when a char is missing from the map', () => {
    const empty = new Map<number, Char>()
    const parts = ChuckAppearance.bigTile(empty, placeholder, 0x06, 0, 0, false, 5, 0x100)
    for (const p of parts) expect(p.char).toBe(placeholder)
  })
})

describe('ChuckAppearance.smallTile', () => {
  const chars = buildChars()

  it('returns a single SpritePart with the resolved char', () => {
    const part = ChuckAppearance.smallTile(chars, placeholder, 0x0c, -6, -8, false, 5, 0x100)
    expect(part).toEqual({
      char: chars.get(OBJ_BASE + 0x100 + 0x0c),
      palette: 5,
      flipX: false,
      flipY: false,
      dx: -6,
      dy: -8,
    })
  })

  it('falls back to placeholder when char missing', () => {
    const empty = new Map<number, Char>()
    const part = ChuckAppearance.smallTile(empty, placeholder, 0x0c, 0, 0, false, 5, 0x100)
    expect(part.char).toBe(placeholder)
  })
})

describe('ChuckAppearance.builders', () => {
  it('returns curried bigTile/smallTile that wrap the static helpers with the same chars/placeholder', () => {
    const chars = buildChars()
    const { bigTile, smallTile } = ChuckAppearance.builders(chars, placeholder)
    const directBig = ChuckAppearance.bigTile(chars, placeholder, 0x06, 0, 0, false, 5, 0x100)
    const curriedBig = bigTile(0x06, 0, 0, false, 5, 0x100)
    const directSmall = ChuckAppearance.smallTile(chars, placeholder, 0x0c, 0, 0, false, 5, 0x100)
    const curriedSmall = smallTile(0x0c, 0, 0, false, 5, 0x100)
    expect(curriedBig).toEqual(directBig)
    expect(curriedSmall).toEqual(directSmall)
  })
})
