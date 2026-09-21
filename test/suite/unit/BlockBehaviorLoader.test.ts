/**
 * Tests for the block-behavior table (`DATA_00F05C`) reader and the
 * wall-classification helper. The table is the ROM-side source of truth
 * for whether a tile with low byte $11-$34 blocks sprite horizontal
 * motion - coins ($02), vines ($03), and empty ($00) block-behavior
 * types are NOT walls even when their low byte falls in the wall range.
 */

import { describe, expect, it } from 'vitest'
import {
  BH_COIN,
  BH_EMPTY,
  BH_TURN_BLOCK,
  BH_VINE,
  BLOCK_BEHAVIOR_BASE,
  BLOCK_BEHAVIOR_LEN,
  blockBehaviorFor,
  isBlockBehaviorWall,
  isMarioStandable,
  isSlopeTile,
  SLOPE_TABLE_LEN,
} from '../../../src/rom/BlockBehaviorLoader'

/** Vanilla SMW's `DATA_00F05C` (bank_00.asm:12744). */
const VANILLA_TABLE = new Uint8Array([
  0x01,
  0x05,
  0x01,
  0x02,
  0x01,
  0x01,
  0x00,
  0x00, // $11-$18
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x06,
  0x02,
  0x02, // $19-$20
  0x02,
  0x02,
  0x02,
  0x02,
  0x02,
  0x02,
  0x02,
  0x02, // $21-$28
  0x02,
  0x03,
  0x03,
  0x04,
  0x02,
  0x02,
  0x02,
  0x01, // $29-$30
  0x01,
  0x07,
  0x11,
  0x10, // $31-$34
])

describe('blockBehaviorFor', () => {
  it('low byte below $11 returns null (outside table)', () => {
    expect(blockBehaviorFor(0x010, VANILLA_TABLE)).toBeNull()
    expect(blockBehaviorFor(0x000, VANILLA_TABLE)).toBeNull()
  })

  it('low byte above $34 returns null (outside table)', () => {
    expect(blockBehaviorFor(0x035, VANILLA_TABLE)).toBeNull()
    expect(blockBehaviorFor(0x06d, VANILLA_TABLE)).toBeNull()
  })

  it('low byte $11 (turn block) → $01', () => {
    expect(blockBehaviorFor(0x111, VANILLA_TABLE)).toBe(0x01)
  })

  it('low byte $2D / $2E (dragon coins) → $02 coin', () => {
    expect(blockBehaviorFor(0x02d, VANILLA_TABLE)).toBe(BH_COIN)
    expect(blockBehaviorFor(0x02e, VANILLA_TABLE)).toBe(BH_COIN)
  })

  it('low byte $2A / $2B (vines) → $03 vine', () => {
    expect(blockBehaviorFor(0x02a, VANILLA_TABLE)).toBe(BH_VINE)
    expect(blockBehaviorFor(0x02b, VANILLA_TABLE)).toBe(BH_VINE)
  })

  it('high byte ignored - only the low byte indexes the table', () => {
    expect(blockBehaviorFor(0x12d, VANILLA_TABLE)).toBe(BH_COIN)
    expect(blockBehaviorFor(0x1ff, VANILLA_TABLE)).toBeNull()
  })

  it('range constants cover 36 entries from $11', () => {
    expect(BLOCK_BEHAVIOR_BASE).toBe(0x11)
    expect(BLOCK_BEHAVIOR_LEN).toBe(0x24)
  })
})

describe('isSlopeTile - DATA_00EAC1 linear search', () => {
  // Vanilla SMW DATA_00EAC1 bytes (bank_00.asm:11946).
  const VANILLA_SLOPE_TABLE = new Uint8Array([
    0x71, 0x72, 0x76, 0x77, 0x7b, 0x7c, 0x81, 0x86, 0x8a, 0x8b, 0x8f, 0x90, 0x94, 0x95, 0x99, 0x9a,
    0x9e, 0x9f, 0xa3, 0xa4, 0xa8, 0xa9, 0xad, 0xae, 0xb2, 0xb3,
  ])

  it('26 entries covering the vanilla slope low-byte range', () => {
    expect(SLOPE_TABLE_LEN).toBe(26)
    expect(VANILLA_SLOPE_TABLE.length).toBe(SLOPE_TABLE_LEN)
  })

  it('known vanilla slope tiles return true', () => {
    expect(isSlopeTile(0x071, VANILLA_SLOPE_TABLE)).toBe(true) // first entry
    expect(isSlopeTile(0x076, VANILLA_SLOPE_TABLE)).toBe(true)
    expect(isSlopeTile(0x0b3, VANILLA_SLOPE_TABLE)).toBe(true) // last entry
  })

  it('non-slope tiles return false', () => {
    expect(isSlopeTile(0x070, VANILLA_SLOPE_TABLE)).toBe(false) // gap
    expect(isSlopeTile(0x073, VANILLA_SLOPE_TABLE)).toBe(false) // gap
    expect(isSlopeTile(0x100, VANILLA_SLOPE_TABLE)).toBe(false) // far out
    expect(isSlopeTile(0x2d, VANILLA_SLOPE_TABLE)).toBe(false) // dragon coin
  })

  it('high byte ignored - membership is on low byte only', () => {
    // Matches CODE_00F04D's `LDA.L DATA_00EAC1,X` + CMP on low byte only.
    expect(isSlopeTile(0x171, VANILLA_SLOPE_TABLE)).toBe(true)
    expect(isSlopeTile(0x1b3, VANILLA_SLOPE_TABLE)).toBe(true)
  })
})

