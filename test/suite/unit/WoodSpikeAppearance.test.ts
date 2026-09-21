/**
 * WoodSpikeAppearance - locks the 5-tile vertical layout for sprites $AC/$AD.
 *
 * WoodSpikeGfx (bank_03.asm:2669) draws 5 stacked 16×16 tiles per sprite,
 * indexed by SpriteNumber (slot 0-9).
 *   WoodSpikeTiles:   db $6A,$6A,$6A,$6A,$4A,$6A,$6A,$6A,$6A,$4A
 *   WoodSpikeDispY:   db $00,$10,$20,$30,$40,$40,$30,$20,$10,$00
 *   WoodSpikeGfxProp: db $81,$81,$81,$81,$81,$01,$01,$01,$01,$01
 *
 * $AC (indices 0-4, all V-flip, prop $81):
 *   InitWoodSpike (bank_01.asm:488) subtracts $40 from sprite Y. Effective
 *   dy offsets relative to spawn:
 *     tiles 0-3 = body ($6A) at dy -64, -48, -32, -16
 *     tile  4   = tip  ($4A) at dy 0   ← anchor
 *
 * $AD (indices 5-9, no flip, prop $01):
 *   InitMontyMole (bank_01.asm:730) leaves Y unchanged. Effective offsets:
 *     tile  0   = tip  ($4A) at dy 0   ← anchor
 *     tiles 1-4 = body ($6A) at dy 16, 32, 48, 64
 *
 * charHigh = WoodSpikeGfxProp bit 0 = 1 → $100.
 * palette  = WoodSpikeGfxProp bits[3:1] = 0 → CGRAM row 8.
 *
 * Test tree
 * ---------
 *   $AC (hanging spike, V-flip)
 *   - 20 parts (5 tiles x 4 corners)
 *   - all: palette=8, flipX=false, flipY=true
 *   - body tiles (V-flip): BL/BR/TL/TR layout at dy -64/-48/-32/-16
 *   - tip tile (V-flip):   BL/BR/TL/TR layout at dy 0
 *   $AD (ground spike, no flip)
 *   - 20 parts
 *   - all: palette=8, flipX=false, flipY=false
 *   - tip tile (no flip):  TL/TR/BL/BR layout at dy 0
 *   - body tiles (no flip): TL/TR/BL/BR layout at dy 16/32/48/64
 */
import { describe, expect, it } from 'vitest'
import { Char } from '../../../src/rom/model/chars/Char'
import {
  WOOD_SPIKE_BODY_TILE,
  WOOD_SPIKE_CHAR_HIGH,
  WOOD_SPIKE_PALETTE,
  WOOD_SPIKE_TIP_TILE,
  WoodSpikeAppearance,
} from '../../../src/rom/model/sprites/appearances/WoodSpikeAppearance'

const OBJ_BASE = 0x400

function syntheticChar(id: number): Char {
  return new Char(id, { getPixels: () => new Uint8Array(64) })
}
const placeholder = syntheticChar(-1)

function buildChars(): Map<number, Char> {
  const map = new Map<number, Char>()
  for (let id = 0; id < 0xc00; id++) map.set(id, syntheticChar(id))
  return map
}

function charId(tileBase: number, cornerOffset: number): number {
  return OBJ_BASE + WOOD_SPIKE_CHAR_HIGH + tileBase + cornerOffset
}

function tileParts(parts: WoodSpikeAppearance['parts'], tileIdx: number) {
  return parts.slice(tileIdx * 4, tileIdx * 4 + 4)
}

describe('WoodSpikeAppearance - $AC (hanging spike, V-flip)', () => {
  const a = WoodSpikeAppearance.fromTables(buildChars(), 0xac, placeholder)

  it('produces 20 parts', () => {
    expect(a.parts).toHaveLength(20)
  })

  it('all parts have palette=8, flipX=false, flipY=true', () => {
    for (const p of a.parts) {
      expect(p.palette).toBe(WOOD_SPIKE_PALETTE)
      expect(p.flipX).toBe(false)
      expect(p.flipY).toBe(true)
    }
  })

  // V-flip layout: BL at (dx,dy), BR at (dx+8,dy), TL at (dx,dy+8), TR at (dx+8,dy+8)
  it.each([
    [0, -64, WOOD_SPIKE_BODY_TILE],
    [1, -48, WOOD_SPIKE_BODY_TILE],
    [2, -32, WOOD_SPIKE_BODY_TILE],
    [3, -16, WOOD_SPIKE_BODY_TILE],
    [4, 0, WOOD_SPIKE_TIP_TILE],
  ] as const)(
    'tile %i at tileY=%i uses correct chars (V-flip layout)',
    (tileIdx, tileY, tileBase) => {
      const t = tileParts(a.parts, tileIdx)
      expect(t[0]).toMatchObject({ char: { id: charId(tileBase, 0x10) }, dx: 0, dy: tileY })
      expect(t[1]).toMatchObject({ char: { id: charId(tileBase, 0x11) }, dx: 8, dy: tileY })
      expect(t[2]).toMatchObject({ char: { id: charId(tileBase, 0x00) }, dx: 0, dy: tileY + 8 })
      expect(t[3]).toMatchObject({ char: { id: charId(tileBase, 0x01) }, dx: 8, dy: tileY + 8 })
    },
  )
})

