import { describe, it, expect } from 'vitest'
import { buildSpriteLayout, type SpriteTileTables } from '../../../src/rom/SpriteTileLoader'
import type { GfxRoutine, GfxRoutineReading } from '../../../src/rom/dispatch/GfxRoutineReader'
import { makePlaceholderBoxChar } from '../../../src/rom/model/tiles/TileFactory'
import { StaticPixelsBehavior } from '../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'

function makeTables(overrides: Partial<SpriteTileTables> = {}): SpriteTileTables {
  const tilemap = new Uint8Array(0xfc)
  const tilemapOffset = new Uint8Array(0x54)
  const spriteAttr = new Uint8Array(0x100)
  const spr0to13Prop = new Uint8Array(0x14)
  // GeneralSprDispX/Y/GfxProp from bank_01.asm:3842-3851
  const gfxProp = [
    0x00,
    0x00,
    0x00,
    0x00, // group 0: no flips
    0x00,
    0x40,
    0x00,
    0x40, // group 1: TR/BR flipX
    0x00,
    0x40,
    0x80,
    0xc0, // group 2: TR flipX, BL flipY, BR both
    0x40,
    0x40,
    0x00,
    0x00, // group 3: TL/TR flipX
    0x40,
    0x00,
    0xc0,
    0x80, // group 4: TL flipX, BL both, BR flipY
    0x40,
    0x40,
    0x40,
    0x40, // group 5: all flipX
  ]
  return {
    tilemap,
    tilemapOffset,
    dispX: [0, 8, 0, 8],
    dispY: [0, 0, 8, 8],
    gfxProp,
    spriteAttr,
    spr0to13Prop,
    yoshiPal: new Uint8Array(4),
    ...overrides,
  }
}

/** Stand-in for what `readSpriteTileTables` attaches from a real cart, so a
 *  hand-built table can exercise the live path rather than the residue. */
function liveRoutines(entries: Record<number, GfxRoutine>): ReadonlyMap<number, GfxRoutineReading> {
  return new Map(
    Object.entries(entries).map(([id, routine]) => [
      Number(id),
      {
        kind: 'read',
        routine,
        callAt: 0,
        site: { at: 0, via: 'direct' },
      } as GfxRoutineReading,
    ]),
  )
}

