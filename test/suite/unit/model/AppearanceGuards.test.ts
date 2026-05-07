/**
 * AppearanceGuards — branch coverage for appearance classes with
 * isActive / instanceof guards.
 *
 * Appearances tested:
 *   BlurpAppearance          — !isActive guard, swimDir ternary
 *   JumpingFishAppearance    — !isActive guard
 *   JumpingPiranhaAppearance — !isActive guard
 *   MontyMoleAppearance      — !isActive guard, detection-zone rect drawn
 *   CarrotTopLiftAppearance  — !isActive guard, spriteId 0xB7 vs 0xB8 branch
 *   CheepCheepAppearance     — !isActive guard, !this.vertical branch
 *   HopFlameAppearance       — !isActive guard, !(behavior instanceof HopFlameBehavior) guard
 *   KoopaAppearance          — !isActive || !(behavior instanceof KoopaWalkBehavior) guard
 *
 * All canvas operations are captured via makeMockCtx.
 * Behavior stubs use Object.create(Prototype) so instanceof passes.
 */

import { describe, it, expect } from 'vitest'
import type { SpritePart } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import { BlurpAppearance }           from '../../../../src/rom/model/sprites/appearances/BlurpAppearance'
import { JumpingFishAppearance }     from '../../../../src/rom/model/sprites/appearances/JumpingFishAppearance'
import { JumpingPiranhaAppearance }  from '../../../../src/rom/model/sprites/appearances/JumpingPiranhaAppearance'
import { MontyMoleAppearance }       from '../../../../src/rom/model/sprites/appearances/MontyMoleAppearance'
import { CarrotTopLiftAppearance }   from '../../../../src/rom/model/sprites/appearances/CarrotTopLiftAppearance'
import { CheepCheepAppearance }      from '../../../../src/rom/model/sprites/appearances/CheepCheepAppearance'
import { HopFlameAppearance }        from '../../../../src/rom/model/sprites/appearances/HopFlameAppearance'
import { KoopaAppearance }           from '../../../../src/rom/model/sprites/appearances/KoopaAppearance'
import { HopFlameBehavior }          from '../../../../src/rom/model/sprites/behaviors/HopFlameBehavior'
import { KoopaWalkBehavior }         from '../../../../src/rom/model/sprites/behaviors/KoopaWalkBehavior'
import { makeMockCtx }               from '../fixtures/mockOverlayCtx'
import { makeTestMapStore }          from '../fixtures/stores'

// ── helpers ───────────────────────────────────────────────────────────────────

const NOOP_L1   = () => null
const COLS      = 20
const ROWS      = 15
const NO_PARTS: SpritePart[] = []

function hasStroke(ctx: ReturnType<typeof makeMockCtx>): boolean {
  return ctx.events.some(e => e.op === 'stroke' || e.op === 'strokeRect')
}

function makeHopFlameBehavior(): HopFlameBehavior {
  const b = Object.create(HopFlameBehavior.prototype) as HopFlameBehavior
  // Mock the two methods renderOverlay calls so we skip the real simulation.
  ;(b as unknown as Record<string, unknown>).simulateBounds =
    () => ({ minX: 10, maxX: 90, minY: 20, maxY: 80, groundY: 64 })
  ;(b as unknown as Record<string, unknown>).computeBouncePath =
    () => [{ x: 32, y: 64 }, { x: 48, y: 32 }, { x: 64, y: 64 }]
  return b
}

function makeKoopaWalkBehavior(): KoopaWalkBehavior {
  const b = Object.create(KoopaWalkBehavior.prototype) as KoopaWalkBehavior
  ;(b as unknown as Record<string, unknown>).computePatrolRange =
    () => ({ leftX: 0, rightX: 160, topY: 16, bottomY: 32, solidLeft: true, solidRight: true, fallSide: null })
  ;(b as unknown as Record<string, unknown>).config =
    { turnsAtLedges: true, tall: false, walkSpeed: 0x10 }
  return b
}

// ── BlurpAppearance ───────────────────────────────────────────────────────────

describe('BlurpAppearance.renderOverlay — isActive guard', () => {
  const app = new BlurpAppearance(NO_PARTS)

  it('isActive=false → no stroke emitted', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 80, 64, false, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(false)
  })

  it('isActive=true, centerX > marioSpawnX → swimDir=-1 (leftward stroke)', () => {
    // centerX = 80+8 = 88 > marioSpawnX = 0 → swimDir=-1, farX < centerX
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 80, 64, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore({ marioSpawnX: 0 }))
    expect(hasStroke(ctx)).toBe(true)
  })

  it('isActive=true, centerX <= marioSpawnX → swimDir=+1 (rightward stroke)', () => {
    // centerX = 8+8 = 16 <= marioSpawnX = 400 → swimDir=+1, farX > centerX
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 8, 64, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore({ marioSpawnX: 400 }))
    expect(hasStroke(ctx)).toBe(true)
  })
})

// ── JumpingFishAppearance ─────────────────────────────────────────────────────

describe('JumpingFishAppearance.renderOverlay — isActive guard', () => {
  const app = new JumpingFishAppearance(NO_PARTS)

  it('isActive=false → no stroke emitted', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 48, 64, false, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(false)
  })

  it('isActive=true → vertical jump-zone lines drawn', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 48, 64, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(true)
  })
})

// ── JumpingPiranhaAppearance ──────────────────────────────────────────────────

