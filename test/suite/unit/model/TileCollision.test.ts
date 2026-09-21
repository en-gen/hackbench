/**
 * TileCollision invariants - verifies that the Mario-perspective
 * fields are properly derived from sprite-perspective fields + the
 * `isMarioStandable` exclusion list, for the full low-byte range.
 *
 * Uses a plain re-implementation of classify's arithmetic so we're
 * testing the data relationship, not the TileFactory plumbing.
 */

import { describe, expect, it } from 'vitest'
import { isMarioStandable, isSlopeTile } from '../../../../src/rom/BlockBehaviorLoader'
import {
  marioFeetLanding,
  marioTileDispatch,
  marioTileSolidity,
  PSWITCH_INACTIVE,
  type MarioDispatchTables,
} from '../../../../src/rom/MarioTileDispatch'
import { resolveSlope, type SlopeTables } from '../../../../src/rom/SlopeResolver'

/** Vanilla SMW `DATA_00EAC1` (bank_00.asm:11946). */
const SLOPE_TABLE = new Uint8Array([
  0x71, 0x72, 0x76, 0x77, 0x7b, 0x7c, 0x81, 0x86, 0x8a, 0x8b, 0x8f, 0x90, 0x94, 0x95, 0x99, 0x9a,
  0x9e, 0x9f, 0xa3, 0xa4, 0xa8, 0xa9, 0xad, 0xae, 0xb2, 0xb3,
])

/** Vanilla SMW Mario-dispatch tables. */
const DISPATCH_TABLES: MarioDispatchTables = {
  dataA625: new Uint8Array([
    0x00, 0x80, 0x40, 0x00, 0x01, 0x02, 0x40, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00,
  ]),
  dataF0A4: new Uint8Array([
    0x0c, 0x08, 0x0c, 0x08, 0x0c, 0x0f, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
    0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x03, 0x03, 0x08, 0x08, 0x08, 0x08, 0x08,
    0x08, 0x04, 0x08, 0x08,
  ]),
  dataF0EC: new Uint8Array([
    0x08, 0x01, 0x02, 0x04, 0xed, 0xf6, 0x00, 0x7d, 0xbe, 0x00, 0x6f, 0xb7,
  ]),
}

/** Vanilla SMW `DATA_00E55E` (bank_00.asm:11572). */
const VANILLA_E55E = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03,
  0x03, 0x03, 0x03, 0x03, 0x04, 0x04, 0x04, 0x04, 0x04, 0x05, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06,
  0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07, 0x07, 0x08, 0x08, 0x08, 0x08, 0x08, 0x09, 0x09, 0x09,
  0x09, 0x09, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0c, 0x0c, 0x0c, 0x0c,
  0x0c, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x03, 0x03, 0x04, 0x04, 0x09, 0x09,
  0x0a, 0x0a, 0x0c, 0x0c, 0x0d, 0x0d, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x1c, 0x1d, 0x1e, 0x1f,
  0x18, 0x19, 0x1a, 0x1b, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
])
const VANILLA_E5C8 = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03,
  0x03, 0x03, 0x03, 0x03, 0x04, 0x04, 0x04, 0x04, 0x04, 0x05, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06,
  0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07, 0x07, 0x08, 0x08, 0x08, 0x08, 0x08, 0x09, 0x09, 0x09,
  0x09, 0x09, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0c, 0x0c, 0x0c, 0x0c,
  0x0c, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x03, 0x03, 0x04, 0x04, 0x09, 0x09,
  0x0a, 0x0a, 0x0c, 0x0c, 0x0d, 0x0d, 0x0c, 0x0d, 0x0d, 0x0c, 0x16, 0x17, 0x1c, 0x1d, 0x1e, 0x1f,
  0x18, 0x19, 0x1a, 0x1b, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
])
/** Synthetic DATA_00E632 - only slope index 0 is asserted. */
const SYNTHETIC_E632 = (() => {
  const t = new Uint8Array(510)
  t.set(
    [
      0x0f, 0x0f, 0x0f, 0x0f, 0x0e, 0x0e, 0x0e, 0x0e, 0x0d, 0x0d, 0x0d, 0x0d, 0x0c, 0x0c, 0x0c,
      0x0c,
    ],
    0,
  )
  return t
})()
const SLOPE_TABLES: SlopeTables = {
  heightTable: SYNTHETIC_E632,
  indexMapDefault: VANILLA_E55E,
  indexMapOverworld: VANILLA_E5C8,
}

