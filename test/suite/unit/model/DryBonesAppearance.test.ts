/**
 * DryBonesAppearance.test.ts — branch coverage for renderOverlay + fromTables.
 *
 * Test tree:
 *   renderOverlay() guard
 *     - isActive=false → no draw
 *     - behavior not instanceof KoopaWalkBehavior → no draw
 *     - isActive=true + KoopaWalkBehavior → drawPatrolPath called (stroke emitted)
 *   fromTables()
 *     - faceRight=true  → flipX=true, topDx=+8 (column order [1,0,3,2])
 *     - faceRight=false → flipX=false, topDx=-8 (column order [0,1,2,3])
 */

import { describe, it, expect } from 'vitest'
import { DryBonesAppearance } from '../../../../src/rom/model/sprites/appearances/DryBonesAppearance'
import { KoopaWalkBehavior } from '../../../../src/rom/model/sprites/behaviors/KoopaWalkBehavior'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { makeMockCtx } from '../fixtures/mockOverlayCtx'
import { makeTestMapStore } from '../fixtures/stores'
import type { SpritePart } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOOP_L1 = () => null
const COLS = 20, ROWS = 15
const mapStore = makeTestMapStore({})

function makePlaceholder(): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64)))
}

function makeKoopaWalkBehavior() {
  const b = Object.create(KoopaWalkBehavior.prototype) as KoopaWalkBehavior
  b.computePatrolRange = () => ({
    leftX: 0, rightX: 160, topY: 16, bottomY: 32,
    solidLeft: true, solidRight: true, fallSide: null,
  })
  b.config = { turnsAtLedges: true, tall: false, walkSpeed: 0x10 }
  return b
}

function simpleAppearance(): DryBonesAppearance {
  const parts: SpritePart[] = Array.from({length: 8}, () => ({
    char: makePlaceholder(), palette: 9, flipX: false, flipY: false, dx: 0, dy: 0,
  }))
  return new DryBonesAppearance(parts)
}

// ── renderOverlay guard ───────────────────────────────────────────────────

describe('DryBonesAppearance.renderOverlay — guard', () => {
  it('isActive=false → no draw ops', () => {
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, false, NOOP_L1, COLS, ROWS, makeKoopaWalkBehavior(), mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })

  it('behavior not instanceof KoopaWalkBehavior → no draw ops', () => {
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS, {} as never, mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })

  it('isActive=true + KoopaWalkBehavior → patrol path drawn', () => {
    const ctx = makeMockCtx()
    simpleAppearance().renderOverlay(ctx, 0, 16, true, NOOP_L1, COLS, ROWS, makeKoopaWalkBehavior(), mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })
})

// ── fromTables — faceRight column order ──────────────────────────────────

describe('DryBonesAppearance.fromTables — faceRight column order', () => {
  // Build a chars map where every tile ID maps to a distinct char so we can
  // identify which tile ended up where.
  function buildChars(base: number, charHigh: number): Map<number, Char> {
    const map = new Map<number, Char>()
    for (let i = 0; i < 0x200; i++) {
      map.set(base + charHigh + i, new Char(i, new StaticPixelsBehavior(new Uint8Array(64))))
    }
    return map
  }

  it('faceRight=true: first part uses offset 0x01 (right col first for flipX)', () => {
    const OBJ_BASE = 0x400
    const chars = buildChars(OBJ_BASE, 0)
    const app = DryBonesAppearance.fromTables(chars, makePlaceholder(), 9, 0, true)
    // Column order for flipX=true: [0x01, 0x00, 0x11, 0x10] (reversed columns)
    // bigTile(0x64, topDx, -16): first part has char = chars.get(OBJ_BASE + 0x65)
    const firstPart = app.parts[0]
    expect(firstPart.flipX).toBe(true)
    expect(firstPart.char.id).toBe(0x65)  // 0x64 + 0x01
  })

  it('faceRight=false: first part uses offset 0x00 (left col first)', () => {
    const OBJ_BASE = 0x400
    const chars = buildChars(OBJ_BASE, 0)
    const app = DryBonesAppearance.fromTables(chars, makePlaceholder(), 9, 0, false)
    // Column order for flipX=false: [0x00, 0x01, 0x10, 0x11]
    // bigTile(0x64, topDx, -16): first part has char = chars.get(OBJ_BASE + 0x64)
    const firstPart = app.parts[0]
    expect(firstPart.flipX).toBe(false)
    expect(firstPart.char.id).toBe(0x64)  // 0x64 + 0x00
  })
})