describe('isBlockBehaviorWall', () => {
  // The block-behavior table describes what HAPPENS on hit (generate
  // coin, grow vine, etc.) - not whether the tile is solid. Only $00
  // (empty - no hit handler) excludes the tile from wall classification.
  // `?`-blocks with behavior $02 (coin-generator) are still walls -
  // they're solid for Mario to stand on / bump into.

  it('turn block / brown block / coin-gen / vine / invis-coin / note / P-switch → wall', () => {
    expect(isBlockBehaviorWall(BH_TURN_BLOCK)).toBe(true)
    expect(isBlockBehaviorWall(0x05)).toBe(true)
    expect(isBlockBehaviorWall(BH_COIN)).toBe(true) // ? block - solid
    expect(isBlockBehaviorWall(BH_VINE)).toBe(true) // vine source - solid
    expect(isBlockBehaviorWall(0x04)).toBe(true) // invisible coin block - solid
    expect(isBlockBehaviorWall(0x10)).toBe(true) // note block
  })

  it('empty → not wall', () => {
    expect(isBlockBehaviorWall(BH_EMPTY)).toBe(false)
  })
})

describe('isMarioStandable', () => {
  // A Mario-surface is a tile that ALWAYS stops Mario's movement
  // regardless of tileset or state. Tiles whose Mario dispatch passes
  // Mario through (climbables, coins, midway, moon coin) or is
  // tileset-dependent (checkpoint decoration $66-$69) are excluded.
  //
  // Spike $2F is NOT excluded - it stops Mario universally via the
  // sprite-range collision. Hurt damage is orthogonal to "is this a
  // surface?".

  it('standard solid low bytes (not in exclusion set) return true', () => {
    expect(isMarioStandable(0x11)).toBe(true) // turn block
    expect(isMarioStandable(0x1f)).toBe(true) // ? block (coin-generator, still solid)
    expect(isMarioStandable(0x30)).toBe(true) // not a vanilla-excluded id
    expect(isMarioStandable(0x65)).toBe(true)
  })

  it('vanilla page-0 IDs previously excluded are now allowed (ASM port takes over)', () => {
    // After removing the Category-2 vanilla hand-list, these return
    // true here. Their actual Mario-floor / ceiling / wall status is
    // determined by TileFactory.classify using marioFeetLanding +
    // marioTileDispatch + sprite range - this loader-level filter is
    // only for wide low-byte patterns (coins, checkpoint decoration).
    expect(isMarioStandable(0x02f)).toBe(true)
    expect(isMarioStandable(0x032)).toBe(true)
    expect(isMarioStandable(0x038)).toBe(true)
    expect(isMarioStandable(0x039)).toBe(true)
    expect(isMarioStandable(0x03c)).toBe(true)
    expect(isMarioStandable(0x03f)).toBe(true)
  })

  it('climbable range $06-$1C is NOT excluded (feet dispatch differs from body)', () => {
    // `CODE_00F2C9` sets InteractionPtsClimbable for $06-$1C but that's
    // body-overlap grab logic, not feet-level stop. `CODE_00F127` routes
    // $11-$2D to F160 → F17F as solid, so turn blocks at $11-$1C stop
    // Mario from above.
    expect(isMarioStandable(0x11)).toBe(true) // turn block
    expect(isMarioStandable(0x1c)).toBe(true) // brown block
    expect(isMarioStandable(0x06)).toBe(true) // vine graphic - Mario
    // doesn't auto-stop here, but he's not excluded by the static
    // classifier. Actual grab/pass behavior is state-dependent input.
  })

  it('coin / dragon coin / Yoshi coin $2A-$2E excluded', () => {
    expect(isMarioStandable(0x2a)).toBe(false)
    expect(isMarioStandable(0x2c)).toBe(false)
    expect(isMarioStandable(0x2e)).toBe(false)
  })

  it('checkpoint decoration $66-$69 excluded (tileset-dep wide pattern)', () => {
    expect(isMarioStandable(0x66)).toBe(false)
    expect(isMarioStandable(0x67)).toBe(false)
    expect(isMarioStandable(0x68)).toBe(false)
    expect(isMarioStandable(0x69)).toBe(false)
  })

  it('midway tape $38 NOT excluded by low-byte filter (feet-landing dispatch handles it via CODE_00F2C9)', () => {
    // Previously excluded as a specific vanilla tile. With the port
    // of CODE_00EDF7, midway tape is Mario-feet-solid per ASM; the
    // special midway handler is a separate side-effect. The overlay
    // reflects the ASM answer directly.
    expect(isMarioStandable(0x38)).toBe(true)
  })

  it('moon coin $6E NOT excluded by low-byte filter', () => {
    // Moon coin's collection side-effect (CODE_00F311) doesn't change
    // the feet-landing answer. Per CODE_00EDF7, $6E is within the
    // $00-$6D solid range boundary - actually $6E is slope range
    // ($6E-$D7), so marioFeetLanding returns 'slope'. marioFloor
    // handles it via slopeTable membership check.
    expect(isMarioStandable(0x6e)).toBe(true)
  })

  it('boundary tiles adjacent to exclusion ranges return true', () => {
    expect(isMarioStandable(0x05)).toBe(true) // just below climbable
    expect(isMarioStandable(0x1d)).toBe(true) // just above climbable
    expect(isMarioStandable(0x29)).toBe(true) // just below coin
    expect(isMarioStandable(0x65)).toBe(true) // just below checkpoint
    expect(isMarioStandable(0x6a)).toBe(true) // just above checkpoint
    expect(isMarioStandable(0x6d)).toBe(true) // just below moon
    expect(isMarioStandable(0x6f)).toBe(true) // just above moon
  })
})
