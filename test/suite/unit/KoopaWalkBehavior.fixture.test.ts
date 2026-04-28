/**
 * KoopaWalkBehavior patrol-range against the level $11E fixture.
 *
 * User-reported regression: red koopa $05 at grid (c41, r24) should
 * walk LEFT across the platform top to the ledge at (c39, r25), but the
 * editor renders very narrow walls right next to the sprite. The
 * platform spans c39-c41 at r25 and the column to the koopa's left
 * (c40 r24) is a page-0 tree-trunk tile (passable per ROM).
 *
 * Skips when `HACKBENCH_FIXTURES_DIR` is unset (Mesen captures aren't
 * redistributable).
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { KoopaWalkBehavior, propsFromSpriteId } from '../../../src/rom/model/sprites/behaviors/KoopaWalkBehavior'
import { loadMesenFixture } from './fixtures/loadMesenFixture'

const FIXTURES_DIR = process.env.HACKBENCH_FIXTURES_DIR
const FIXTURE = FIXTURES_DIR ? join(FIXTURES_DIR, '11e', 'map16.txt') : null
const TILE = 16
const skip = !FIXTURE || !existsSync(FIXTURE)
const d = skip ? describe.skip : describe

d('KoopaWalkBehavior — level $11E red koopa $05 patrol', () => {
  const fix = !skip && FIXTURE ? loadMesenFixture(FIXTURE) : null
  // Per the $11E ROM: the three forest-trunk-and-leaf pillars run in
  // vertical columns at c35, c40, c45 — top to bottom. The user
  // confirmed via Mesen that ALL tiles in these columns carry the
  // priority bit (including the platform $10D and base $0BE at r25/r26
  // inside the pillar's column). Mesen dumps don't capture priority
  // (it lives in Map16 table, not tile-number RAM), so we feed the
  // priority columns explicitly.
  const fixWithPriorityTrunks = !skip && FIXTURE
    ? loadMesenFixture(FIXTURE, { priorityCols: new Set([35, 40, 45]) })
    : null

  it('platform tiles c39-c41 at r25 are detected as floor', () => {
    if (!fix) return
    expect(fix.solidV(39, 25)).toBe(true)
    expect(fix.solidV(40, 25)).toBe(true)
    expect(fix.solidV(41, 25)).toBe(true)
    // c38 r25 and c42 r25 are air (the gaps that bound the platform).
    expect(fix.solidV(38, 25)).toBe(false)
    expect(fix.solidV(42, 25)).toBe(false)
  })

  it('trunk tile c40 r24 is passable for sprites (page-0)', () => {
    if (!fix) return
    expect(fix.solidH(40, 24)).toBe(false)
    expect(fix.solidH(40, 23)).toBe(false)
  })

  it('patrol corridor spans c39 left edge to c42 left edge', () => {
    if (!fix) return
    const beh = new KoopaWalkBehavior(propsFromSpriteId(0x05))
    // Sprite top-left at (c41, r24) → pixel (656, 384).
    const range = beh.computePatrolRange(
      41 * TILE, 24 * TILE, fix.solidH, fix.solidV, fix.cols, fix.rows, fix.getL1,
    )
    // Left boundary should be at c39 left edge = 624 (turnLedge for $05).
    expect(range.leftX, 'left boundary should be at c39 left edge').toBe(39 * TILE)
    expect(range.leftKind, 'left side ends at the platform ledge').toBe('turnLedge')
    // Right boundary should be at c42 left edge = 672 (turnLedge — gap to the right).
    expect(range.rightX, 'right boundary should be at c42 left edge').toBe(42 * TILE)
    expect(range.rightKind, 'right side ends at the platform ledge').toBe('turnLedge')
  })

  it('priority on entire trunk column (c40) does not collapse the corridor', () => {
    // Regression target. With priority on c35/c40/c45 (the three forest
    // pillars), `SurfacePath` previously skipped c40 r25 ($10D) and the
    // koopa saw a ledge at c41/c40 boundary — collapsing the corridor.
    if (!fixWithPriorityTrunks) return
    const beh = new KoopaWalkBehavior(propsFromSpriteId(0x05))
    const range = beh.computePatrolRange(
      41 * TILE, 24 * TILE,
      fixWithPriorityTrunks.solidH, fixWithPriorityTrunks.solidV,
      fixWithPriorityTrunks.cols, fixWithPriorityTrunks.rows,
      fixWithPriorityTrunks.getL1,
    )
    expect(range.leftX,  'left boundary must still reach c39 with priority trunks').toBe(39 * TILE)
    expect(range.rightX, 'right boundary must still reach c42 with priority trunks').toBe(42 * TILE)
    expect(range.leftKind).toBe('turnLedge')
    expect(range.rightKind).toBe('turnLedge')
  })
})
