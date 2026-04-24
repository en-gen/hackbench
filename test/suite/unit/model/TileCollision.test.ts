/**
 * TileCollision invariants — verifies that the Mario-perspective
 * fields are properly derived from sprite-perspective fields + the
 * `isMarioStandable` exclusion list, for the full low-byte range.
 *
 * Uses a plain re-implementation of classify's arithmetic so we're
 * testing the data relationship, not the TileFactory plumbing.
 */

import { describe, expect, it } from 'vitest'
import {
  isBlockBehaviorWall,
  isMarioStandable,
  isSlopeTile,
} from '../../../../src/rom/BlockBehaviorLoader'
import {
  marioFeetLanding,
  marioTileDispatch,
  marioTileSolidity,
  PSWITCH_INACTIVE,
  type MarioDispatchTables,
} from '../../../../src/rom/MarioTileDispatch'

/** Vanilla SMW `DATA_00F05C` (bank_00.asm:12744). */
const BLOCK_BEHAVIOR_TABLE = new Uint8Array([
  0x01, 0x05, 0x01, 0x02, 0x01, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x02, 0x02,
  0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
  0x02, 0x03, 0x03, 0x04, 0x02, 0x02, 0x02, 0x01,
  0x01, 0x07, 0x11, 0x10,
])

/** Vanilla SMW `DATA_00EAC1` (bank_00.asm:11946). */
const SLOPE_TABLE = new Uint8Array([
  0x71, 0x72, 0x76, 0x77, 0x7B, 0x7C, 0x81, 0x86,
  0x8A, 0x8B, 0x8F, 0x90, 0x94, 0x95, 0x99, 0x9A,
  0x9E, 0x9F, 0xA3, 0xA4, 0xA8, 0xA9, 0xAD, 0xAE,
  0xB2, 0xB3,
])

/** Vanilla SMW Mario-dispatch tables. */
const DISPATCH_TABLES: MarioDispatchTables = {
  dataA625: new Uint8Array([
    0x00, 0x80, 0x40, 0x00, 0x01, 0x02, 0x40, 0x00,
    0x40, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00,
  ]),
  dataF0A4: new Uint8Array([
    0x0C, 0x08, 0x0C, 0x08, 0x0C, 0x0F, 0x08, 0x08,
    0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
    0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
    0x08, 0x03, 0x03, 0x08, 0x08, 0x08, 0x08, 0x08,
    0x08, 0x04, 0x08, 0x08,
  ]),
  dataF0EC: new Uint8Array([
    0x08, 0x01, 0x02, 0x04, 0xED, 0xF6, 0x00, 0x7D,
    0xBE, 0x00, 0x6F, 0xB7,
  ]),
}

/**
 * Mirror of `TileFactory.classify`'s arithmetic — extracted here so
 * tests can verify the invariants without going through the ROM
 * load / factory build pipeline. Any change to classify must be
 * reflected here (and vice versa).
 */
function classify(low: number, tileset: number = 1, high: number = 0): {
  floor: boolean; ceiling: boolean; wall: boolean
  marioFloor: boolean; marioCeiling: boolean; marioWall: boolean
  slopeTable: boolean
} {
  const lo = low & 0xFF
  const hi = high & 0xFF
  const bh = lo >= 0x11 && lo <= 0x34 ? BLOCK_BEHAVIOR_TABLE[lo - 0x11] : null
  const bhBlocks = bh === null || isBlockBehaviorWall(bh)

  const wall = bhBlocks && lo >= 0x11 && lo <= 0x6D
  const inSolidRange    = lo >= 0x11 && lo <= 0x6D
  const inTilesetWindow = tileset !== 0 && tileset !== 7 && lo >= 0xC4 && lo <= 0xC9
  const floor = bhBlocks && (lo <= 0x10 || inSolidRange || lo >= 0xD8)
  const ceiling = bhBlocks && (inSolidRange || inTilesetWindow)
  const slopeTable = isSlopeTile(lo, SLOPE_TABLE)

  const hurtsFromAnyDir = (
    marioTileDispatch(lo, tileset, 0, DISPATCH_TABLES).kind === 'hurt' ||
    marioTileDispatch(lo, tileset, 1, DISPATCH_TABLES).kind === 'hurt' ||
    marioTileDispatch(lo, tileset, 2, DISPATCH_TABLES).kind === 'hurt' ||
    marioTileDispatch(lo, tileset, 3, DISPATCH_TABLES).kind === 'hurt'
  )
  const feetLanding = marioFeetLanding(lo, tileset)
  const marioOk     = isMarioStandable(lo) && !hurtsFromAnyDir
  const marioSolid  = marioTileSolidity(lo, hi, PSWITCH_INACTIVE)
  const marioInCeilingWindow = tileset !== 0 && tileset !== 7 && lo >= 0xC4 && lo <= 0xC9
  const marioFloor   = marioSolid && (feetLanding.kind === 'land') && marioOk
  const marioCeiling = marioSolid && (inSolidRange || marioInCeilingWindow) && marioOk
  const marioWall    = marioSolid && inSolidRange && marioOk

  return { floor, ceiling, wall, marioFloor, marioCeiling, marioWall, slopeTable }
}