/**
 * Mirror of `TileFactory.classify`'s arithmetic - extracted here so
 * tests can verify the invariants without going through the ROM
 * load / factory build pipeline. Any change to classify must be
 * reflected here (and vice versa).
 */
function classify(
  low: number,
  tileset: number = 1,
  high: number = 0,
): {
  floor: boolean
  ceiling: boolean
  wall: boolean
  marioFloor: boolean
  marioCeiling: boolean
  marioWall: boolean
  slopeTable: boolean
  /** True when `classify` emits a `slope` field. Mirrors the
   *  `marioSolid && resolveSlope(low, tileset, slopeTables)` gate in
   *  `TileFactory.classify` - F545 non-solid tiles never carry slope
   *  data even when their low byte is in $6E-$D7. */
  slopeResolved: boolean
} {
  const lo = low & 0xff
  const hi = high & 0xff
  const isPage0 = hi === 0

  // Sprite-side fields mirror CODE_01928E / CODE_0192C9 / CODE_01933B -
  // page-0 high-byte BEQ skip, then a pure low-byte range check. The
  // ROM does NOT consult DATA_00F05C (block-behavior table) for sprite
  // collision; that table governs Mario's hit-from-below dispatch
  // (CODE_00F17F) only.
  const inSolidRange = lo >= 0x11 && lo <= 0x6d
  const inTilesetWindow = tileset !== 0 && tileset !== 7 && lo >= 0xc4 && lo <= 0xc9
  const wall = !isPage0 && inSolidRange
  const floor = !isPage0 && (lo <= 0x10 || inSolidRange || lo >= 0xd8)
  const ceiling = !isPage0 && (inSolidRange || inTilesetWindow)
  const slopeTable = isSlopeTile(lo, SLOPE_TABLE)

  const dispatch0 = marioTileDispatch(lo, tileset, 0, DISPATCH_TABLES)
  const dispatch1 = marioTileDispatch(lo, tileset, 1, DISPATCH_TABLES)
  const dispatch2 = marioTileDispatch(lo, tileset, 2, DISPATCH_TABLES)
  const dispatch3 = marioTileDispatch(lo, tileset, 3, DISPATCH_TABLES)
  const hurtsFromAnyDir =
    dispatch0.kind === 'hurt' ||
    dispatch1.kind === 'hurt' ||
    dispatch2.kind === 'hurt' ||
    dispatch3.kind === 'hurt'
  // F0EC direction encoding per PlayerBlockedDir (rammap.asm:632):
  //   dir 0 → head bump (CEILING), dir 3 → feet landing (FLOOR),
  //   dir 1/2 → sides (WALL).
  const hitOnHead = dispatch0.kind === 'hit'
  const hitOnSides = dispatch1.kind === 'hit' || dispatch2.kind === 'hit'
  const hitOnFeet = dispatch3.kind === 'hit'
  const feetLanding = marioFeetLanding(lo, tileset)
  const marioOk = isMarioStandable(lo) && !hurtsFromAnyDir
  const marioSolid = marioTileSolidity(lo, hi, PSWITCH_INACTIVE)
  const marioInCeilingWindow = tileset !== 0 && tileset !== 7 && lo >= 0xc4 && lo <= 0xc9
  const marioFloor = (marioSolid || hitOnFeet) && feetLanding.kind === 'land' && marioOk
  const marioCeiling =
    (marioSolid || hitOnHead) && (inSolidRange || marioInCeilingWindow) && marioOk
  const marioWall = (marioSolid || hitOnSides) && inSolidRange && marioOk

  // Phase 3: slope resolution is gated by F545 solidity. Mirrors the
  // `marioSolid ? resolveSlope(...) : null` call in TileFactory.classify
  // and the ROM's `JSR CODE_00F44D / BNE` gate at bank_00.asm:12393.
  const slope = marioSolid ? resolveSlope(lo, tileset, SLOPE_TABLES) : null
  const slopeResolved = slope !== null

  return { floor, ceiling, wall, marioFloor, marioCeiling, marioWall, slopeTable, slopeResolved }
}

