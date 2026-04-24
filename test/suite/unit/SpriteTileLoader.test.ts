import { describe, it, expect } from 'vitest'
import { buildSpriteLayout, type SpriteTileTables } from '../../../src/rom/SpriteTileLoader'
import { makePlaceholderBoxChar } from '../../../src/rom/model/tiles/TileFactory'
import { StaticPixelsBehavior } from '../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'

function makeTables(overrides: Partial<SpriteTileTables> = {}): SpriteTileTables {
  const tilemap = new Uint8Array(0xFC)
  const tilemapOffset = new Uint8Array(0x54)
  const spriteAttr = new Uint8Array(0x100)
  const spr0to13Prop = new Uint8Array(0x14)
  // GeneralSprDispX/Y from bank_01.asm:3842-3846
  return {
    tilemap,
    tilemapOffset,
    dispX: [0, 8, 0, 8],
    dispY: [0, 0, 8, 8],
    spriteAttr,
    spr0to13Prop,
    ...overrides,
  }
}

describe('buildSpriteLayout', () => {
  it('returns null for sprite IDs outside the supported range', () => {
    const tables = makeTables()
    // 0x54-0xC8 are handled by SPRITE_BASE_TILE_OVERRIDES (if the ID has an
    // entry in that table). Negative IDs and IDs > 0xC8 always return null.
    expect(buildSpriteLayout(tables, -1)).toBeNull()
    expect(buildSpriteLayout(tables, 0xD0)).toBeNull()
    expect(buildSpriteLayout(tables, 0xFF)).toBeNull()
  })

  it('renders override-tabled sprites 0x54-0xC8 as 16x16 big-tiles', () => {
    // 0x70 (Pokey) maps to base char $E8 in the override table.
    const tables = makeTables()
    const layout = buildSpriteLayout(tables, 0x70)!
    expect(layout.height).toBe(16)
    expect(layout.tiles).toHaveLength(4)
    expect(layout.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0xE8, 0x400 + 0xE9, 0x400 + 0xF8, 0x400 + 0xF9,
    ])
  })

  it('expands one base tile N into chars [N, N+1, N+$10, N+$11]', () => {
    // SubSprGfx2Entry1: the base char at tilemap[offset] drives a 16x16
    // large-tile which the SNES expands to a 2x2 block of 8x8 chars.
    const tilemap = new Uint8Array(0xFC)
    const tilemapOffset = new Uint8Array(0x54)
    tilemapOffset[0x05] = 0x20
    tilemap[0x20] = 0x82                 // base char N

    const tables = makeTables({ tilemap, tilemapOffset })
    const layout = buildSpriteLayout(tables, 0x05)
    expect(layout).not.toBeNull()
    expect(layout!.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0x82,   // TL = N
      0x400 + 0x83,   // TR = N+1
      0x400 + 0x92,   // BL = N+$10
      0x400 + 0x93,   // BR = N+$11
    ])
  })

  it('places corners at (0,0), (8,0), (0,8), (8,8)', () => {
    const tables = makeTables()
    const layout = buildSpriteLayout(tables, 0x00)!
    expect(layout.tiles.map(t => [t.dx, t.dy])).toEqual([
      [0, 0], [8, 0], [0, 8], [8, 8],
    ])
  })

  it('decodes palette (bits 3-1) and char-high (bit 0) from the low-nibble attr', () => {
    const spriteAttr = new Uint8Array(0x100)
    // Low nibble 0b0101 = palette 2 + char high. readSpriteTileTables already
    // ANDs Sprite166EVals with $0F before reaching us; upper nibble is ignored.
    spriteAttr[0x10] = 0x05
    const tables = makeTables({ spriteAttr })
    const layout = buildSpriteLayout(tables, 0x10)!
    for (const t of layout.tiles) {
      expect(t.palette).toBe(8 + 2)
      expect(t.charNum).toBeGreaterThanOrEqual(0x500)   // char-high adds $100
      expect(t.flipX).toBe(false)
      expect(t.flipY).toBe(false)
    }
  })

  it('defaults to palette 8 and no flip when attr is 0', () => {
    const tables = makeTables()
    const layout = buildSpriteLayout(tables, 0x00)!
    expect(layout.tiles[0].palette).toBe(8)
    expect(layout.tiles[0].flipX).toBe(false)
    expect(layout.tiles[0].flipY).toBe(false)
  })

  it('emits height=16 for short SubSprGfx2 sprites', () => {
    const tables = makeTables()
    const layout = buildSpriteLayout(tables, 0x0F)!   // Goomba (short per Spr0to13Prop)
    expect(layout.height).toBe(16)
    expect(layout.tiles).toHaveLength(4)
    for (const t of layout.tiles) expect(t.dy).toBeGreaterThanOrEqual(0)
  })

  it('emits height=32 with 8 corners for Spr0to13 tall sprites (bit 6 set)', () => {
    // Sprite $05 (Red Koopa with shell): Spr0to13Prop = $42 → bit 6 set.
    const tilemap = new Uint8Array(0xFC)
    const tilemapOffset = new Uint8Array(0x54)
    const spr0to13Prop = new Uint8Array(0x14)
    tilemapOffset[0x05] = 0x00
    tilemap[0x00] = 0x82   // top tile (shell)
    tilemap[0x01] = 0xA0   // bottom tile (legs)
    spr0to13Prop[0x05] = 0x42

    const tables = makeTables({ tilemap, tilemapOffset, spr0to13Prop })
    const layout = buildSpriteLayout(tables, 0x05)!
    expect(layout.height).toBe(32)
    expect(layout.tiles).toHaveLength(8)
    // Top big-tile chars at dy -16..-8 (dispY 0/0/8/8 + base -16)
    const topTiles = layout.tiles.slice(0, 4)
    expect(topTiles.map(t => t.charNum)).toEqual([
      0x400 + 0x82, 0x400 + 0x83, 0x400 + 0x92, 0x400 + 0x93,
    ])
    expect(topTiles.map(t => t.dy)).toEqual([-16, -16, -8, -8])
    // Bottom big-tile at dy 0..8
    const bottomTiles = layout.tiles.slice(4, 8)
    expect(bottomTiles.map(t => t.charNum)).toEqual([
      0x400 + 0xA0, 0x400 + 0xA1, 0x400 + 0xB0, 0x400 + 0xB1,
    ])
    expect(bottomTiles.map(t => t.dy)).toEqual([0, 0, 8, 8])
  })

  it('emits height=32 for Green Para-Koopas $08/$09 (prop $50 has bit 6 set)', () => {
    // Sprites $08 and $09 use GreenParaKoopa → JMP Spr0to13Gfx (bank_01.asm:1868).
    // Spr0to13Prop[$08/$09] = $50; $50 & $40 = $40 ≠ 0 → TALL 16x32 via SubSprGfx1.
    const tilemap = new Uint8Array(0xFC)
    const tilemapOffset = new Uint8Array(0x54)
    const spr0to13Prop = new Uint8Array(0x14)
    tilemapOffset[0x08] = 0x00
    tilemapOffset[0x09] = 0x00
    tilemap[0x00] = 0x82   // top tile (shell)
    tilemap[0x01] = 0xA0   // bottom tile (legs)
    spr0to13Prop[0x08] = 0x50
    spr0to13Prop[0x09] = 0x50
    const tables = makeTables({ tilemap, tilemapOffset, spr0to13Prop })
    for (const id of [0x08, 0x09]) {
      const layout = buildSpriteLayout(tables, id)!
      expect(layout.height, `sprite $0${id.toString(16)}`).toBe(32)
      expect(layout.tiles).toHaveLength(8)
    }
  })

  it('uses SubSprGfx0 (4 independent chars) for sprite $4D (Monty Mole)', () => {
    // Monty Mole is in the SPRITE_GFX_OVERRIDES table with routine 'sub0'.
    // Each of its 4 corners picks its own char from SprTilemap[offset+0..3],
    // not a base-char expansion like SubSprGfx2.
    const tilemap = new Uint8Array(0xFC)
    const tilemapOffset = new Uint8Array(0x54)
    tilemapOffset[0x4D] = 0x20
    tilemap[0x20] = 0x11   // TL
    tilemap[0x21] = 0x22   // TR
    tilemap[0x22] = 0x33   // BL
    tilemap[0x23] = 0x44   // BR

    const tables = makeTables({ tilemap, tilemapOffset })
    const layout = buildSpriteLayout(tables, 0x4D)!
    expect(layout.height).toBe(16)
    expect(layout.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0x11, 0x400 + 0x22, 0x400 + 0x33, 0x400 + 0x44,
    ])
  })

  it('maps shell sprite $DB to Koopa $05 and draws the stunned-shell tile', () => {
    // $DB (Red shell) → SpriteNumber aliased to $05 and SpriteStatus forced to
    // $09 (bank_02.asm:5339-5362, 5454-5462). The stunned path CODE_019806
    // (bank_01.asm:3313) sets SpriteMisc1602=$06, then SubSprGfx2Entry1
    // (bank_01.asm:4148) draws SprTilemap[SprTilemapOffset[$05] + $06] — NOT
    // the Koopa's walking top tile. In vanilla ROMs that resolves to $8C, the
    // shell-on-ground graphic.
    const tilemap = new Uint8Array(0xFC)
    const tilemapOffset = new Uint8Array(0x54)
    const spriteAttr = new Uint8Array(0x100)
    tilemapOffset[0x05] = 0x00
    tilemap[0x00] = 0x82   // walking Koopa top (must NOT be picked)
    tilemap[0x01] = 0xA0   // walking Koopa legs (must NOT be picked)
    tilemap[0x06] = 0x8C   // stationary shell at offset $06 — this is the one
    spriteAttr[0x05] = 0x08   // Sprite166EVals[$05] & $0F — palette 4, charHigh 0

    const tables = makeTables({ tilemap, tilemapOffset, spriteAttr })
    const layout = buildSpriteLayout(tables, 0xDB)!
    expect(layout.height).toBe(16)
    expect(layout.tiles).toHaveLength(4)
    expect(layout.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0x8C, 0x400 + 0x8D, 0x400 + 0x9C, 0x400 + 0x9D,
    ])
    expect(layout.tiles.map(t => t.dy)).toEqual([0, 0, 8, 8])
    // Palette derived from aliased Koopa attr (not the shell's Sprite166EVals).
    expect(layout.tiles.every(t => t.palette === 8 + 4)).toBe(true)
  })

  it('renders Thwomp ($26) as a 32x32 wide sprite with 4 big-tiles', () => {
    const tables = makeTables()
    const layout = buildSpriteLayout(tables, 0x26)!
    expect(layout.width).toBe(32)
    expect(layout.height).toBe(32)
    expect(layout.tiles).toHaveLength(16)
    // TL quadrant: tile $8E, no flip, corners at dx [0,8,0,8]
    const tl = layout.tiles.slice(0, 4)
    expect(tl.map(t => t.charNum)).toEqual([0x48E, 0x48F, 0x49E, 0x49F])
    expect(tl.every(t => !t.flipX)).toBe(true)
    // TR quadrant: tile $8E with flipX — corner order swapped → [0x8F,0x8E,0x9F,0x9E]
    const tr = layout.tiles.slice(4, 8)
    expect(tr.map(t => t.charNum)).toEqual([0x48F, 0x48E, 0x49F, 0x49E])
    expect(tr.every(t => t.flipX)).toBe(true)
    expect(tr.map(t => t.dx)).toEqual([16, 24, 16, 24])
    // BL quadrant: tile $AE, no flip
    const bl = layout.tiles.slice(8, 12)
    expect(bl.map(t => t.charNum)).toEqual([0x4AE, 0x4AF, 0x4BE, 0x4BF])
    expect(bl.every(t => !t.flipX)).toBe(true)
    expect(bl.map(t => t.dy)).toEqual([16, 16, 24, 24])
  })

  it('stays short for sprites in the Spr0to13 range that aren\'t routed through Spr0to13Start', () => {
    // ShellessKoopas (0x00-0x03) share the prop-table index but use their own
    // handler — the bit 6 check shouldn't promote them to tall.
    const spr0to13Prop = new Uint8Array(0x14)
    spr0to13Prop[0x00] = 0x42   // bit 6 set, but $00 isn't Spr0to13Start
    const tables = makeTables({ spr0to13Prop })
    const layout = buildSpriteLayout(tables, 0x00)!
    expect(layout.height).toBe(16)
  })

  // IDs 0xC9-0xFF (beyond the dispatch table) have no visual tile — they
  // render as placeholder boxes via SpriteFactory. Confirm null here so the
  // two paths stay in sync: any change to the table boundary is caught.
  const generatorNullCases: Array<{ name: string; id: number }> = [
    { name: '0xC9 layer-2 smash (generator, no tile)',  id: 0xC9 },
    { name: '0xCA layer-2 scroll left (generator)',     id: 0xCA },
    { name: '0xCB layer-2 scroll right (generator)',    id: 0xCB },
    { name: '0xCF layer-2 scroll up (generator)',       id: 0xCF },
    { name: '0xE7 last generator-range ID',             id: 0xE7 },
    { name: '0xE8 beyond dispatch table',               id: 0xE8 },
    { name: '0xFF no sprite at this ID',                id: 0xFF },
  ]
  for (const tc of generatorNullCases) {
    it(`returns null for ${tc.name}`, () => {
      expect(buildSpriteLayout(makeTables(), tc.id)).toBeNull()
    })
  }
})

describe('makePlaceholderBoxChar', () => {
  it('has id -2', () => {
    expect(makePlaceholderBoxChar().id).toBe(-2)
  })

  it('draws a border frame with palette index 3 and transparent interior', () => {
    const char = makePlaceholderBoxChar()
    expect(char.behavior).toBeInstanceOf(StaticPixelsBehavior)
    const pixels = (char.behavior as StaticPixelsBehavior).pixels
    // Top and bottom rows are all 3
    for (let x = 0; x < 8; x++) {
      expect(pixels[x]).toBe(3)       // top row
      expect(pixels[56 + x]).toBe(3)  // bottom row
    }
    // Left and right columns are 3, interior edges are 0
    for (let y = 1; y <= 6; y++) {
      expect(pixels[y * 8]).toBe(3)       // left col
      expect(pixels[y * 8 + 7]).toBe(3)   // right col
      expect(pixels[y * 8 + 1]).toBe(0)   // interior
      expect(pixels[y * 8 + 6]).toBe(0)   // interior
    }
  })
})
