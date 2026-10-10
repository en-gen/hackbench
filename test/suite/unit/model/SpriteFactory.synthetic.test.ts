/**
 * SpriteFactory.buildSprites - synthetic-ROM branch coverage.
 *
 * Builds a 4 MB zero-filled LoROM buffer so that readSpriteTileTables
 * returns valid (all-zero) tables, then exercises every per-sprite-id
 * dispatch branch by including each sprite ID in the levelSprites list.
 *
 * No real ROM file is required. All char lookups fall through to the
 * transparent placeholder since chars Map is empty.
 *
 * Test tree:
 *   no-tables path   → ROM too small → buildSprites returns []
 *   single-batch     → all sprite IDs in one call → each if/switch arm exercised
 *     0x9F  BanzaiBillAppearance
 *     0x3D  RipVanFishAppearance
 *     0x26  ThwompAppearance  (+thwompReactRangeDy branches)
 *     0x27  ThwimpAppearance
 *     0x83, 0x84  WingedSpriteAppearance.fromFlyingQBlock
 *     0x08..0x0C  WingedSpriteAppearance.fromParaKoopa
 *     0x10  WingedSpriteAppearance.fromParaGoomba
 *     0x0E  KeyholeAppearance
 *     0x9C + 0x9B at same tile  CompositeSprite (broIdx !== undefined)
 *     0x9C alone                plain Sprite   (broIdx === undefined)
 *     0x30, 0x32  DryBonesAppearance (faceRight both sides)
 *     0x99  VolcanoLotusAppearance
 *     0x71..0x73  SuperKoopaAppearance (airborne + grounded)
 *     0x91..0x98  Chuck family (all 7 case arms)
 *     0x9A  SumoBrotherAppearance
 *     0x62  LineBrownPlatAppearance  (lineGuide=undefined path)
 *     0x63  LineCheckerPlatAppearance (checkerMode both sides)
 *     0x64  RopeMechanismAppearance
 *     0xC4  Grey Falling Platform (StaticSpriteAppearance special)
 *     0x2C  Yoshi Egg (buildYoshiEggLayout → StaticSpriteAppearance)
 *     0x2E  SpikeTopAppearance
 *     0x3E  PSwitchAppearance
 *     0x15  CheepCheepAppearance(false)
 *     0x16  CheepCheepAppearance(true)
 *     0x18  JumpingFishAppearance
 *     0x47  SwimJumpFishAppearance
 *     0x1D  HopFlameAppearance
 *     0xC2  BlurpAppearance
 *     0xB7, 0xB8  CarrotTopLiftAppearance
 *     0x04..0x07, 0x0F  KoopaAppearance
 *     0x20  StaticSpriteAppearance (generic fallthrough)
 *     0xFF  null-layout fallback (box placeholder)
 *     0x9B alone (suppressed - paired into 0x9C → not emitted)
 *     thwompReactRangeDy: blocker found + no blocker, priority skip
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { buildSprites } from '../../../../src/rom/model/SpriteFactory'
import { SpikeTopAppearance } from '../../../../src/rom/model/sprites/appearances/SpikeTopAppearance'
import { StaticSpriteAppearance } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import type { Char } from '../../../../src/rom/model/chars/Char'
import type { Tile } from '../../../../src/rom/model/tiles/Tile'

// ── Synthetic ROM fixture ─────────────────────────────────────────────────────

/** 4 MB LoROM buffer - all zeros except the map-mode marker at $7FD5.
 *  readSpriteTileTables reads from multiple addresses; all return zero
 *  buffers (valid non-null), so the tables are all-zero Uint8Arrays. */
function makeSpriteRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM slow-mode marker
  return new RomFile('mock.smc', buf)
}

/** A ROM buffer that is too small for any sprite-table address to be
 *  reachable, so readSpriteTileTables returns null. */
function makeEmptyRom(): RomFile {
  return new RomFile('tiny.smc', Buffer.alloc(0x100, 0x00))
}

