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
import {
  resolveSlope,
  type SlopeTables,
} from '../../../../src/rom/SlopeResolver'

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

/** Vanilla SMW `DATA_00E55E` (bank_00.asm:11572). */
const VANILLA_E55E = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x02, 0x02,
  0x03, 0x03, 0x03, 0x03, 0x03, 0x04, 0x04, 0x04,
  0x04, 0x04, 0x05, 0x05, 0x05, 0x05, 0x05, 0x06,
  0x06, 0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07,
  0x07, 0x08, 0x08, 0x08, 0x08, 0x08, 0x09, 0x09,
  0x09, 0x09, 0x09, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A,
  0x0B, 0x0B, 0x0B, 0x0B, 0x0B, 0x0C, 0x0C, 0x0C,
  0x0C, 0x0C, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0E,
  0x0F, 0x10, 0x11, 0x03, 0x03, 0x04, 0x04, 0x09,
  0x09, 0x0A, 0x0A, 0x0C, 0x0C, 0x0D, 0x0D, 0x12,
  0x13, 0x14, 0x15, 0x16, 0x17, 0x1C, 0x1D, 0x1E,
  0x1F, 0x18, 0x19, 0x1A, 0x1B, 0x08, 0x09, 0x0A,
  0x0B, 0x0C, 0x0D,
])
const VANILLA_E5C8 = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x01, 0x01, 0x01, 0x01, 0x02, 0x02, 0x02,
  0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x03, 0x04,
  0x04, 0x04, 0x04, 0x04, 0x05, 0x05, 0x05, 0x05,
  0x05, 0x06, 0x06, 0x06, 0x06, 0x06, 0x07, 0x07,
  0x07, 0x07, 0x07, 0x08, 0x08, 0x08, 0x08, 0x08,
  0x09, 0x09, 0x09, 0x09, 0x09, 0x0A, 0x0A, 0x0A,
  0x0A, 0x0A, 0x0B, 0x0B, 0x0B, 0x0B, 0x0B, 0x0C,
  0x0C, 0x0C, 0x0C, 0x0C, 0x0D, 0x0D, 0x0D, 0x0D,
  0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x03, 0x03, 0x04,
  0x04, 0x09, 0x09, 0x0A, 0x0A, 0x0C, 0x0C, 0x0D,
  0x0D, 0x0C, 0x0D, 0x0D, 0x0C, 0x16, 0x17, 0x1C,
  0x1D, 0x1E, 0x1F, 0x18, 0x19, 0x1A, 0x1B, 0x08,
  0x09, 0x0A, 0x0B, 0x0C, 0x0D,
])
/** Synthetic DATA_00E632 — only slope index 0 is asserted. */
const SYNTHETIC_E632 = (() => {
  const t = new Uint8Array(510)
  t.set([
    0x0F, 0x0F, 0x0F, 0x0F, 0x0E, 0x0E, 0x0E, 0x0E,
    0x0D, 0x0D, 0x0D, 0x0D, 0x0C, 0x0C, 0x0C, 0x0C,
  ], 0)
  return t
})()
const SLOPE_TABLES: SlopeTables = {
  heightTable:       SYNTHETIC_E632,
  indexMapDefault:   VANILLA_E55E,
  indexMapOverworld: VANILLA_E5C8,
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
  /** True when `classify` emits a `slope` field. Mirrors the
   *  `marioSolid && resolveSlope(low, tileset, slopeTables)` gate in
   *  `TileFactory.classify` — F545 non-solid tiles never carry slope
   *  data even when their low byte is in $6E-$D7. */
  slopeResolved: boolean
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

  const dispatch0 = marioTileDispatch(lo, tileset, 0, DISPATCH_TABLES)
  const dispatch1 = marioTileDispatch(lo, tileset, 1, DISPATCH_TABLES)
  const dispatch2 = marioTileDispatch(lo, tileset, 2, DISPATCH_TABLES)
  const dispatch3 = marioTileDispatch(lo, tileset, 3, DISPATCH_TABLES)
  const hurtsFromAnyDir = (
    dispatch0.kind === 'hurt' ||
    dispatch1.kind === 'hurt' ||
    dispatch2.kind === 'hurt' ||
    dispatch3.kind === 'hurt'
  )
  // F0EC direction encoding per PlayerBlockedDir (rammap.asm:632):
  //   dir 0 → head bump (CEILING), dir 3 → feet landing (FLOOR),
  //   dir 1/2 → sides (WALL).
  const hitOnHead  = dispatch0.kind === 'hit'
  const hitOnSides = dispatch1.kind === 'hit' || dispatch2.kind === 'hit'
  const hitOnFeet  = dispatch3.kind === 'hit'
  const feetLanding = marioFeetLanding(lo, tileset)
  const marioOk     = isMarioStandable(lo) && !hurtsFromAnyDir
  const marioSolid  = marioTileSolidity(lo, hi, PSWITCH_INACTIVE)
  const marioInCeilingWindow = tileset !== 0 && tileset !== 7 && lo >= 0xC4 && lo <= 0xC9
  const marioFloor   = (marioSolid || hitOnFeet)  && (feetLanding.kind === 'land') && marioOk
  const marioCeiling = (marioSolid || hitOnHead)  && (inSolidRange || marioInCeilingWindow) && marioOk
  const marioWall    = (marioSolid || hitOnSides) && inSolidRange && marioOk

  // Phase 3: slope resolution is gated by F545 solidity. Mirrors the
  // `marioSolid ? resolveSlope(...) : null` call in TileFactory.classify
  // and the ROM's `JSR CODE_00F44D / BNE` gate at bank_00.asm:12393.
  const slope = marioSolid ? resolveSlope(lo, tileset, SLOPE_TABLES) : null
  const slopeResolved = slope !== null

  return { floor, ceiling, wall, marioFloor, marioCeiling, marioWall, slopeTable, slopeResolved }
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
  it('?-block page-0 low $1F: F545 non-solid but F127 head-bump fires → marioCeiling via F127 union', () => {
    // Low $1F with high=$00: F545 SBC #$EC = $33, BCS F592 → non-solid.
    // So page-0 $01F is NOT F545-solid. BUT F0A4[$0E] = $08 (bit 3 =
    // PlayerBlock_Top), so the F127 dispatch fires on head-bump (dir 0)
    // — Mario triggers the ?-block action when jumping into the tile
    // from below. marioCeiling unions the two, so it reports true.
    // marioWall/marioFloor stay false: F0A4[$0E] has no side bits and
    // no feet bit.
    const c = classify(0x1F, 1, 0x00)
    expect(c.floor).toBe(true)
    expect(c.ceiling).toBe(true)
    expect(c.wall).toBe(true)
    expect(c.marioFloor).toBe(false)
    expect(c.marioCeiling).toBe(true)   // F127 head-bump fires
    expect(c.marioWall).toBe(false)
  })

  it('invisible coin block $021: F545 non-solid but F127 head-bump → marioCeiling', () => {
    // The canonical hidden block. F545 page-0 says non-solid (Mario
    // walks through freely until he jumps up into it). F0A4[$10] = $08
    // (bit 3 = PlayerBlock_Top), matching F127 dir 0 — head bump fires
    // the reveal-to-$123 + coin-spawn action. The overlay must surface
    // this so designers see where hidden blocks land.
    const c = classify(0x21, 1, 0x00)
    expect(c.marioCeiling).toBe(true)
    expect(c.marioFloor).toBe(false)   // no feet-landing action
    expect(c.marioWall).toBe(false)    // no side action
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

describe('TileCollision — Phase 3 slope field', () => {
  it('page-1 slope tile (e.g. $171) emits slope (F545 says solid)', () => {
    // High=$01 → F545 default branch returns A=$01 (solid). Low $71 is
    // in the $6E-$D7 slope range, so resolveSlope returns a SlopeInfo.
    expect(classify(0x71, 1, 0x01).slopeResolved).toBe(true)
    expect(classify(0xB3, 1, 0x01).slopeResolved).toBe(true)  // last EAC1 entry
  })

  it('page-0 slope-range tile (e.g. $073 bush, $0A6 lava-corner) emits NO slope', () => {
    // F545 with high=$00 returns non-solid for low bytes outside the
    // P-switch / switch-palace special cases. These tiles render as
    // decorative graphics only — Mario walks straight through them and
    // the ROM never enters the slope-angle dispatch (CODE_00EDE9
    // BEQ at bank_00.asm:12393-12394 short-circuits to F309).
    //
    // Without the F545 gate the overlay would draw misleading slope
    // lines on $073 / $074 / $079 bush graphics and $0A3 / $0A6 lava
    // corners — the bug the user flagged in the level-screen 1 review.
    expect(classify(0x73, 1, 0x00).slopeResolved).toBe(false)
    expect(classify(0x74, 1, 0x00).slopeResolved).toBe(false)
    expect(classify(0x79, 1, 0x00).slopeResolved).toBe(false)
    expect(classify(0xA3, 1, 0x00).slopeResolved).toBe(false)
    expect(classify(0xA6, 1, 0x00).slopeResolved).toBe(false)
    expect(classify(0x71, 1, 0x00).slopeResolved).toBe(false)  // even EAC1 members
  })

  it('low byte outside the $6E-$D7 SlopesPtr range never emits slope', () => {
    // Whether F545 says solid or not, low bytes outside the slope
    // map range fall through resolveSlope to null.
    expect(classify(0x00, 1, 0x01).slopeResolved).toBe(false)
    expect(classify(0x11, 1, 0x01).slopeResolved).toBe(false)  // turn block
    expect(classify(0x6D, 1, 0x01).slopeResolved).toBe(false)  // boundary - 1
    expect(classify(0xD8, 1, 0x01).slopeResolved).toBe(false)  // boundary + 1
    expect(classify(0xFF, 1, 0x01).slopeResolved).toBe(false)
  })

  it('every DATA_00EAC1 member emits slope when placed page-1+', () => {
    for (const low of SLOPE_TABLE) {
      expect(classify(low, 1, 0x01).slopeResolved, `tileset 1 high=$01 low=$${low.toString(16)}`).toBe(true)
      expect(classify(low, 0, 0x01).slopeResolved, `tileset 0 high=$01 low=$${low.toString(16)}`).toBe(true)
      expect(classify(low, 7, 0x01).slopeResolved, `tileset 7 high=$01 low=$${low.toString(16)}`).toBe(true)
    }
  })
})
