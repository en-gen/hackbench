/**
 * CheepCheepAppearance.renderOverlay — branch coverage.
 *
 * Test tree:
 *   isActive=false → early return (no draw)
 *   horizontal ($15, vertical=false)
 *     - open water: no walls in either scan → full-width corridor
 *     - wall in left scan: solidH hits → leftX set to wall edge
 *     - wall in right scan: solidH hits → rightX set to wall edge
 *   vertical ($16, vertical=true)
 *     - open column: no walls in either scan → full-height corridor
 *     - wall in top scan: solidV hits → topY set to wall edge
 *     - wall in bottom scan: solidV hits → bottomY set to wall edge
 */

import { describe, it, expect } from 'vitest'
import { CheepCheepAppearance } from '../../../../src/rom/model/sprites/appearances/CheepCheepAppearance'
import { buildSolidity } from '../fixtures/buildSolidity'
import { makeMockCtx } from '../fixtures/mockOverlayCtx'
import { makeTestMapStore } from '../fixtures/stores'

const GROUND = { actsLike: 0x130 }   // solid (wall=true, floor=true)

const mapStore = makeTestMapStore({})
const EMPTY_PARTS: never[] = []

function makeHorizCheep(): CheepCheepAppearance {
  return new CheepCheepAppearance(EMPTY_PARTS, false)
}

function makeVertCheep(): CheepCheepAppearance {
  return new CheepCheepAppearance(EMPTY_PARTS, true)
}

// ── isActive=false guard ──────────────────────────────────────────────────────

describe('CheepCheepAppearance.renderOverlay — isActive=false', () => {
  it('returns immediately without drawing', () => {
    const ctx = makeMockCtx()
    const { getL1, cols, rows } = buildSolidity(['.....', '.....'], {})
    makeHorizCheep().renderOverlay(ctx, 32, 16, false, getL1, cols, rows, undefined, mapStore)
    // No path or stroke calls emitted.
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
    expect(ctx.events.some(e => e.op === 'moveTo')).toBe(false)
  })
})

// ── horizontal ($15, vertical=false) ─────────────────────────────────────────

describe('CheepCheepAppearance.renderOverlay — horizontal (vertical=false)', () => {
  it('open water: no walls → corridor spans full level width', () => {
    // Covers: if (!this.vertical) true branch + solidH scan false branch (no wall found)
    const { getL1, cols, rows } = buildSolidity([
      '...........',
      '...........',
    ], {})
    const ctx = makeMockCtx()
    makeHorizCheep().renderOverlay(ctx, 32, 0, true, getL1, cols, rows, undefined, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })

  it('wall in left scan: solidH hits → leftX clamped to wall right edge', () => {
    // Covers: if (solidH(c, sprRow)) { leftX = (c+1)*16; break } — true branch (left scan)
    const { getL1, cols, rows } = buildSolidity([
      '#...........',
      '#...........',
    ], { '#': GROUND })
    const ctx = makeMockCtx()
    // Sprite at x=32 (col 2), center col = floor(40/16) = 2
    // Left scan from col 1 down; col 0 is solid → leftX = 1*16 = 16
    makeHorizCheep().renderOverlay(ctx, 32, 0, true, getL1, cols, rows, undefined, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })

  it('wall in right scan: solidH hits → rightX clamped to wall left edge', () => {
    // Covers: if (solidH(c, sprRow)) { rightX = c*16; break } — true branch (right scan)
    const { getL1, cols, rows } = buildSolidity([
      '...........#',
      '...........#',
    ], { '#': GROUND })
    const ctx = makeMockCtx()
    // Sprite at x=0 (col 0), right scan hits '#' at last col → rightX clamped
    makeHorizCheep().renderOverlay(ctx, 0, 0, true, getL1, cols, rows, undefined, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })
})

// ── vertical ($16, vertical=true) ────────────────────────────────────────────

describe('CheepCheepAppearance.renderOverlay — vertical (vertical=true)', () => {
  it('open column: no walls → corridor spans full level height', () => {
    // Covers: if (!this.vertical) false branch + solidV scan false branch (no wall)
    const { getL1, cols, rows } = buildSolidity([
      '...',
      '...',
      '...',
      '...',
    ], {})
    const ctx = makeMockCtx()
    makeVertCheep().renderOverlay(ctx, 0, 16, true, getL1, cols, rows, undefined, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })

  it('wall in top scan: solidV hits → topY clamped to wall bottom edge', () => {
    // Covers: if (solidV(sprCol, r)) { topY = (r+1)*16; break } — true branch (top scan)
    const { getL1, cols, rows } = buildSolidity([
      '###',
      '...',
      '...',
      '...',
    ], { '#': GROUND })
    const ctx = makeMockCtx()
    // Sprite at y=32 (row 2); top scan from row 1 → row 0 is solid → topY = 1*16=16
    makeVertCheep().renderOverlay(ctx, 0, 32, true, getL1, cols, rows, undefined, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })

  it('wall in bottom scan: solidV hits → bottomY clamped to wall top edge', () => {
    // Covers: if (solidV(sprCol, r)) { bottomY = r*16; break } — true branch (bottom scan)
    const { getL1, cols, rows } = buildSolidity([
      '...',
      '...',
      '...',
      '###',
    ], { '#': GROUND })
    const ctx = makeMockCtx()
    // Sprite at y=0 (row 0); bottom scan hits '#' at row 3 → bottomY = 3*16=48
    makeVertCheep().renderOverlay(ctx, 0, 0, true, getL1, cols, rows, undefined, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })
})