/**
 * ROM identical to makeSpriteRom() but with bit 0 set in Sprite166EVals for
 * every sprite ID that dispatches via a `charHigh = (attr & 0x01) ? 0x100 : 0`
 * branch, so the TRUE arm (charHigh=0x100) is exercised.
 *
 * Sprite166EVals SNES address: $07F3FE.
 * LoROM file offset: bank 0x07 → 0x07*0x8000 + (0xF3FE - 0x8000) = 0x3F3FE.
 */
function makeSpriteRomHighChar(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM slow-mode marker
  const VALS_FILE_OFFSET = 0x3f3fe // loromToOffset(0x07F3FE)
  // Sprite IDs that use `(attr & 0x01) !== 0 ? 0x100 : 0` in buildSprites:
  for (const id of [0x3d, 0x26, 0x30, 0x32, 0x62, 0x63, 0x64]) {
    buf[VALS_FILE_OFFSET + id] |= 0x01
  }
  return new RomFile('mock-hc.smc', buf)
}

function sprite(spriteId: number, x = 5, y = 5): LevelSprite {
  return { screen: 0, x, y, spriteId, extraBit: false, raw: [0, 0, spriteId] }
}

const NO_CHARS = new Map<number, Char>()
const NO_TILES = new Map<number, Tile>()
const MARIO_LEFT = { x: 0, y: 0 } // sprite always to the right → faceRight=false
const MARIO_RIGHT = { x: 256, y: 0 } // sprite always to the left  → faceRight=true

// ── no-tables path ────────────────────────────────────────────────────────────