describe('TileCollision invariants', () => {
  it('sprite-perspective and Mario-perspective are decoupled', () => {
    // `marioWall` / `marioCeiling` / `marioFloor` gate on CODE_00F545
    // solidity, NOT on the sprite `bhBlocks` filter. They can report
    // surfaces the sprite fields exclude (e.g. $11A item block: F05C
    // empty → sprite fields false, but Mario can head-bump it).
    // Likewise they exclude sprite-solid tiles that fail F545 (page-0
    // $11-$6D pass-throughs). No subset relationship between them.
    // This test ensures we don't re-introduce one accidentally.
    let anyMarioNotSprite = false
    let anySpriteNotMario = false
    for (let lo = 0; lo < 0x100; lo++) {
      const page0 = classify(lo, 1, 0x00)
      const page1 = classify(lo, 1, 0x01)
      if (page0.marioWall && !page0.wall) anyMarioNotSprite = true
      if (page1.marioCeiling && !page1.ceiling) anyMarioNotSprite = true
      if (page0.wall && !page0.marioWall) anySpriteNotMario = true
    }
    expect(anyMarioNotSprite).toBe(true)   // at least one page-1 Mario-ceiling w/o sprite-ceiling (e.g. $11A)
    expect(anySpriteNotMario).toBe(true)   // at least one page-0 sprite-wall w/o Mario-wall (e.g. checkpoint post)
  })

  it('slope tiles are NOT marioFloor (slopes have diagonal surfaces, not flat tops)', () => {
    // CODE_00EDF7 routes $6E-$D7 tiles to the slope-angle dispatch and
    // returns 'slope' (not 'land'). Per classify's split, marioFloor is
    // flat-only; slope membership stays in the separate slopeTable field
    // so future overlays can render angle data without conflating with
    // horizontal-floor yellow lines.
    for (const lo of SLOPE_TABLE) {
      const c = classify(lo)
      expect(c.slopeTable).toBe(true)
      expect(c.marioFloor).toBe(false)
    }
  })
})

describe('TileCollision — known tile IDs', () => {
  it('?-block page-0 low $1F: sprite-solid; Mario-solid via F545 page-0 catch-all? No', () => {
    // Low $1F with high=$00: F545 SBC #$EC = $33, BCS F592 → non-solid.
    // So page-0 $01F is NOT a Mario wall. Sprite fields still true via
    // the $11-$6D range check which F545 gating doesn't apply to.
    const c = classify(0x1F, 1, 0x00)
    expect(c.floor).toBe(true)
    expect(c.ceiling).toBe(true)
    expect(c.wall).toBe(true)
    expect(c.marioFloor).toBe(false)
    expect(c.marioCeiling).toBe(false)
    expect(c.marioWall).toBe(false)
  })

  it('?-block page-1 low $11F: solid for both sprite AND Mario', () => {
    // High=$01 → F545 F577 branch → A = $01 → solid.
    const c = classify(0x1F, 1, 0x01)
    expect(c.wall).toBe(true)
    expect(c.marioFloor).toBe(true)
    expect(c.marioCeiling).toBe(true)
    expect(c.marioWall).toBe(true)
  })

  it('midway tape page-0 low $38: Mario-non-solid (F545 pass-through)', () => {
    // F545: high=0, low=$38, SBC #$EC = $4C, BCS F592 → non-solid.
    // The sprite floor/wall still report solid (per CODE_01928E range)
    // but Mario walks through — F2C9 block-action fires separately.
    const c = classify(0x38, 1, 0x00)
    expect(c.floor).toBe(true)
    expect(c.wall).toBe(true)
    expect(c.marioFloor).toBe(false)
    expect(c.marioWall).toBe(false)
  })

  it('checkpoint post body page-0 low $32: Mario-non-solid (F545 pass-through)', () => {
    const c = classify(0x32, 1, 0x00)
    expect(c.wall).toBe(true)          // sprite-range says wall
    expect(c.marioWall).toBe(false)    // F545 says non-solid
    expect(c.marioFloor).toBe(false)
  })

  it('item block page-1 low $11A: marioCeiling=true (head-bumpable)', () => {
    // F05C[$1A] = $00 → sprite bhBlocks = false → sprite ceiling = false.
    // But Mario CAN head-bump ?-blocks. With F545 gate (high=$01 → solid)
    // and the bhBlocks decoupling, marioCeiling is true.
    const c = classify(0x1A, 1, 0x01)
    expect(c.ceiling).toBe(false)      // sprite path excludes (F05C=$00)
    expect(c.marioCeiling).toBe(true)  // Mario path includes
    expect(c.marioFloor).toBe(true)    // ?-blocks are also stand-on-able
  })

  it('spike $02F: sprite-solid, Mario excluded via F127 hurt', () => {
    const c = classify(0x02F, 1, 0x00)
    expect(c.floor).toBe(true)
    expect(c.wall).toBe(true)
    expect(c.marioFloor).toBe(false)
    expect(c.marioWall).toBe(false)
  })

  it('checkpoint decoration low $68 tileset 1: Mario excluded via F127 hurt', () => {
    const c = classify(0x68, 1, 0x00)
    expect(c.floor).toBe(true)
    expect(c.wall).toBe(true)
    expect(c.marioFloor).toBe(false)
    expect(c.marioWall).toBe(false)
  })

  it('ground page-1 $100: Mario floor (F545 page-1 solid + feet-landing)', () => {
    const c = classify(0x00, 1, 0x01)
    expect(c.marioFloor).toBe(true)
  })

  it('slope low $71: slopeTable=true but marioFloor=false', () => {
    const c = classify(0x71)
    expect(c.slopeTable).toBe(true)
    expect(c.marioFloor).toBe(false)
  })
})
