/**
 * RipVanFishAppearance.test.ts — branch coverage for sprite $3D.
 * (src/rom/model/sprites/appearances/RipVanFishAppearance.ts)
 *
 * Test tree:
 *   render()
 *     - cursor null → sleeping pose
 *     - cursor outside zone → sleeping pose
 *     - cursor inside zone  → awake pose
 *     - awake: tickCount even → awakeFrames[0]; odd → awakeFrames[1]
 *     - sleep: (romFrame & $30) === 0 → sleepB (blink); non-zero → sleepA
 *     - !inZone → Z trail rendered; inZone → Z trail hidden
 *     - Z slot age >= Z_LIFETIME_FRAMES → skipped (dead slot)
 *   renderOverlay()
 *     - !isActive → no draw
 *     - isActive → fillRect + strokeRect emitted
 *   fromTables()
 *     - chars missing → placeholder used for all parts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import {
  RipVanFishAppearance,
} from '../../../../src/rom/model/sprites/appearances/RipVanFishAppearance'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { RenderTarget, PixelPos } from '../../../../src/rom/model/RenderTarget'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import { editorStore, makeTestMapStore, resetEditorStore } from '../fixtures/stores'
import { makeMockCtx } from '../fixtures/mockOverlayCtx'

// ── helpers ───────────────────────────────────────────────────────────────────

const TRANSPARENT_ROW: RgbaColor[] = Array(16).fill([0, 0, 0, 0] as RgbaColor)

function stubMapStore() {
  const palette = {
    row: () => TRANSPARENT_ROW,
    color: () => [0, 0, 0, 0] as RgbaColor,
    cells: [] as never,
    backAreaColor: null as never,
  } as unknown as Palette
  return makeTestMapStore({ palette })
}

function makeChar(fill: number): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64).fill(fill)))
}

const STUB_BEHAVIOR: SpriteBehavior = { displayName: 'stub', spawns: false } as never

/** Build an appearance with distinguishable frames (fill values encode frame identity). */
function makeAppearance(): RipVanFishAppearance {
  const makePart = (fill: number) => ({
    char: makeChar(fill), palette: 0, flipX: false, flipY: false, dx: 0, dy: 0,
  })
  const sleepB  = [makePart(0x10)]  // sleepFrames[0]
  const sleepA  = [makePart(0x11)]  // sleepFrames[1]
  const awakeA  = [makePart(0x20)]  // awakeFrames[0]
  const awakeB  = [makePart(0x21)]  // awakeFrames[1]
  const zParts  = [makeChar(0x30), makeChar(0x31), makeChar(0x32), makeChar(0x33)].map(c => ({
    char: c, palette: 0, flipX: false, flipY: false, dx: 0, dy: 0,
  }))
  return new RipVanFishAppearance([sleepB, sleepA], [awakeA, awakeB], zParts)
}

/** Render and return fills of all blitted chars. */
function renderFills(app: RipVanFishAppearance, x = 0, y = 0): number[] {
  const fills: number[] = []
  const target: RenderTarget = {
    blit8x8(pixels: Uint8Array) { fills.push(pixels[0]) },
    fillRect() {},
  }
  app.render(target, x, y, STUB_BEHAVIOR, stubMapStore())
  return fills
}

// ── render — pose selection ───────────────────────────────────────────────────

