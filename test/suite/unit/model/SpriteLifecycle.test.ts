/**
 * Sprite + CompositeSprite — branch coverage.
 *
 * Branches:
 *   Sprite.tickAnimation     — appearance.tickAnimation?.() : present / absent
 *   Sprite.renderOverlay     — appearance.renderOverlay?.() : present / absent
 *   Sprite.pickAt            — inside hit-rect / outside hit-rect
 *   CompositeSprite.render   — secondary?.render : present / absent
 *   CompositeSprite.tickAnimation — secondary?.tickAnimation : present / absent
 *   CompositeSprite.pickAt   — secondary hit / secondary miss → primary hit / primary miss
 */

import { describe, it, expect } from 'vitest'
import type { RenderTarget } from '../../../../src/rom/model/RenderTarget'
import type { MapStore }     from '../../../../src/rom/model/stores/mapStore'
import type { SpriteAppearance, HitRect } from '../../../../src/rom/model/sprites/SpriteAppearance'
import type { SpriteBehavior }            from '../../../../src/rom/model/sprites/SpriteBehavior'
import { Sprite }          from '../../../../src/rom/model/sprites/Sprite'
import { CompositeSprite } from '../../../../src/rom/model/sprites/CompositeSprite'
import { makeMockCtx }     from '../fixtures/mockOverlayCtx'
import { makeTestMapStore } from '../fixtures/stores'

// ── shared stubs ──────────────────────────────────────────────────────────────

const MOCK_BEHAVIOR: SpriteBehavior = { kind: 'mock' }
const MOCK_TARGET: RenderTarget = { blit8x8: () => {}, fillRect: () => {} }
const NOOP_L1 = () => null
const COLS = 20
const ROWS = 15

function makeAppearance(
  hitRect: HitRect,
  opts: { withTick?: boolean; withOverlay?: boolean } = {},
): SpriteAppearance & { tickCalled: boolean; overlayCalled: boolean } {
  let tickCalled    = false
  let overlayCalled = false
  const app: SpriteAppearance & { tickCalled: boolean; overlayCalled: boolean } = {
    hitRect,
    render: () => {},
    get tickCalled()    { return tickCalled },
    get overlayCalled() { return overlayCalled },
  }
  if (opts.withTick)    app.tickAnimation = () => { tickCalled    = true }
  if (opts.withOverlay) app.renderOverlay = (..._args) => { overlayCalled = true }
  return app
}

// ── Sprite.tickAnimation ──────────────────────────────────────────────────────

describe('Sprite.tickAnimation — optional chaining', () => {
  it('appearance without tickAnimation — no-op (undefined branch)', () => {
    const app    = makeAppearance({ dx: 0, dy: 0, w: 16, h: 16 })
    const sprite = new Sprite(0x04, 32, 32, app, MOCK_BEHAVIOR)
    expect(() => sprite.tickAnimation()).not.toThrow()
    expect(app.tickCalled).toBe(false)
  })

  it('appearance with tickAnimation — delegates (defined branch)', () => {
    const app    = makeAppearance({ dx: 0, dy: 0, w: 16, h: 16 }, { withTick: true })
    const sprite = new Sprite(0x04, 32, 32, app, MOCK_BEHAVIOR)
    sprite.tickAnimation()
    expect(app.tickCalled).toBe(true)
  })
})

// ── Sprite.renderOverlay ──────────────────────────────────────────────────────

describe('Sprite.renderOverlay — optional chaining', () => {
  const mapStore = makeTestMapStore()

  it('appearance without renderOverlay — no-op (undefined branch)', () => {
    const app    = makeAppearance({ dx: 0, dy: 0, w: 16, h: 16 })
    const sprite = new Sprite(0x04, 32, 32, app, MOCK_BEHAVIOR)
    const ctx    = makeMockCtx()
    expect(() => sprite.renderOverlay(ctx, 32, 32, true, NOOP_L1, COLS, ROWS, mapStore)).not.toThrow()
    expect(app.overlayCalled).toBe(false)
  })

  it('appearance with renderOverlay — delegates (defined branch)', () => {
    const app    = makeAppearance({ dx: 0, dy: 0, w: 16, h: 16 }, { withOverlay: true })
    const sprite = new Sprite(0x04, 32, 32, app, MOCK_BEHAVIOR)
    const ctx    = makeMockCtx()
    sprite.renderOverlay(ctx, 32, 32, true, NOOP_L1, COLS, ROWS, mapStore)
    expect(app.overlayCalled).toBe(true)
  })
})