describe('TileCollision invariants', () => {
  it('sprite-perspective and Mario-perspective are decoupled', () => {
    // Sprite fields (CODE_01928E / CODE_0192C9 / CODE_01933B) are
    // page-0 BEQ + low-byte range. Mario fields (F545 + F127 + standable)
    // run a separate dispatch - they can fire on PAGE-0 tiles that
    // sprites skip entirely (e.g. hidden $021 head-bump → marioCeiling
    // true, sprite ceiling false because of the page-0 BEQ). Neither
    // is a subset of the other; this test guards against a future
    // refactor accidentally collapsing them.
    let anyMarioNotSprite = false
    for (let lo = 0; lo < 0x100; lo++) {
      const page0 = classify(lo, 1, 0x00)
      // Page-0 hidden / head-bump tiles fire F127 dispatch → Mario
      // marioCeiling true, sprite ceiling false (page-0 BEQ skip).
      if (page0.marioCeiling && !page0.ceiling) anyMarioNotSprite = true
    }
    expect(anyMarioNotSprite).toBe(true)
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

describe('TileCollision - known tile IDs', () => {
  it('?-block page-0 low $1F: sprite-passthrough (page-0), Mario head-bump via F127', () => {
    // Page-0 high byte → CODE_01928E / CODE_0192C9 BEQ skip - sprite
    // collision is unconditionally off, so floor / wall / ceiling all
    // false. Mario's path is independent: F545 SBC #$EC = $33, BCS
    // F592 → non-solid, but F0A4[$0E] = $08 (bit 3 = PlayerBlock_Top)
    // makes the F127 head-bump fire. marioCeiling unions the two.
    const c = classify(0x1f, 1, 0x00)
    expect(c.floor).toBe(false)
    expect(c.ceiling).toBe(false)
    expect(c.wall).toBe(false)
    expect(c.marioFloor).toBe(false)
    expect(c.marioCeiling).toBe(true) // F127 head-bump fires
    expect(c.marioWall).toBe(false)
  })

  it('invisible coin block $021: F545 non-solid but F127 head-bump → marioCeiling', () => {
    // The canonical hidden block. F545 page-0 says non-solid (Mario
    // walks through freely until he jumps up into it). F0A4[$10] = $08
    // (bit 3 = PlayerBlock_Top), matching F127 dir 0 - head bump fires
    // the reveal-to-$123 + coin-spawn action. The overlay must surface
    // this so designers see where hidden blocks land.
    const c = classify(0x21, 1, 0x00)
    expect(c.marioCeiling).toBe(true)
    expect(c.marioFloor).toBe(false) // no feet-landing action
    expect(c.marioWall).toBe(false) // no side action
  })

  it('?-block page-1 low $11F: solid for both sprite AND Mario', () => {
    // High=$01 → F545 F577 branch → A = $01 → solid.
    const c = classify(0x1f, 1, 0x01)
    expect(c.wall).toBe(true)
    expect(c.marioFloor).toBe(true)
    expect(c.marioCeiling).toBe(true)
    expect(c.marioWall).toBe(true)
  })

  it('midway tape page-0 low $38: page-0 sprite-passthrough, Mario-non-solid', () => {
    // F545: high=0, low=$38, SBC #$EC = $4C, BCS F592 → non-solid.
    // Sprite-side is also off because high=0 trips the page-0 BEQ in
    // CODE_01928E / CODE_0192C9 - both perspectives walk through.
    const c = classify(0x38, 1, 0x00)
    expect(c.floor).toBe(false)
    expect(c.wall).toBe(false)
    expect(c.marioFloor).toBe(false)
    expect(c.marioWall).toBe(false)
  })

  it('checkpoint post body page-0 low $32: page-0 sprite-passthrough, Mario-non-solid', () => {
    const c = classify(0x32, 1, 0x00)
    expect(c.wall).toBe(false) // page-0 → sprite skipped
    expect(c.marioWall).toBe(false) // F545 says non-solid
    expect(c.marioFloor).toBe(false)
  })

  it('item block page-1 low $11A: marioCeiling=true (head-bumpable)', () => {
    // F05C[$1A] = $00 (BH_EMPTY). The sprite collision routines
    // CODE_01928E / CODE_0192C9 (bank_01.asm:2613/2646) gate on
    // page-0 high byte + low-byte range only - they do NOT consult
    // F05C, so sprite-side floor/wall/ceiling are TRUE for any
    // page-1+ tile in the $11-$6D range, regardless of block-behavior
    // type. Mario's perspective uses F545 + F127 unioned with the
    // hurt/standable filter - both report true here.
    const c = classify(0x1a, 1, 0x01)
    expect(c.floor).toBe(true)
    expect(c.ceiling).toBe(true)
    expect(c.wall).toBe(true)
    expect(c.marioCeiling).toBe(true) // Mario path includes
    expect(c.marioFloor).toBe(true) // ?-blocks are also stand-on-able
  })

  it('wooden-plank page-1 low $11C: sprite floor/wall/ceiling all TRUE despite F05C=$00', () => {
    // F05C[$1C] = $00 (BH_EMPTY) - historically gated sprite collision
    // off, causing patrol overlays to fall through wood-plank /
    // empty-block tiles like $11C. The ROM itself never gates on
    // F05C for sprite collision (CODE_01928E/CODE_0192C9 - pure range
    // check after the page-0 BEQ), and sprites visibly stand on
    // these tiles in vanilla levels (e.g. red koopa $005 on $11C
    // platforms in level $103). Lock the sprite-side TRUE so the
    // patrol-overlay surface path agrees with what the editor's
    // "Show surfaces" yellow line shows for the same tile.
    const c = classify(0x1c, 1, 0x01)
    expect(c.floor).toBe(true)
    expect(c.wall).toBe(true)
    expect(c.ceiling).toBe(true)
    expect(c.marioFloor).toBe(true)
  })

  it('spike $02F: page-0 sprite-passthrough, Mario excluded via F127 hurt', () => {
    // Spike is page-0 ($0xx) → sprite collision skipped per the high-
    // byte BEQ in CODE_01928E. Mario excluded via the F127 hurt path
    // (independent of sprite gating).
    const c = classify(0x02f, 1, 0x00)
    expect(c.floor).toBe(false)
    expect(c.wall).toBe(false)
    expect(c.marioFloor).toBe(false)
    expect(c.marioWall).toBe(false)
  })

  it('checkpoint decoration low $68 tileset 1: page-0 sprite-passthrough, Mario excluded via F127 hurt', () => {
    const c = classify(0x68, 1, 0x00)
    expect(c.floor).toBe(false)
    expect(c.wall).toBe(false)
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

describe('TileCollision - Phase 3 slope field', () => {
  it('page-1 slope tile (e.g. $171) emits slope (F545 says solid)', () => {
    // High=$01 → F545 default branch returns A=$01 (solid). Low $71 is
    // in the $6E-$D7 slope range, so resolveSlope returns a SlopeInfo.
    expect(classify(0x71, 1, 0x01).slopeResolved).toBe(true)
    expect(classify(0xb3, 1, 0x01).slopeResolved).toBe(true) // last EAC1 entry
  })

  it('page-0 slope-range tile (e.g. $073 bush, $0A6 lava-corner) emits NO slope', () => {
    // F545 with high=$00 returns non-solid for low bytes outside the
    // P-switch / switch-palace special cases. These tiles render as
    // decorative graphics only - Mario walks straight through them and
    // the ROM never enters the slope-angle dispatch (CODE_00EDE9
    // BEQ at bank_00.asm:12393-12394 short-circuits to F309).
    //
    // Without the F545 gate the overlay would draw misleading slope
    // lines on $073 / $074 / $079 bush graphics and $0A3 / $0A6 lava
    // corners - the bug the user flagged in the level-screen 1 review.
    expect(classify(0x73, 1, 0x00).slopeResolved).toBe(false)
    expect(classify(0x74, 1, 0x00).slopeResolved).toBe(false)
    expect(classify(0x79, 1, 0x00).slopeResolved).toBe(false)
    expect(classify(0xa3, 1, 0x00).slopeResolved).toBe(false)
    expect(classify(0xa6, 1, 0x00).slopeResolved).toBe(false)
    expect(classify(0x71, 1, 0x00).slopeResolved).toBe(false) // even EAC1 members
  })

  it('low byte outside the $6E-$D7 SlopesPtr range never emits slope', () => {
    // Whether F545 says solid or not, low bytes outside the slope
    // map range fall through resolveSlope to null.
    expect(classify(0x00, 1, 0x01).slopeResolved).toBe(false)
    expect(classify(0x11, 1, 0x01).slopeResolved).toBe(false) // turn block
    expect(classify(0x6d, 1, 0x01).slopeResolved).toBe(false) // boundary - 1
    expect(classify(0xd8, 1, 0x01).slopeResolved).toBe(false) // boundary + 1
    expect(classify(0xff, 1, 0x01).slopeResolved).toBe(false)
  })

  it('every DATA_00EAC1 member emits slope when placed page-1+', () => {
    for (const low of SLOPE_TABLE) {
      expect(
        classify(low, 1, 0x01).slopeResolved,
        `tileset 1 high=$01 low=$${low.toString(16)}`,
      ).toBe(true)
      expect(
        classify(low, 0, 0x01).slopeResolved,
        `tileset 0 high=$01 low=$${low.toString(16)}`,
      ).toBe(true)
      expect(
        classify(low, 7, 0x01).slopeResolved,
        `tileset 7 high=$01 low=$${low.toString(16)}`,
      ).toBe(true)
    }
  })
})