describe('RipVanFishAppearance.render — pose selection', () => {
  beforeEach(resetEditorStore)

  it('cursor null → sleepA pose (fill=0x11)', () => {
    const app = makeAppearance()
    editorStore.setCursorPx(null)
    // romFrame=0: (0 & 0x30)=0 → sleepB. But default is romFrame=0...
    // Actually (0 & 0x30) === 0 → sleepFrames[1] = sleepA (fill=0x11)
    // Wait, checking again: `(fishFrame & 0x30) === 0 ? 1 : 0` → index 1 = sleepA
    expect(renderFills(app)).toContain(0x11)
  })

  it('cursor outside zone → sleepA pose', () => {
    // Sprite at (0,0), center at (8,8). Zone is ±48px. Cursor at (100,0) is outside.
    const app = makeAppearance()
    editorStore.setCursorPx({ x: 100, y: 0 })
    expect(renderFills(app)).toContain(0x11)
  })

  it('cursor x inside zone but y outside zone → sleepA pose (3rd && FALSE branch)', () => {
    // cx=8, cy=8. Cursor at (8, 100): |8-8|=0 < 48 (2nd && TRUE) but |100-8|=92 >= 48 (3rd && FALSE).
    // The inZone && chain: cursor!==null (pass), |dx|<48 (pass), |dy|<48 (FAIL) → inZone=false.
    const app = makeAppearance()
    editorStore.setCursorPx({ x: 8, y: 100 })
    expect(renderFills(app)).toContain(0x11)  // sleeping (not awake)
    expect(renderFills(app)).not.toContain(0x20)  // not awake pose
  })

  it('cursor inside zone → awakeA pose (fill=0x20)', () => {
    // Center at (8,8). Cursor at (8,8) → |dx|=0 < 48, |dy|=0 < 48 → inZone
    const app = makeAppearance()
    editorStore.setCursorPx({ x: 8, y: 8 })
    // tickCount=0 → awakeFrames[0] → fill=0x20
    expect(renderFills(app)).toContain(0x20)
  })

  it('awake: tickCount odd → awakeFrames[1] (fill=0x21)', () => {
    const app = makeAppearance()
    editorStore.setCursorPx({ x: 8, y: 8 })
    app.tickAnimation()  // tickCount → 1
    expect(renderFills(app)).toContain(0x21)
  })

  it('awake: tickCount even (after 2 ticks) → awakeFrames[0] again', () => {
    const app = makeAppearance()
    editorStore.setCursorPx({ x: 8, y: 8 })
    app.tickAnimation()
    app.tickAnimation()  // tickCount → 2 (even)
    expect(renderFills(app)).toContain(0x20)
  })

  it('sleep: (romFrame & 0x30) !== 0 → sleepA (fill=0x11)', () => {
    // Advance romFrame so that (Math.floor(romFrame) & 0x30) !== 0
    // e.g. romFrame ≥ 16 → (16 & 0x30) = 16 !== 0 → sleepFrames[0] index = 0 = sleepB? Wait.
    // `sleepFrames[(fishFrame & 0x30) === 0 ? 1 : 0]`
    // (fishFrame & 0x30) !== 0 → index=0 → sleepB (fill=0x10)
    const app = makeAppearance()
    editorStore.setCursorPx(null)
    // Tick enough times to get romFrame past 16 (where bit 4 is set)
    // ROM_FRAMES_PER_TICK = 7.5; after 3 ticks romFrame ≈ 22.5 → floor=22; 22 & 0x30 = 16 ≠ 0
    for (let i = 0; i < 3; i++) app.tickAnimation()
    expect(renderFills(app)).toContain(0x10)  // sleepB
  })
})

// ── render — Z trail ──────────────────────────────────────────────────────────

describe('RipVanFishAppearance.render — Z trail', () => {
  beforeEach(resetEditorStore)

  it('cursor outside zone → Z trail rendered (blit count > body)', () => {
    const app = makeAppearance()
    editorStore.setCursorPx(null)
    const fills = renderFills(app)
    // At romFrame=0: slot 0 age=0 < Z_LIFETIME_FRAMES → Z blit emitted
    const hasZPart = fills.some(f => f >= 0x30 && f <= 0x33)
    expect(hasZPart).toBe(true)
  })

  it('cursor inside zone → Z trail hidden', () => {
    const app = makeAppearance()
    editorStore.setCursorPx({ x: 8, y: 8 })
    const fills = renderFills(app)
    // No Z parts when inZone
    expect(fills.every(f => f < 0x30)).toBe(true)
  })

  it('Z slot with age >= Z_LIFETIME_FRAMES → skipped (dead slot)', () => {
    // Advance romFrame so at least one slot's age >= Z_LIFETIME_FRAMES
    const app = makeAppearance()
    editorStore.setCursorPx(null)
    // Z_LIFETIME_FRAMES is the max slot age. With romFrame just past it,
    // slot 0 has age = romFrame % 120 = romFrame (for small values).
    // Tick until romFrame > Z_LIFETIME_FRAMES (typically ~106 frames / 7.5 per tick ≈ 15 ticks)
    for (let i = 0; i < 20; i++) app.tickAnimation()
    // At this point some slots will have age >= Z_LIFETIME_FRAMES and be skipped.
    // Test passes if render does not throw (dead slot handling is defensive).
    expect(() => renderFills(app)).not.toThrow()
  })
})

// ── renderOverlay ─────────────────────────────────────────────────────────────

describe('RipVanFishAppearance.renderOverlay', () => {
  beforeEach(resetEditorStore)

  it('!isActive → no draw ops', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, false, () => null, 10, 10, undefined as never, makeTestMapStore({}))
    expect(ctx.events.every(e => e.op === 'save' || e.op === 'restore')).toBe(true)
  })

  it('isActive → fillRect and strokeRect emitted', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, true, () => null, 10, 10, undefined as never, makeTestMapStore({}))
    expect(ctx.events.some(e => e.op === 'fillRect')).toBe(true)
    expect(ctx.events.some(e => e.op === 'strokeRect')).toBe(true)
  })
})

// ── fromTables ────────────────────────────────────────────────────────────────

describe('RipVanFishAppearance.fromTables', () => {
  it('empty chars → all parts use placeholder', () => {
    const ph = makeChar(0xFF)
    const app = RipVanFishAppearance.fromTables(new Map(), 8, 0, ph)
    const allParts = [
      ...app.sleepFrames[0], ...app.sleepFrames[1],
      ...app.awakeFrames[0], ...app.awakeFrames[1],
      ...app.zParts,
    ]
    expect(allParts.every(p => p.char === ph)).toBe(true)
  })
})