describe('JumpingPiranhaAppearance.renderOverlay — isActive guard', () => {
  const app = new JumpingPiranhaAppearance(NO_PARTS)

  it('isActive=false → no stroke emitted', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 48, 128, false, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(false)
  })

  it('isActive=true → vertical jump-zone lines drawn (CODE_02E159 bank_02.asm:12882)', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 48, 128, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(true)
  })
})

// ── MontyMoleAppearance ───────────────────────────────────────────────────────

describe('MontyMoleAppearance.renderOverlay — isActive guard', () => {
  const app = new MontyMoleAppearance(NO_PARTS)

  it('isActive=false → no stroke emitted', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 48, 128, false, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(false)
  })

  it('isActive=true → detection-zone rect drawn (CODE_01E2E0 bank_01.asm:13340)', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 48, 128, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(true)
  })
})

// ── CarrotTopLiftAppearance ───────────────────────────────────────────────────

describe('CarrotTopLiftAppearance.renderOverlay — isActive guard', () => {
  it('isActive=false → no stroke (either spriteId)', () => {
    const ctx = makeMockCtx()
    new CarrotTopLiftAppearance(NO_PARTS, 0xB7)
      .renderOverlay(ctx, 64, 64, false, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(false)
  })
})

describe('CarrotTopLiftAppearance.renderOverlay — spriteId branch', () => {
  it('$B7 (top-right / bottom-left diagonal) → path stroked', () => {
    // bank_03.asm:1554 — $B7: YSpeed = −XSpeed (top-right is spawn end)
    const ctx = makeMockCtx()
    new CarrotTopLiftAppearance(NO_PARTS, 0xB7)
      .renderOverlay(ctx, 64, 64, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(true)
  })

  it('$B8 (bottom-right / top-left diagonal) → path stroked', () => {
    // bank_03.asm:1556 — $B8: YSpeed = +XSpeed (bottom-right is spawn end)
    const ctx = makeMockCtx()
    new CarrotTopLiftAppearance(NO_PARTS, 0xB8)
      .renderOverlay(ctx, 64, 64, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(true)
  })
})

// ── CheepCheepAppearance ──────────────────────────────────────────────────────

describe('CheepCheepAppearance.renderOverlay — isActive guard', () => {
  it('isActive=false → no stroke (horizontal variant)', () => {
    const ctx = makeMockCtx()
    new CheepCheepAppearance(NO_PARTS, false)
      .renderOverlay(ctx, 64, 64, false, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(false)
  })
})

describe('CheepCheepAppearance.renderOverlay — vertical flag', () => {
  it('vertical=false ($15) → horizontal corridor drawn', () => {
    // $15: SpriteMisc151C=0 → horizontal scan at sprite's centre row.
    const ctx = makeMockCtx()
    new CheepCheepAppearance(NO_PARTS, false)
      .renderOverlay(ctx, 64, 64, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(true)
  })

  it('vertical=true ($16) → vertical corridor drawn', () => {
    // $16: SpriteMisc151C=1 → vertical scan at sprite's centre column.
    const ctx = makeMockCtx()
    new CheepCheepAppearance(NO_PARTS, true)
      .renderOverlay(ctx, 64, 64, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(hasStroke(ctx)).toBe(true)
  })
})

// ── HopFlameAppearance ────────────────────────────────────────────────────────

describe('HopFlameAppearance.renderOverlay — guards', () => {
  const app = new HopFlameAppearance(NO_PARTS)

  it('isActive=false → no draw ops', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 64, 80, false, NOOP_L1, COLS, ROWS, makeHopFlameBehavior(), makeTestMapStore())
    expect(ctx.events.length).toBe(0)
  })

  it('behavior not instanceof HopFlameBehavior → no draw ops', () => {
    const ctx = makeMockCtx()
    // Pass an object that is NOT a HopFlameBehavior instance.
    app.renderOverlay(ctx, 64, 80, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(ctx.events.length).toBe(0)
  })

  it('isActive=true + HopFlameBehavior → envelope + arc drawn (save emitted)', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 64, 80, true, NOOP_L1, COLS, ROWS, makeHopFlameBehavior(), makeTestMapStore())
    expect(ctx.events.some(e => e.op === 'save')).toBe(true)
  })
})

// ── KoopaAppearance ───────────────────────────────────────────────────────────

describe('KoopaAppearance.renderOverlay — guard (isActive || instanceof)', () => {
  const app = new KoopaAppearance(NO_PARTS)

  it('isActive=false → no draw ops', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 64, 80, false, NOOP_L1, COLS, ROWS, makeKoopaWalkBehavior(), makeTestMapStore())
    expect(ctx.events.length).toBe(0)
  })

  it('behavior not instanceof KoopaWalkBehavior → no draw ops', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 64, 80, true, NOOP_L1, COLS, ROWS, undefined, makeTestMapStore())
    expect(ctx.events.length).toBe(0)
  })

  it('isActive=true + KoopaWalkBehavior → patrol path drawn', () => {
    const ctx = makeMockCtx()
    app.renderOverlay(ctx, 64, 80, true, NOOP_L1, COLS, ROWS, makeKoopaWalkBehavior(), makeTestMapStore())
    // drawPatrolPath emits at least one save + stroke.
    expect(ctx.events.some(e => e.op === 'save')).toBe(true)
  })
})