// ── Sprite.pickAt ─────────────────────────────────────────────────────────────

describe('Sprite.pickAt — hit-rect test', () => {
  // Sprite at (32, 32), hitRect dx=0 dy=0 w=16 h=16  → occupied x:[32,48), y:[32,48)
  const app    = makeAppearance({ dx: 0, dy: 0, w: 16, h: 16 })
  const sprite = new Sprite(0x04, 32, 32, app, MOCK_BEHAVIOR)

  it('point inside hit-rect → returns sprite', () => {
    expect(sprite.pickAt(32, 32)).toBe(sprite)
    expect(sprite.pickAt(40, 40)).toBe(sprite)
    expect(sprite.pickAt(47, 47)).toBe(sprite)
  })

  it('point outside hit-rect → returns null', () => {
    expect(sprite.pickAt(0, 0)).toBeNull()
    expect(sprite.pickAt(48, 32)).toBeNull()    // right edge (exclusive)
    expect(sprite.pickAt(32, 48)).toBeNull()    // bottom edge (exclusive)
  })
})

// ── CompositeSprite — secondary present / absent ──────────────────────────────

describe('CompositeSprite.render — secondary?.render optional chain', () => {
  const primaryApp = makeAppearance({ dx: 0, dy: 0, w: 16, h: 16 })
  const mapStore   = makeTestMapStore()

  it('without secondary — only primary renders (undefined branch)', () => {
    const primary = new CompositeSprite(0x04, 32, 32, primaryApp, MOCK_BEHAVIOR)
    expect(() => primary.render(MOCK_TARGET, mapStore)).not.toThrow()
  })

  it('with secondary — both primary and secondary render (defined branch)', () => {
    let secondaryRendered = false
    const secondaryApp = {
      hitRect: { dx: 0, dy: 0, w: 16, h: 16 } as HitRect,
      render: () => { secondaryRendered = true },
    } as SpriteAppearance
    const secondary = new Sprite(0x9B, 48, 48, secondaryApp, MOCK_BEHAVIOR)
    const primary   = new CompositeSprite(0x04, 32, 32, primaryApp, MOCK_BEHAVIOR, secondary)
    primary.render(MOCK_TARGET, mapStore)
    expect(secondaryRendered).toBe(true)
  })
})

describe('CompositeSprite.tickAnimation — secondary?.tickAnimation optional chain', () => {
  const primaryApp = makeAppearance({ dx: 0, dy: 0, w: 16, h: 16 })

  it('without secondary — no-op (undefined branch)', () => {
    const primary = new CompositeSprite(0x04, 32, 32, primaryApp, MOCK_BEHAVIOR)
    expect(() => primary.tickAnimation()).not.toThrow()
  })

  it('with secondary that has tickAnimation — secondary tick called (defined branch)', () => {
    const secApp = makeAppearance({ dx: 0, dy: 0, w: 16, h: 16 }, { withTick: true })
    const secondary = new Sprite(0x9B, 48, 48, secApp, MOCK_BEHAVIOR)
    const primary   = new CompositeSprite(0x04, 32, 32, primaryApp, MOCK_BEHAVIOR, secondary)
    primary.tickAnimation()
    expect(secApp.tickCalled).toBe(true)
  })
})

describe('CompositeSprite.pickAt — secondary wins hit-test priority', () => {
  // Primary at (32,32) 16×16, secondary at (48,48) 16×16 — non-overlapping
  const primaryApp = makeAppearance({ dx: 0, dy: 0, w: 16, h: 16 })

  it('without secondary — delegates to primary pickAt', () => {
    const primary = new CompositeSprite(0x04, 32, 32, primaryApp, MOCK_BEHAVIOR)
    expect(primary.pickAt(32, 32)).toBe(primary)  // inside primary
    expect(primary.pickAt(0,  0)).toBeNull()       // miss
  })

  it('with secondary — secondary wins when hit overlaps secondary', () => {
    const secApp    = makeAppearance({ dx: 0, dy: 0, w: 16, h: 16 })
    const secondary = new Sprite(0x9B, 48, 48, secApp, MOCK_BEHAVIOR)
    const primary   = new CompositeSprite(0x04, 32, 32, primaryApp, MOCK_BEHAVIOR, secondary)

    // Point inside secondary → returns secondary
    expect(primary.pickAt(48, 48)).toBe(secondary)
    // Point inside primary only → falls through to primary
    expect(primary.pickAt(32, 32)).toBe(primary)
    // Miss both → null
    expect(primary.pickAt(0, 0)).toBeNull()
  })
})
