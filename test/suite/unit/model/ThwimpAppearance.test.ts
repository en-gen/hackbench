/**
 * ThwimpAppearance.test.ts - construction coverage for ThwimpAppearance
 * (src/rom/model/sprites/appearances/ThwimpAppearance.ts, sprite $27).
 *
 * Test tree:
 *   fromTables() charHigh and palette
 *     - attr bit0=0 -> charHigh=0; attr bits3-1=1 -> palette=9
 *     - attr bit0=1 -> charHigh=0x100
 *   fromTables() ?? fallback branches
 *     - spriteAttr too short -> palette=8, charHigh=0
 *     - chars missing key -> placeholder for all 4 corners
 */

import { describe, it, expect } from 'vitest'
import { ThwimpAppearance } from '../../../../src/rom/model/sprites/appearances/ThwimpAppearance'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import type { SpriteTileTables } from '../../../../src/rom/SpriteTileLoader'

// -- fromTables() fixtures ------------------------------------------------

function makeChar(id: number): Char {
  return new Char(id, new StaticPixelsBehavior(new Uint8Array(64)))
}

function makeTables(opts: {
  attrByte?: number
  tilemapOffset?: number
  tilemap?: number[]
}): SpriteTileTables {
  const spriteAttr = new Uint8Array(0x40)
  const tilemapOffsets = new Uint8Array(0x40)
  const tilemap = new Uint8Array(0x100)
  if (opts.attrByte !== undefined)    spriteAttr[0x27]     = opts.attrByte
  if (opts.tilemapOffset !== undefined) tilemapOffsets[0x27] = opts.tilemapOffset
  if (opts.tilemap) opts.tilemap.forEach((b, i) => { tilemap[(opts.tilemapOffset ?? 0) + i] = b })
  return { tilemap, tilemapOffset: tilemapOffsets, spriteAttr, dispX: [], dispY: [], gfxProp: [], spr0to13Prop: new Uint8Array(0), yoshiPal: new Uint8Array(4) }
}

describe('ThwimpAppearance.fromTables() — charHigh and palette', () => {
  it('attr bit0=0 → charHigh=0; attr bits3-1=1 → palette=9', () => {
    // spriteAttr[0x27] = 0x02 → palette=8+((0x02>>1)&7)=9; bit0=0 → charHigh=0
    const tables = makeTables({ attrByte: 0x02, tilemapOffset: 0, tilemap: [0x67, 0x69, 0x88, 0xCE] })
    const chars = new Map<number, Char>()
    chars.set(0x400 + 0x67, makeChar(0x67))
    const placeholder = makeChar(0xFFFF)
    const app = ThwimpAppearance.fromTables(chars, tables, placeholder)
    expect(app.parts[0].palette).toBe(9)
    expect(app.parts[0].char.id).toBe(0x67)
  })

  it('attr bit0=1 → charHigh=0x100; char from high range used', () => {
    // spriteAttr[0x27] = 0x01 → charHigh=0x100; tile $67 → key = 0x400+0x100+0x67 = 0x567
    const tables = makeTables({ attrByte: 0x01, tilemapOffset: 0, tilemap: [0x67, 0x69, 0x88, 0xCE] })
    const chars = new Map<number, Char>()
    chars.set(0x400 + 0x100 + 0x67, makeChar(0x567))
    const placeholder = makeChar(0xFFFF)
    const app = ThwimpAppearance.fromTables(chars, tables, placeholder)
    expect(app.parts[0].char.id).toBe(0x567)
  })
})

describe('ThwimpAppearance.fromTables() — ?? fallback branches', () => {
  it('spriteAttr too short → spriteAttr[0x27]=undefined → ?? 0 → palette=8, charHigh=0', () => {
    // Uint8Array shorter than 0x28 → index 0x27 out of bounds → undefined
    const tables: SpriteTileTables = {
      tilemap:       new Uint8Array(0),
      tilemapOffset: new Uint8Array(0),
      spriteAttr:    new Uint8Array(0),
      dispX: [], dispY: [], gfxProp: [], spr0to13Prop: new Uint8Array(0), yoshiPal: new Uint8Array(0),
    }
    const placeholder = makeChar(0xFFFF)
    const app = ThwimpAppearance.fromTables(new Map(), tables, placeholder)
    // attr=0, palette=8+(0>>1 & 7)=8, charHigh=0
    expect(app.parts[0].palette).toBe(8)
    // All parts use placeholder since chars is empty
    expect(app.parts.every(p => p.char === placeholder)).toBe(true)
  })

  it('chars missing key → ?? placeholder used for all 4 corners', () => {
    const tables = makeTables({ attrByte: 0x02, tilemapOffset: 0, tilemap: [0x67, 0x69, 0x88, 0xCE] })
    const placeholder = makeChar(0xFFFF)
    const app = ThwimpAppearance.fromTables(new Map(), tables, placeholder)
    expect(app.parts.every(p => p.char === placeholder)).toBe(true)
  })
})