describe('buildSprites - no-tables (tiny ROM)', () => {
  it('returns [] when readSpriteTileTables returns null', () => {
    const rom = makeEmptyRom()
    const result = buildSprites(rom, [sprite(0x04)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(result).toHaveLength(0)
  })
})

// ── comprehensive dispatch - all sprite-id branches in one call ───────────────

describe('buildSprites - all dispatch branches via synthetic ROM', () => {
  const rom = makeSpriteRom()

  // An L1 grid: row 0 is empty, row 1 has a tile at col 5 (below a sprite at y=0)
  // Used to trigger the "tile below" path for SuperKoopa and thwompReactRangeDy.
  // Tile id 1 maps to a Tile with collision.floor=true.
  const SOLID_TILE_ID = 1
  const l1WithFloor: (number | null)[][] = [
    Array(20).fill(null), // row 0 - no tiles
    Array(20).fill(SOLID_TILE_ID), // row 1 - all solid (tile id=1)
  ]
  const solidTile: Tile = {
    id: SOLID_TILE_ID,
    actsLike: 0x0130,
    collision: {
      floor: true,
      ceiling: true,
      wall: true,
      slopeTable: false,
      marioFloor: true,
      marioCeiling: true,
      marioWall: true,
    },
    behavior: { selectQuad: () => [null!, null!, null!, null!] as never },
  }
  const l1TilesWithFloor = new Map<number, Tile>([[SOLID_TILE_ID, solidTile]])

  it('0x9F BanzaiBillAppearance', () => {
    const r = buildSprites(rom, [sprite(0x9f)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(0x9f)
  })

  it('0x3D RipVanFishAppearance', () => {
    const r = buildSprites(rom, [sprite(0x3d)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(0x3d)
  })

  it('0x26 ThwompAppearance - no blocker in l1 (thwompReactRangeDy falls to level bottom)', () => {
    const r = buildSprites(rom, [sprite(0x26, 5, 0)], NO_CHARS, [[]], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(0x26)
  })

  it('0x26 ThwompAppearance - solid blocker found in l1 (thwompReactRangeDy finds row)', () => {
    // sprite at (5,0) = px(80,0); floor at row 1 → blockerRow=1
    const r = buildSprites(
      rom,
      [sprite(0x26, 5, 0)],
      NO_CHARS,
      l1WithFloor,
      MARIO_LEFT,
      l1TilesWithFloor,
    )
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(0x26)
  })

  it('0x27 ThwimpAppearance', () => {
    const r = buildSprites(rom, [sprite(0x27)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(0x27)
  })

  it('0x83 WingedSpriteAppearance.fromFlyingQBlock', () => {
    const r = buildSprites(rom, [sprite(0x83)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x84 WingedSpriteAppearance.fromFlyingQBlock', () => {
    const r = buildSprites(rom, [sprite(0x84)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x08 WingedSpriteAppearance.fromParaKoopa', () => {
    const r = buildSprites(rom, [sprite(0x08)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x09 WingedSpriteAppearance.fromParaKoopa', () => {
    const r = buildSprites(rom, [sprite(0x09)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x0A WingedSpriteAppearance.fromParaKoopa', () => {
    const r = buildSprites(rom, [sprite(0x0a)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x0B WingedSpriteAppearance.fromParaKoopa', () => {
    const r = buildSprites(rom, [sprite(0x0b)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x0C WingedSpriteAppearance.fromParaKoopa', () => {
    const r = buildSprites(rom, [sprite(0x0c)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x10 WingedSpriteAppearance.fromParaGoomba', () => {
    const r = buildSprites(rom, [sprite(0x10)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x0E KeyholeAppearance', () => {
    const r = buildSprites(rom, [sprite(0x0e)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x9C + co-located 0x9B → CompositeSprite (broIdx !== undefined)', () => {
    // 0x9C (platform) + 0x9B (Hammer Bro) at same tile → pairedBro, 0x9B suppressed
    const sprites = [sprite(0x9c, 5, 5), sprite(0x9b, 5, 5)]
    const r = buildSprites(rom, sprites, NO_CHARS, [], MARIO_LEFT, NO_TILES)
    // 0x9B suppressed; only the composite is emitted
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(0x9c)
  })

  it('0x9C alone → plain Sprite (broIdx === undefined)', () => {
    const r = buildSprites(rom, [sprite(0x9c)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(0x9c)
  })

  it('0x30 DryBonesAppearance (faceRight=true: mario >= sprite)', () => {
    // marioStartPx.x(256) >= sprite.x*16(80) → faceRight=true
    const r = buildSprites(rom, [sprite(0x30)], NO_CHARS, [], MARIO_RIGHT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x32 DryBonesAppearance (faceRight=false: mario < sprite)', () => {
    const r = buildSprites(rom, [sprite(0x32)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x99 VolcanoLotusAppearance', () => {
    const r = buildSprites(rom, [sprite(0x99)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x71 SuperKoopaAppearance - airborne (no tile below)', () => {
    // l1=[] so l1[s.y+1]?.[s.x] = undefined → airborne=true
    const r = buildSprites(rom, [sprite(0x71, 5, 0)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x72 SuperKoopaAppearance - grounded (tile below has floor=true)', () => {
    // sprite at (5, 0): l1[0+1][5] = SOLID_TILE_ID → belowTile.collision.floor=true → airborne=false
    const r = buildSprites(
      rom,
      [sprite(0x72, 5, 0)],
      NO_CHARS,
      l1WithFloor,
      MARIO_LEFT,
      l1TilesWithFloor,
    )
    expect(r).toHaveLength(1)
  })

  it('0x73 SuperKoopaAppearance (faceRight)', () => {
    const r = buildSprites(rom, [sprite(0x73, 5, 0)], NO_CHARS, [], MARIO_RIGHT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x91 CharginChuckAppearance', () => {
    const r = buildSprites(rom, [sprite(0x91)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x92 SplittinChuckAppearance', () => {
    const r = buildSprites(rom, [sprite(0x92)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x93 BouncinChuckAppearance', () => {
    const r = buildSprites(rom, [sprite(0x93)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x94 WhistlinChuckAppearance', () => {
    const r = buildSprites(rom, [sprite(0x94)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x95 ClappinChuckAppearance', () => {
    const r = buildSprites(rom, [sprite(0x95)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x97 PuntinChuckAppearance', () => {
    const r = buildSprites(rom, [sprite(0x97)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x98 PitchinChuckAppearance', () => {
    const r = buildSprites(rom, [sprite(0x98)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x9A SumoBrotherAppearance', () => {
    const r = buildSprites(rom, [sprite(0x9a)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x62 LineBrownPlatAppearance (no line guide in empty l1)', () => {
    const r = buildSprites(rom, [sprite(0x62)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x63 LineCheckerPlatAppearance (x=4, even col → checkerMode=true)', () => {
    const r = buildSprites(rom, [sprite(0x63, 4, 5)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x63 LineCheckerPlatAppearance (x=5, odd col → checkerMode=false)', () => {
    const r = buildSprites(rom, [sprite(0x63, 5, 5)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x64 RopeMechanismAppearance', () => {
    const r = buildSprites(rom, [sprite(0x64)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0xC4 Grey Falling Platform (StaticSpriteAppearance special case)', () => {
    const r = buildSprites(rom, [sprite(0xc4)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(0xc4)
  })

  it('0x2C Yoshi Egg (buildYoshiEggLayout branch)', () => {
    // All-zero synthetic tables: YoshiPal = 0 → palette 8, charHigh 0, base char 0.
    // Only the mirrored corner order and the H-flip survive.
    const r = buildSprites(rom, [sprite(0x2c)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    const parts = (r[0].appearance as StaticSpriteAppearance).parts
    expect(parts.map(p => p.flipX)).toEqual([true, true, true, true])
    expect(parts.map(p => p.dx)).toEqual([0, 0, 0, 0])
  })

  it('0x2E SpikeTopAppearance', () => {
    const r = buildSprites(rom, [sprite(0x2e)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x3E PSwitchAppearance', () => {
    const r = buildSprites(rom, [sprite(0x3e)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x15 CheepCheepAppearance(vertical=false)', () => {
    const r = buildSprites(rom, [sprite(0x15)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x16 CheepCheepAppearance(vertical=true)', () => {
    const r = buildSprites(rom, [sprite(0x16)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x18 JumpingFishAppearance', () => {
    const r = buildSprites(rom, [sprite(0x18)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x47 SwimJumpFishAppearance', () => {
    const r = buildSprites(rom, [sprite(0x47)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x1D HopFlameAppearance', () => {
    const r = buildSprites(rom, [sprite(0x1d)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0xC2 BlurpAppearance', () => {
    const r = buildSprites(rom, [sprite(0xc2)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0xB7 CarrotTopLiftAppearance', () => {
    const r = buildSprites(rom, [sprite(0xb7)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0xB8 CarrotTopLiftAppearance', () => {
    const r = buildSprites(rom, [sprite(0xb8)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x04 KoopaAppearance (spriteId <= 0x07)', () => {
    const r = buildSprites(rom, [sprite(0x04)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x07 KoopaAppearance (spriteId <= 0x07 boundary)', () => {
    const r = buildSprites(rom, [sprite(0x07)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x0F KoopaAppearance (spriteId === 0x0F)', () => {
    const r = buildSprites(rom, [sprite(0x0f)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x20 StaticSpriteAppearance (generic fallthrough, has layout)', () => {
    // 0x20 < 0x54 and no special dispatch → falls through to generic parts build
    const r = buildSprites(rom, [sprite(0x20)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0xFF null-layout fallback → box placeholder appearance', () => {
    // 0xFF > MAX_SPRITE_ID_WITH_LAYOUT(0xC8) → buildSpriteLayout returns null
    // → uses the box placeholder StaticSpriteAppearance
    const r = buildSprites(rom, [sprite(0xff)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(0xff)
  })

  it('all sprites in a single buildSprites call - no crashes', () => {
    const allSprites: LevelSprite[] = [
      0x9f,
      0x3d,
      0x26,
      0x27,
      0x83,
      0x84,
      0x08,
      0x09,
      0x0a,
      0x0b,
      0x0c,
      0x10,
      0x0e,
      0x9c,
      0x9b, // 0x9C+0x9B pair at same tile
      0x30,
      0x32,
      0x99,
      0x71,
      0x72,
      0x73,
      0x91,
      0x92,
      0x93,
      0x94,
      0x95,
      0x97,
      0x98,
      0x9a,
      0x62,
      0x63,
      0x64,
      0xc4,
      0x2e,
      0x3e,
      0x15,
      0x16,
      0x18,
      0x47,
      0x1d,
      0xc2,
      0xb7,
      0xb8,
      0x04,
      0x05,
      0x06,
      0x07,
      0x0f,
      0x20,
      0xff,
    ].map(id => sprite(id))
    expect(() =>
      buildSprites(rom, allSprites, NO_CHARS, l1WithFloor, MARIO_LEFT, l1TilesWithFloor),
    ).not.toThrow()
  })
})

// ── thwompReactRangeDy: loop-body branch coverage ─────────────────────────────
//
// sprite(0x26, 5, 0) → px=80, py=0.
// startRow = ceil((0+32)/16) = 2, colStart=5, colEnd=7.
// All prior tests used l1 with ≤2 rows so startRow=2 ≥ rows and the scan loop
// never ran. These tests use 3-row l1 grids so the loop body actually executes.

describe('buildSprites - thwompReactRangeDy loop body', () => {
  const rom = makeSpriteRom()

  const SOLID_ID = 10
  const solidTile: Tile = {
    id: SOLID_ID,
    actsLike: 0x0130,
    collision: {
      floor: true,
      ceiling: true,
      wall: true,
      slopeTable: false,
      marioFloor: true,
      marioCeiling: true,
      marioWall: true,
    },
    behavior: { selectQuad: () => [null!, null!, null!, null!] as never },
  }

  it('solid floor in row 2 - loop body executes, floor found, blockerRow < rows TRUE', () => {
    // Loop runs: r=2 < rows=3. l1[2][5]=SOLID_ID → tile found → floor=true → break.
    // blockerRow=2 < rows=3 → zoneBottom=(2+1)*16=48 → reactRangeDy=48.
    const l1: (number | null)[][] = [
      Array(20).fill(null),
      Array(20).fill(null),
      Array(20).fill(SOLID_ID),
    ]
    const l1Tiles = new Map<number, Tile>([[SOLID_ID, solidTile]])
    const r = buildSprites(rom, [sprite(0x26, 5, 0)], NO_CHARS, l1, MARIO_LEFT, l1Tiles)
    expect(r).toHaveLength(1)
    expect(r[0].behavior.reactRangeDy).toBe(48)
  })

  it('null cells in scan row - id === null/undefined continue branch', () => {
    // l1[2] is all null. Loop runs, id=null → continue. No blocker found.
    // blockerRow stays rows=3 → zoneBottom=rows*16=48.
    const l1: (number | null)[][] = [
      Array(20).fill(null),
      Array(20).fill(null),
      Array(20).fill(null),
    ]
    const r = buildSprites(rom, [sprite(0x26, 5, 0)], NO_CHARS, l1, MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].behavior.reactRangeDy).toBe(48)
  })

  it('tile ID in l1 but absent from l1Tiles - !tile TRUE continue branch', () => {
    // l1[2][c]=99 but l1Tiles is empty → l1Tiles.get(99)=undefined → !tile → continue.
    const l1: (number | null)[][] = [Array(20).fill(null), Array(20).fill(null), Array(20).fill(99)]
    const r = buildSprites(rom, [sprite(0x26, 5, 0)], NO_CHARS, l1, MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].behavior.reactRangeDy).toBe(48)
  })

  it('priority-decorative tile in row 2, solid in row 3 - isPriorityDecorative TRUE skip', () => {
    // l1[2][c]=PRIORITY_ID → isPriorityDecorative=true → continue.
    // l1[3][c]=SOLID_ID → floor found → blockerRow=3.
    const PRIORITY_ID = 2
    const priorityTile: Tile = {
      id: PRIORITY_ID,
      actsLike: 0x0000,
      collision: {
        floor: false,
        ceiling: false,
        wall: false,
        slopeTable: false,
        marioFloor: false,
        marioCeiling: false,
        marioWall: false,
      },
      behavior: {
        selectQuad: () =>
          [
            { char: null!, palette: 0, flipX: false, flipY: false, priority: true },
            { char: null!, palette: 0, flipX: false, flipY: false, priority: true },
            { char: null!, palette: 0, flipX: false, flipY: false, priority: true },
            { char: null!, palette: 0, flipX: false, flipY: false, priority: true },
          ] as never,
      },
    }
    const l1: (number | null)[][] = [
      Array(20).fill(null),
      Array(20).fill(null),
      Array(20).fill(PRIORITY_ID),
      Array(20).fill(SOLID_ID),
    ]
    const l1Tiles = new Map<number, Tile>([
      [PRIORITY_ID, priorityTile],
      [SOLID_ID, solidTile],
    ])
    const r = buildSprites(rom, [sprite(0x26, 5, 0)], NO_CHARS, l1, MARIO_LEFT, l1Tiles)
    expect(r).toHaveLength(1)
    // blockerRow=3 < rows=4 → zoneBottom=(3+1)*16=64; reactRangeDy=64-0=64
    expect(r[0].behavior.reactRangeDy).toBe(64)
  })
})

// ── charHigh = 0x100 TRUE arm (attr & 0x01 !== 0) ────────────────────────────
//
// With a zero-filled ROM spriteAttr[id]=0 so (0 & 0x01) is always 0 → only the
// `0` arm of `(attr & 0x01) !== 0 ? 0x100 : 0` fires. The `0x100` arm requires
// attr to have bit 0 set. makeSpriteRomHighChar() sets bit 0 for the relevant IDs.

describe('buildSprites - charHigh=0x100 TRUE arm (attr bit 0 set)', () => {
  const romHC = makeSpriteRomHighChar()

  it('0x3D with charHigh=0x100: attr&0x01 set → TRUE arm of charHigh ternary', () => {
    const r = buildSprites(romHC, [sprite(0x3d)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(0x3d)
  })

  it('0x30 with charHigh=0x100: attr&0x01 set → TRUE arm', () => {
    const r = buildSprites(romHC, [sprite(0x30)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x32 with charHigh=0x100: attr&0x01 set → TRUE arm', () => {
    const r = buildSprites(romHC, [sprite(0x32)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x62 with charHigh=0x100: attr&0x01 set → TRUE arm', () => {
    const r = buildSprites(romHC, [sprite(0x62)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x63 with charHigh=0x100: attr&0x01 set → TRUE arm', () => {
    const r = buildSprites(romHC, [sprite(0x63, 4, 5)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })

  it('0x64 with charHigh=0x100: attr&0x01 set → TRUE arm', () => {
    const r = buildSprites(romHC, [sprite(0x64)], NO_CHARS, [], MARIO_LEFT, NO_TILES)
    expect(r).toHaveLength(1)
  })
})

// -- $2E Spike Top facing (#134) ---------------------------------------------

describe('buildSprites - $2E Spike Top faces by Mario X, flip read from the cart table', () => {
  // DATA_02BCC7 at $02:BCC7 = file $13CC7. Planted: direction 0 -> $00, direction 4 -> $40,
  // with the other bytes distinct so a wrong index cannot pass.
  function romWithFlipTable(at0: number, at4: number): RomFile {
    const buf = Buffer.alloc(0x400000, 0x00)
    buf[0x7fd5] = 0x20
    buf.fill(0x80, 0x13cc7, 0x13cc7 + 16)
    buf.set([0x19, 0xc7, 0xbc], 0x13d17) // the gate: ORA.W DATA_02BCC7,Y at $02:BD17
    buf[0x13cc7] = at0
    buf[0x13cc7 + 4] = at4
    return new RomFile('mock-spiketop.smc', buf)
  }
  const flipOf = (rom: RomFile, marioX: number): boolean[] => {
    const r = buildSprites(rom, [sprite(0x2e, 5, 5)], NO_CHARS, [], { x: marioX, y: 0 }, NO_TILES)
    return (r[0].appearance as SpikeTopAppearance).parts0.map(p => p.flipX)
  }
  const X = 5 * 16 // the sprite's pixel X

  it('sweeps Mario across the sprite: strictly left is unflipped, equal and right are flipped', () => {
    const rom = romWithFlipTable(0x00, 0x40)
    for (const m of [0, X - 64, X - 1]) expect(flipOf(rom, m)).toEqual([false, false, false, false])
    for (const m of [X, X + 1, X + 64, 4000]) expect(flipOf(rom, m)).toEqual([true, true, true, true]) // prettier-ignore
  })

  it('reads the table: with the two entries swapped the sides swap', () => {
    const rom = romWithFlipTable(0x40, 0x00)
    expect(flipOf(rom, X - 1)).toEqual([true, true, true, true])
    expect(flipOf(rom, X)).toEqual([false, false, false, false])
  })
})