describe('buildSpriteLayout', () => {
  it('returns null for sprite IDs outside the supported range', () => {
    const tables = makeTables()
    // 0x54-0xC8 are handled by SPRITE_BASE_TILE_OVERRIDES (if the ID has an
    // entry in that table). Negative IDs and IDs > 0xC8 always return null.
    expect(buildSpriteLayout(tables, -1)).toBeNull()
    expect(buildSpriteLayout(tables, 0xd0)).toBeNull()
    expect(buildSpriteLayout(tables, 0xff)).toBeNull()
  })

  it('renders override-tabled sprites 0x54-0xC8 as 16x16 big-tiles', () => {
    // 0x70 (Pokey) maps to base char $E8 in the override table.
    const tables = makeTables()
    const layout = buildSpriteLayout(tables, 0x70)!
    expect(layout.height).toBe(16)
    expect(layout.tiles).toHaveLength(4)
    expect(layout.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0xe8,
      0x400 + 0xe9,
      0x400 + 0xf8,
      0x400 + 0xf9,
    ])
  })

  it('expands one base tile N into chars [N, N+1, N+$10, N+$11]', () => {
    // SubSprGfx2Entry1: the base char at tilemap[offset] drives a 16x16
    // large-tile which the SNES expands to a 2x2 block of 8x8 chars.
    const tilemap = new Uint8Array(0xfc)
    const tilemapOffset = new Uint8Array(0x54)
    tilemapOffset[0x05] = 0x20
    tilemap[0x20] = 0x82 // base char N

    const tables = makeTables({ tilemap, tilemapOffset })
    const layout = buildSpriteLayout(tables, 0x05)
    expect(layout).not.toBeNull()
    expect(layout!.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0x82, // TL = N
      0x400 + 0x83, // TR = N+1
      0x400 + 0x92, // BL = N+$10
      0x400 + 0x93, // BR = N+$11
    ])
  })

  it('places corners at (0,0), (8,0), (0,8), (8,8)', () => {
    const tables = makeTables()
    const layout = buildSpriteLayout(tables, 0x00)!
    expect(layout.tiles.map(t => [t.dx, t.dy])).toEqual([
      [0, 0],
      [8, 0],
      [0, 8],
      [8, 8],
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
      expect(t.charNum).toBeGreaterThanOrEqual(0x500) // char-high adds $100
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
    const layout = buildSpriteLayout(tables, 0x0f)! // Goomba (short per Spr0to13Prop)
    expect(layout.height).toBe(16)
    expect(layout.tiles).toHaveLength(4)
    for (const t of layout.tiles) expect(t.dy).toBeGreaterThanOrEqual(0)
  })

  it('emits height=32 with 8 corners for Spr0to13 tall sprites (bit 6 set)', () => {
    // Sprite $05 (Red Koopa with shell): Spr0to13Prop = $42 → bit 6 set.
    const tilemap = new Uint8Array(0xfc)
    const tilemapOffset = new Uint8Array(0x54)
    const spr0to13Prop = new Uint8Array(0x14)
    tilemapOffset[0x05] = 0x00
    tilemap[0x00] = 0x82 // top tile (shell)
    tilemap[0x01] = 0xa0 // bottom tile (legs)
    spr0to13Prop[0x05] = 0x42

    const tables = makeTables({ tilemap, tilemapOffset, spr0to13Prop })
    const layout = buildSpriteLayout(tables, 0x05)!
    expect(layout.height).toBe(32)
    expect(layout.tiles).toHaveLength(8)
    // Top big-tile chars at dy -16..-8 (dispY 0/0/8/8 + base -16)
    const topTiles = layout.tiles.slice(0, 4)
    expect(topTiles.map(t => t.charNum)).toEqual([
      0x400 + 0x82,
      0x400 + 0x83,
      0x400 + 0x92,
      0x400 + 0x93,
    ])
    expect(topTiles.map(t => t.dy)).toEqual([-16, -16, -8, -8])
    // Bottom big-tile at dy 0..8
    const bottomTiles = layout.tiles.slice(4, 8)
    expect(bottomTiles.map(t => t.charNum)).toEqual([
      0x400 + 0xa0,
      0x400 + 0xa1,
      0x400 + 0xb0,
      0x400 + 0xb1,
    ])
    expect(bottomTiles.map(t => t.dy)).toEqual([0, 0, 8, 8])
  })

  it('emits height=32 for Green Para-Koopas $08/$09 (prop $50 has bit 6 set)', () => {
    // Sprites $08 and $09 use GreenParaKoopa → JMP Spr0to13Gfx (bank_01.asm:1868).
    // Spr0to13Prop[$08/$09] = $50; $50 & $40 = $40 ≠ 0 → TALL 16x32 via SubSprGfx1.
    const tilemap = new Uint8Array(0xfc)
    const tilemapOffset = new Uint8Array(0x54)
    const spr0to13Prop = new Uint8Array(0x14)
    tilemapOffset[0x08] = 0x00
    tilemapOffset[0x09] = 0x00
    tilemap[0x00] = 0x82 // top tile (shell)
    tilemap[0x01] = 0xa0 // bottom tile (legs)
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
    // Monty Mole stays in SPRITE_GFX_OVERRIDES: its draw call is behind a
    // JSL ExecutePtr, so no reading is attached and the residue answers.
    // Each of its 4 corners picks its own char from SprTilemap[offset+0..3],
    // not a base-char expansion like SubSprGfx2.
    const tilemap = new Uint8Array(0xfc)
    const tilemapOffset = new Uint8Array(0x54)
    tilemapOffset[0x4d] = 0x20
    tilemap[0x20] = 0x11 // TL
    tilemap[0x21] = 0x22 // TR
    tilemap[0x22] = 0x33 // BL
    tilemap[0x23] = 0x44 // BR

    const tables = makeTables({ tilemap, tilemapOffset })
    const layout = buildSpriteLayout(tables, 0x4d)!
    expect(layout.height).toBe(16)
    expect(layout.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0x11,
      0x400 + 0x22,
      0x400 + 0x33,
      0x400 + 0x44,
    ])
  })

  it('keeps a frozen floor for every id, so a broken walk degrades', () => {
    // Removing an id from SPRITE_GFX_OVERRIDES once a cart resolves it
    // live costs nothing until the walk fails on that cart, and then costs
    // the whole layout. $1A is sub1: 32px and 8 tiles, not 16 and 4.
    const tilemap = new Uint8Array(0xfc)
    const tilemapOffset = new Uint8Array(0x54)
    tilemapOffset[0x1a] = 0x30
    tilemap[0x30] = 0x40
    tilemap[0x31] = 0x60
    // No gfxRoutines at all is what a cart the walk cannot read looks like.
    const layout = buildSpriteLayout(makeTables({ tilemap, tilemapOffset }), 0x1a)!
    expect(layout.height).toBe(32)
    expect(layout.tiles).toHaveLength(8)
  })

  /** `SPRITE_GFX_OVERRIDES` in full. Dropping any one row costs that
   *  sprite its whole layout on any cart the walk cannot read, and only
   *  $1A and $4D were pinned before, so fifteen of the seventeen could be
   *  deleted without a test noticing. */
  const FROZEN_FLOOR: ReadonlyArray<readonly [number, GfxRoutine]> = [
    [0x1a, 'sub1'],
    [0x1e, 'sub1'],
    [0x1f, 'sub1'],
    [0x22, 'sub1'],
    [0x23, 'sub1'],
    [0x24, 'sub1'],
    [0x25, 'sub1'],
    [0x2a, 'sub1'],
    [0x41, 'sub1'],
    [0x42, 'sub1'],
    [0x43, 'sub1'],
    [0x14, 'sub0'],
    [0x27, 'sub0'],
    [0x2b, 'sub0'],
    [0x2f, 'sub0'],
    [0x4d, 'sub0'],
    [0x4e, 'sub0'],
  ]

  it('has a frozen floor entry for all seventeen ids, each with its routine', () => {
    expect(FROZEN_FLOOR).toHaveLength(17)
    const wrong: string[] = []
    for (const [id, routine] of FROZEN_FLOOR) {
      const tilemap = new Uint8Array(0xfc)
      const tilemapOffset = new Uint8Array(0x54)
      tilemapOffset[id] = 0x30
      // sub0 takes four independent chars; sub2 expands one base char into
      // [N, N+1, N+$10, N+$11]; sub1 stacks two big tiles into 32px.
      tilemap[0x30] = 0x11
      tilemap[0x31] = 0x22
      tilemap[0x32] = 0x33
      tilemap[0x33] = 0x44
      // No gfxRoutines: what a cart the walk cannot read looks like.
      const l = buildSpriteLayout(makeTables({ tilemap, tilemapOffset }), id)!
      const chars = l.tiles.map(t => t.charNum - 0x400)
      const got = l.height === 32 ? 'sub1' : chars.join(',') === '17,34,51,68' ? 'sub0' : 'sub2'
      if (got !== routine) wrong.push(`$${id.toString(16)} floor=${routine} built=${got}`)
    }
    expect(wrong).toEqual([])
  })

  it('lets the cart override an id that is still in the frozen residue', () => {
    // $4D is one of the four ids the walk cannot reach, so it keeps a
    // frozen 'sub0'. A cart that DOES resolve it must still win: the order
    // of those two lookups is the whole point of keeping the residue small.
    const tilemap = new Uint8Array(0xfc)
    const tilemapOffset = new Uint8Array(0x54)
    tilemapOffset[0x4d] = 0x20
    tilemap[0x20] = 0x11
    tilemap[0x21] = 0x22
    const frozen = buildSpriteLayout(makeTables({ tilemap, tilemapOffset }), 0x4d)!
    expect(frozen.height).toBe(16) // sub0, four 8x8 chars
    const live = buildSpriteLayout(
      makeTables({ tilemap, tilemapOffset, gfxRoutines: liveRoutines({ 0x4d: 'sub1' }) }),
      0x4d,
    )!
    expect(live.height).toBe(32) // sub1, two stacked big-tiles
  })

  it('applies GeneralSprGfxProp flip flags for sub0 sprite $2F (spring)', () => {
    // Spring reaches SubSprGfx0 on the cart, so the reading is supplied here
    // rather than coming from the frozen residue, which no longer lists $2F.
    // propGroup 2 (LDA #$02; JSR SubSprGfx0Entry1, bank_01.asm:13884).
    // Group 2 in GeneralSprGfxProp: TL=$00, TR=$40, BL=$80, BR=$C0 →
    //   TL=no flip, TR=flipX, BL=flipY, BR=flipX+flipY.
    const tilemap = new Uint8Array(0xfc)
    const tilemapOffset = new Uint8Array(0x54)
    tilemapOffset[0x2f] = 0x9a
    for (let i = 0; i < 4; i++) tilemap[0x9a + i] = 0x28 // all same spring tile
    const tables = makeTables({
      tilemap,
      tilemapOffset,
      gfxRoutines: liveRoutines({ 0x2f: 'sub0' }),
    })
    const layout = buildSpriteLayout(tables, 0x2f)!
    expect(layout.height).toBe(16)
    expect(layout.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0x28,
      0x400 + 0x28,
      0x400 + 0x28,
      0x400 + 0x28,
    ])
    expect(layout.tiles.map(t => t.flipX)).toEqual([false, true, false, true])
    expect(layout.tiles.map(t => t.flipY)).toEqual([false, false, true, true])
  })

  it('maps shell sprite $DB to Koopa $05 and draws the stunned-shell tile', () => {
    // $DB (Red shell) → SpriteNumber aliased to $05 and SpriteStatus forced to
    // $09 (bank_02.asm:5339-5362, 5454-5462). The stunned path CODE_019806
    // (bank_01.asm:3313) sets SpriteMisc1602=$06, then SubSprGfx2Entry1
    // (bank_01.asm:4148) draws SprTilemap[SprTilemapOffset[$05] + $06] - NOT
    // the Koopa's walking top tile. In vanilla ROMs that resolves to $8C, the
    // shell-on-ground graphic.
    const tilemap = new Uint8Array(0xfc)
    const tilemapOffset = new Uint8Array(0x54)
    const spriteAttr = new Uint8Array(0x100)
    tilemapOffset[0x05] = 0x00
    tilemap[0x00] = 0x82 // walking Koopa top (must NOT be picked)
    tilemap[0x01] = 0xa0 // walking Koopa legs (must NOT be picked)
    tilemap[0x06] = 0x8c // stationary shell at offset $06 - this is the one
    spriteAttr[0x05] = 0x08 // Sprite166EVals[$05] & $0F - palette 4, charHigh 0

    const tables = makeTables({ tilemap, tilemapOffset, spriteAttr })
    const layout = buildSpriteLayout(tables, 0xdb)!
    expect(layout.height).toBe(16)
    expect(layout.tiles).toHaveLength(4)
    expect(layout.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0x8c,
      0x400 + 0x8d,
      0x400 + 0x9c,
      0x400 + 0x9d,
    ])
    expect(layout.tiles.map(t => t.dy)).toEqual([0, 0, 8, 8])
    // Palette derived from aliased Koopa attr (not the shell's Sprite166EVals).
    expect(layout.tiles.every(t => t.palette === 8 + 4)).toBe(true)
  })

  it('centers $4F Jumping Piranha on its pipe: all parts at dx 8 or 16 (InitPiranha bank_01.asm:880)', () => {
    // InitPiranha: SpriteXPosLow += 8. Both GenericSprGfxRt0/2 are bare wrappers with
    // no extra X offset (bank_01.asm:61/2393). Head is a 16×16 big-tile at SpriteX;
    // body 4 independent 8×8 at same SpriteX. With spawn anchor at s.x*16, all parts
    // must start at dx=8 so the 16px-wide head centers within the 32px pipe
    // (head left=s.x*16+8, right=s.x*16+24, center=s.x*16+16 = pipe center).
    const tables = makeTables()
    const layout = buildSpriteLayout(tables, 0x4f)!
    expect(layout).not.toBeNull()
    expect(layout.tiles).toHaveLength(8)
    // body parts (0..3) and head parts (4..7) - every left-edge at dx 8 or 16
    expect(layout.tiles.map(t => t.dx)).toEqual([8, 16, 8, 16, 8, 16, 8, 16])
  })
  it('renders Goal Tape ($7B) as three 8x8 tiles at dx=-8/0/+8, dy=+8, CGRAM row 9', () => {
    // CODE_01C12D (bank_01.asm:8865-8896): three extra-OAM 8×8 entries, not a 16×16
    // big-tile. X offsets −8/0/+8 from anchor; Y offset +8. Tiles $D4 (left cap),
    // $D5 (middle), $D5 (right). Attr $32 hardcoded → low nibble $02 → ppp=001 →
    // CGRAM row 9, charHigh=0. No Sprite166EVals involvement.
    const tables = makeTables()
    const layout = buildSpriteLayout(tables, 0x7b)!
    expect(layout).not.toBeNull()
    expect(layout.tiles).toHaveLength(3)
    expect(layout.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0xd4, // left cap
      0x400 + 0xd5, // middle
      0x400 + 0xd5, // right
    ])
    expect(layout.tiles.map(t => t.dx)).toEqual([-8, 0, 8])
    expect(layout.tiles.map(t => t.dy)).toEqual([8, 8, 8])
    expect(layout.tiles.every(t => t.palette === 9)).toBe(true)
    expect(layout.tiles.every(t => !t.flipX && !t.flipY)).toBe(true)
  })

  it('renders Thwomp ($26) as a 32x32 wide sprite with 4 big-tiles', () => {
    const tables = makeTables()
    const layout = buildSpriteLayout(tables, 0x26)!
    expect(layout.width).toBe(32)
    expect(layout.height).toBe(32)
    expect(layout.tiles).toHaveLength(16)
    // TL quadrant: tile $8E, no flip, corners at dx [0,8,0,8]
    const tl = layout.tiles.slice(0, 4)
    expect(tl.map(t => t.charNum)).toEqual([0x48e, 0x48f, 0x49e, 0x49f])
    expect(tl.every(t => !t.flipX)).toBe(true)
    // TR quadrant: tile $8E with flipX - corner order swapped → [0x8F,0x8E,0x9F,0x9E]
    const tr = layout.tiles.slice(4, 8)
    expect(tr.map(t => t.charNum)).toEqual([0x48f, 0x48e, 0x49f, 0x49e])
    expect(tr.every(t => t.flipX)).toBe(true)
    expect(tr.map(t => t.dx)).toEqual([16, 24, 16, 24])
    // BL quadrant: tile $AE, no flip
    const bl = layout.tiles.slice(8, 12)
    expect(bl.map(t => t.charNum)).toEqual([0x4ae, 0x4af, 0x4be, 0x4bf])
    expect(bl.every(t => !t.flipX)).toBe(true)
    expect(bl.map(t => t.dy)).toEqual([16, 16, 24, 24])
  })

  it("stays short for sprites in the Spr0to13 range that aren't routed through Spr0to13Start", () => {
    // ShellessKoopas (0x00-0x03) share the prop-table index but use their own
    // handler - the bit 6 check shouldn't promote them to tall.
    const spr0to13Prop = new Uint8Array(0x14)
    spr0to13Prop[0x00] = 0x42 // bit 6 set, but $00 isn't Spr0to13Start
    const tables = makeTables({ spr0to13Prop })
    const layout = buildSpriteLayout(tables, 0x00)!
    expect(layout.height).toBe(16)
  })

  it('renders Para-Goomba ($3F) as h-flipped parachute above + 4-char body at anchor', () => {
    // ParachuteSprites (bank_01.asm:11558) draws two OAM units:
    //   parachute via SubSprGfx2Entry1 (SpriteMisc1602=$0D added directly to tilemapBase),
    //   body via SubSprGfx0 (4 explicit chars from SprTilemap[tilemapBase..+3]).
    // Sprite166EVals[$3F]=$05 → attr=$05, palette OBJ2/row10, charHigh=1.
    // Parachute OBJAttr: (attr & $F1)|$06 → palette OBJ3/row11, charHigh=1.
    // DATA_01D56E[0]=$00 → carry=0 → EOR OBJ_XFlip → parachute h-flipped.
    // DATA_01D5B0[0]=$01 → GeneralSprGfxProp[$04..$07]={$00,$40,$00,$40} → flipX right column.
    const tilemap = new Uint8Array(0xfc)
    const tilemapOffset = new Uint8Array(0x54)
    const spriteAttr = new Uint8Array(0x100)
    tilemapOffset[0x3f] = 0x17
    tilemap[0x17] = 0xa3 // body TL
    tilemap[0x18] = 0xa3 // body TR
    tilemap[0x19] = 0xb3 // body BL
    tilemap[0x1a] = 0xb3 // body BR
    tilemap[0x24] = 0xe6 // parachute char at tilemapBase+$0D = $17+$0D = $24
    spriteAttr[0x3f] = 0x05 // charHigh=1, palette=OBJ2

    const tables = makeTables({ tilemap, tilemapOffset, spriteAttr })
    const layout = buildSpriteLayout(tables, 0x3f)!
    expect(layout.height).toBe(32)
    expect(layout.tiles).toHaveLength(8)

    // Parachute: h-flipped big-tile - TL←orig_TR, TR←orig_TL, BL←orig_BR, BR←orig_BL
    const para = layout.tiles.slice(0, 4)
    expect(para.map(t => t.charNum)).toEqual([
      0x400 + 0x100 + 0xe7, // TL ← original TR (base+1)
      0x400 + 0x100 + 0xe6, // TR ← original TL (base+0)
      0x400 + 0x100 + 0xf7, // BL ← original BR (base+$11)
      0x400 + 0x100 + 0xf6, // BR ← original BL (base+$10)
    ])
    expect(para.every(t => t.palette === 11)).toBe(true)
    expect(para.every(t => t.flipX)).toBe(true)
    // Parachute at ORIGINAL_X (dx=0), ORIGINAL_Y−16 (dy=−16). X is unmodified at draw time.
    expect(para.map(t => t.dx)).toEqual([0, 8, 0, 8])
    expect(para.map(t => t.dy)).toEqual([-16, -16, -8, -8])

    // Body: drawn at ORIGINAL_X−8 (dx=−8), ORIGINAL_Y−2 (dy=−2).
    // DATA_01D57E[0]=$F8=−8 shifts body X; DATA_01D59E[0]=$0E=14 with SpriteY−16 → body Y−2.
    const body = layout.tiles.slice(4)
    expect(body.map(t => t.charNum)).toEqual([
      0x400 + 0x100 + 0xa3,
      0x400 + 0x100 + 0xa3,
      0x400 + 0x100 + 0xb3,
      0x400 + 0x100 + 0xb3,
    ])
    expect(body.map(t => t.flipX)).toEqual([false, true, false, true])
    expect(body.every(t => t.palette === 10)).toBe(true)
    expect(body.map(t => t.dx)).toEqual([-8, 0, -8, 0])
    expect(body.map(t => t.dy)).toEqual([-2, -2, 6, 6])
  })

  it('renders Para-Bomb ($40) with the same parachute/body structure', () => {
    // Same ParachuteSprites handler; tilemapBase=$00, different tile bytes.
    // Sprite166EVals[$40]=$15 → attr=$05, same charHigh+palette as Para-Goomba.
    const tilemap = new Uint8Array(0xfc)
    const tilemapOffset = new Uint8Array(0x54)
    const spriteAttr = new Uint8Array(0x100)
    tilemapOffset[0x40] = 0x00
    tilemap[0x00] = 0x82 // body TL
    tilemap[0x01] = 0xa0 // body TR
    tilemap[0x02] = 0x82 // body BL
    tilemap[0x03] = 0xa2 // body BR
    tilemap[0x0d] = 0xcc // parachute char at tilemapBase+$0D = $00+$0D = $0D
    spriteAttr[0x40] = 0x05 // charHigh=1, palette=OBJ2

    const tables = makeTables({ tilemap, tilemapOffset, spriteAttr })
    const layout = buildSpriteLayout(tables, 0x40)!
    expect(layout.height).toBe(32)
    expect(layout.tiles).toHaveLength(8)

    const para = layout.tiles.slice(0, 4)
    expect(para.map(t => t.charNum)).toEqual([
      0x400 + 0x100 + 0xcd,
      0x400 + 0x100 + 0xcc,
      0x400 + 0x100 + 0xdd,
      0x400 + 0x100 + 0xdc,
    ])
    expect(para.every(t => t.flipX)).toBe(true)
    expect(para.every(t => t.palette === 11)).toBe(true)

    const body = layout.tiles.slice(4)
    expect(body.map(t => t.charNum)).toEqual([
      0x400 + 0x100 + 0x82,
      0x400 + 0x100 + 0xa0,
      0x400 + 0x100 + 0x82,
      0x400 + 0x100 + 0xa2,
    ])
    expect(body.map(t => t.flipX)).toEqual([false, true, false, true])
  })

  it('renders Feather ($77) with base tile $0E, palette 10, charHigh 0', () => {
    // PowerUpGfxRt (bank_01.asm:9632-9636): SpriteNumber - $74 = $77 - $74 = 3;
    // PowerUpTiles[3] = $0E.  Sprite166EVals[$77] = $24 → attr $04 → palette = 8+(2)=10, charHigh=0.
    const spriteAttr = new Uint8Array(0x100)
    spriteAttr[0x77] = 0x04 // Sprite166EVals[$77] ($24) & $0F
    const tables = makeTables({ spriteAttr })
    const layout = buildSpriteLayout(tables, 0x77)!
    expect(layout.height).toBe(16)
    expect(layout.tiles).toHaveLength(4)
    expect(layout.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0x0e,
      0x400 + 0x0f,
      0x400 + 0x1e,
      0x400 + 0x1f,
    ])
    expect(layout.tiles.every(t => t.palette === 10)).toBe(true)
    expect(layout.tiles.every(t => !t.flipX && !t.flipY)).toBe(true)
  })

  it('renders 1-Up mushroom ($78) with base tile $24, palette 13, charHigh 0', () => {
    // PowerUpGfxRt (bank_01.asm:9632-9636): SpriteNumber - $74 = $78 - $74 = 4;
    // PowerUpTiles[4] = $24.  Sprite166EVals[$78] = $0A → attr $0A → palette = 8+(5)=13, charHigh=0.
    const spriteAttr = new Uint8Array(0x100)
    spriteAttr[0x78] = 0x0a // Sprite166EVals[$78] & $0F
    const tables = makeTables({ spriteAttr })
    const layout = buildSpriteLayout(tables, 0x78)!
    expect(layout.height).toBe(16)
    expect(layout.tiles).toHaveLength(4)
    expect(layout.tiles.map(t => t.charNum)).toEqual([
      0x400 + 0x24,
      0x400 + 0x25,
      0x400 + 0x34,
      0x400 + 0x35,
    ])
    expect(layout.tiles.every(t => t.palette === 13)).toBe(true)
    expect(layout.tiles.every(t => !t.flipX && !t.flipY)).toBe(true)
  })

  // IDs 0xC9-0xFF (beyond the dispatch table) have no visual tile - they
  // render as placeholder boxes via SpriteFactory. Confirm null here so the
  // two paths stay in sync: any change to the table boundary is caught.
  const generatorNullCases: Array<{ name: string; id: number }> = [
    { name: '0xC9 layer-2 smash (generator, no tile)', id: 0xc9 },
    { name: '0xCA layer-2 scroll left (generator)', id: 0xca },
    { name: '0xCB layer-2 scroll right (generator)', id: 0xcb },
    { name: '0xCF layer-2 scroll up (generator)', id: 0xcf },
    { name: '0xE7 last generator-range ID', id: 0xe7 },
    { name: '0xE8 beyond dispatch table', id: 0xe8 },
    { name: '0xFF no sprite at this ID', id: 0xff },
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
      expect(pixels[x]).toBe(3) // top row
      expect(pixels[56 + x]).toBe(3) // bottom row
    }
    // Left and right columns are 3, interior edges are 0
    for (let y = 1; y <= 6; y++) {
      expect(pixels[y * 8]).toBe(3) // left col
      expect(pixels[y * 8 + 7]).toBe(3) // right col
      expect(pixels[y * 8 + 1]).toBe(0) // interior
      expect(pixels[y * 8 + 6]).toBe(0) // interior
    }
  })
})