describe('WoodSpikeAppearance - extendDir', () => {
  it('$AC: extendDir = +1 (extends down from ceiling)', () => {
    expect(WoodSpikeAppearance.fromTables(buildChars(), 0xac, placeholder).extendDir).toBe(1)
  })

  it('$AD odd col (spriteMisc151C≠0): extendDir = -1 (extends up from floor)', () => {
    expect(WoodSpikeAppearance.fromTables(buildChars(), 0xad, placeholder, 0x10).extendDir).toBe(-1)
  })

  it('$AD even col (spriteMisc151C=0): extendDir = +1 (retracts underground first)', () => {
    expect(WoodSpikeAppearance.fromTables(buildChars(), 0xad, placeholder, 0).extendDir).toBe(1)
  })
})

describe('WoodSpikeAppearance - animation cycle', () => {
  it('$AC starts at cycleTick=0, dyMove=0 (retracted)', () => {
    const a = WoodSpikeAppearance.fromTables(buildChars(), 0xac, placeholder)
    expect(a.cycleTick).toBe(0)
    expect(a.dyMove).toBe(0)
  })

  it('$AD spriteMisc151C=0 starts at tick 0, dyMove=0 (retracted, even column)', () => {
    const a = WoodSpikeAppearance.fromTables(buildChars(), 0xad, placeholder, 0)
    expect(a.cycleTick).toBe(0)
    expect(a.dyMove).toBe(0)
  })

  it('$AD spriteMisc151C≠0 starts at tick 0, dyMove=0 (retracted, odd column)', () => {
    const a = WoodSpikeAppearance.fromTables(buildChars(), 0xad, placeholder, 0x10)
    expect(a.cycleTick).toBe(0)
    expect(a.dyMove).toBe(0)
  })

  // 21-tick cycle: 6 hold-retracted → 3 extend → 6 hold-extended → 6 retract.
  // EXTEND_RANGE = 48 px, extend step = 16 px/tick, retract step = 8 px/tick.
  it.each([
    [6, 16],
    [7, 32],
    [8, 48],
    [9, 48],
    [14, 48],
    [15, 40],
    [16, 32],
    [17, 24],
    [18, 16],
    [19, 8],
    [20, 0],
  ] as const)('after %i ticks dyMove = %i', (ticks, expected) => {
    const a = WoodSpikeAppearance.fromTables(buildChars(), 0xac, placeholder)
    for (let i = 0; i < ticks; i++) a.tickAnimation()
    expect(a.dyMove).toBe(expected)
  })

  it('cycle wraps at 21 ticks back to cycleTick=0, dyMove=0', () => {
    const a = WoodSpikeAppearance.fromTables(buildChars(), 0xac, placeholder)
    for (let i = 0; i < 21; i++) a.tickAnimation()
    expect(a.cycleTick).toBe(0)
    expect(a.dyMove).toBe(0)
  })
})

describe('WoodSpikeAppearance - $AD (ground spike, no flip)', () => {
  const a = WoodSpikeAppearance.fromTables(buildChars(), 0xad, placeholder)

  it('produces 20 parts', () => {
    expect(a.parts).toHaveLength(20)
  })

  it('all parts have palette=8, flipX=false, flipY=false', () => {
    for (const p of a.parts) {
      expect(p.palette).toBe(WOOD_SPIKE_PALETTE)
      expect(p.flipX).toBe(false)
      expect(p.flipY).toBe(false)
    }
  })

  // Normal layout: TL at (dx,dy), TR at (dx+8,dy), BL at (dx,dy+8), BR at (dx+8,dy+8)
  it.each([
    [0, 0, WOOD_SPIKE_TIP_TILE],
    [1, 16, WOOD_SPIKE_BODY_TILE],
    [2, 32, WOOD_SPIKE_BODY_TILE],
    [3, 48, WOOD_SPIKE_BODY_TILE],
    [4, 64, WOOD_SPIKE_BODY_TILE],
  ] as const)(
    'tile %i at tileY=%i uses correct chars (normal layout)',
    (tileIdx, tileY, tileBase) => {
      const t = tileParts(a.parts, tileIdx)
      expect(t[0]).toMatchObject({ char: { id: charId(tileBase, 0x00) }, dx: 0, dy: tileY })
      expect(t[1]).toMatchObject({ char: { id: charId(tileBase, 0x01) }, dx: 8, dy: tileY })
      expect(t[2]).toMatchObject({ char: { id: charId(tileBase, 0x10) }, dx: 0, dy: tileY + 8 })
      expect(t[3]).toMatchObject({ char: { id: charId(tileBase, 0x11) }, dx: 8, dy: tileY + 8 })
    },
  )
})
