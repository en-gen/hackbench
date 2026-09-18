/**
 * ThwimpAppearance.test.ts — branch coverage for ThwimpAppearance.renderOverlay
 * (src/rom/model/sprites/appearances/ThwimpAppearance.ts, sprite $27).
 *
 * Test tree:
 *   renderOverlay() guard
 *     - isActive=false → no draw
 *     - behavior not instanceof ThwimpBounceBehavior → no draw
 *   renderOverlay() normal path
 *     - path.length < 2 → no draw (early return after instanceof check)
 *     - path.length >= 2, spawnBottom >= path[0].y-1 → no spawn-drop drawn
 *     - path.length >= 2, spawnBottom < path[0].y-1  → spawn-drop drawn
 */

import { describe, it, expect } from 'vitest'
import { ThwimpAppearance } from '../../../../src/rom/model/sprites/appearances/ThwimpAppearance'
import { ThwimpBounceBehavior } from '../../../../src/rom/model/sprites/behaviors/ThwimpBounceBehavior'
import { type SpritePart } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { makeMockCtx } from '../fixtures/mockOverlayCtx'
import { makeTestMapStore } from '../fixtures/stores'
import type { SpriteTileTables } from '../../../../src/rom/SpriteTileLoader'

// ── Fixtures ─────────────────────────────────────────────────────────────

function makePart(): SpritePart {
  return {
    char: new Char(0, new StaticPixelsBehavior(new Uint8Array(64))),
    palette: 0, flipX: false, flipY: false, dx: 0, dy: 0,
  }
}

function makeAppearance(): ThwimpAppearance {
  return new ThwimpAppearance([makePart(), makePart(), makePart(), makePart()])
}

const mapStore = makeTestMapStore({})
const NOOP_L1 = () => null
const COLS = 20, ROWS = 15

function makeThwimpBehavior(path: {x: number; y: number}[]) {
  const b = Object.create(ThwimpBounceBehavior.prototype) as ThwimpBounceBehavior
  b.computeBouncePath = () => path
  return b
}

// ── guard branches ────────────────────────────────────────────────────────

describe('ThwimpAppearance.renderOverlay — guard', () => {
  it('isActive=false → no draw ops', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, false, NOOP_L1, COLS, ROWS, makeThwimpBehavior([{x:0,y:16},{x:8,y:0}]), mapStore)
    expect(ctx.events.every(e => e.op === 'save' || e.op === 'restore')).toBe(true)
  })

  it('behavior not instanceof ThwimpBounceBehavior → no draw ops', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS, {} as never, mapStore)
    expect(ctx.events.every(e => e.op === 'save' || e.op === 'restore')).toBe(true)
  })
})

// ── path.length < 2 early return ─────────────────────────────────────────

describe('ThwimpAppearance.renderOverlay — path too short', () => {
  it('path empty → no stroke emitted', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS, makeThwimpBehavior([]), mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })

  it('path length 1 → no stroke emitted', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS, makeThwimpBehavior([{x:8,y:32}]), mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })
})

// ── spawnBottom vs path[0].y — spawn-drop branch ──────────────────────────

describe('ThwimpAppearance.renderOverlay — spawnBottom vs path[0].y', () => {
  // spawnBottom = y + 16. path[0].y is the ground resting position.
  // drawSpawnDrop is called when: spawnBottom < path[0].y - 1

  it('spawnBottom < path[0].y - 1 → fillRect (spawn-drop indicator) emitted', () => {
    // y=0 → spawnBottom=16; path[0].y=32 → 16 < 31 → spawn drop drawn
    const ctx = makeMockCtx()
    const path = [{x:8, y:32}, {x:8, y:0}]
    makeAppearance().renderOverlay(ctx, 0, 0, true, NOOP_L1, COLS, ROWS, makeThwimpBehavior(path), mapStore)
    // drawSpawnDrop emits a stroke (vertical dashed line)
    const strokes = ctx.events.filter(e => e.op === 'stroke')
    expect(strokes.length).toBeGreaterThanOrEqual(2)  // spawn-drop stroke + arc stroke
  })

  it('spawnBottom >= path[0].y - 1 → no extra stroke for spawn-drop', () => {
    // y=16 → spawnBottom=32; path[0].y=32 → 32 >= 31 → no spawn drop
    const ctx = makeMockCtx()
    const path = [{x:8, y:32}, {x:8, y:0}]
    makeAppearance().renderOverlay(ctx, 0, 16, true, NOOP_L1, COLS, ROWS, makeThwimpBehavior(path), mapStore)
    // Only the arc stroke, no spawn-drop stroke
    const strokes = ctx.events.filter(e => e.op === 'stroke')
    expect(strokes).toHaveLength(1)
    // But the arc polyline IS still drawn
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })

  it('path length >= 2 → arc polyline stroked', () => {
    const ctx = makeMockCtx()
    const path = [{x:8, y:32}, {x:16, y:16}, {x:8, y:32}]
    makeAppearance().renderOverlay(ctx, 0, 16, true, NOOP_L1, COLS, ROWS, makeThwimpBehavior(path), mapStore)
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(true)
  })
})

// ── fromTables() ─────────────────────────────────────────────────────────

function makeChar(id: number): Char {
  return new Char(id, new StaticPixelsBehavior(new Uint8Array(64)))
}

function makeTables(opts: {
  attrByte?: number
  tilemapOffset?: number
  tilemap?: number[]
}): SpriteTileTables {
  const spriteAttr = new Uint8Array(0x40)
  const tilemapOffsets = new Uint8Array(0x40)
  const tilemap = new Uint8Array(0x100)
  if (opts.attrByte !== undefined)    spriteAttr[0x27]     = opts.attrByte
  if (opts.tilemapOffset !== undefined) tilemapOffsets[0x27] = opts.tilemapOffset
  if (opts.tilemap) opts.tilemap.forEach((b, i) => { tilemap[(opts.tilemapOffset ?? 0) + i] = b })
  return { tilemap, tilemapOffset: tilemapOffsets, spriteAttr, dispX: [], dispY: [], gfxProp: [], spr0to13Prop: new Uint8Array(0), yoshiPal: new Uint8Array(4) }
}

describe('ThwimpAppearance.fromTables() — charHigh and palette', () => {
  it('attr bit0=0 → charHigh=0; attr bits3-1=1 → palette=9', () => {
    // spriteAttr[0x27] = 0x02 → palette=8+((0x02>>1)&7)=9; bit0=0 → charHigh=0
    const tables = makeTables({ attrByte: 0x02, tilemapOffset: 0, tilemap: [0x67, 0x69, 0x88, 0xCE] })
    const chars = new Map<number, Char>()
    chars.set(0x400 + 0x67, makeChar(0x67))
    const placeholder = makeChar(0xFFFF)
    const app = ThwimpAppearance.fromTables(chars, tables, placeholder)
    expect(app.parts[0].palette).toBe(9)
    expect(app.parts[0].char.id).toBe(0x67)
  })

  it('attr bit0=1 → charHigh=0x100; char from high range used', () => {
    // spriteAttr[0x27] = 0x01 → charHigh=0x100; tile $67 → key = 0x400+0x100+0x67 = 0x567
    const tables = makeTables({ attrByte: 0x01, tilemapOffset: 0, tilemap: [0x67, 0x69, 0x88, 0xCE] })
    const chars = new Map<number, Char>()
    chars.set(0x400 + 0x100 + 0x67, makeChar(0x567))
    const placeholder = makeChar(0xFFFF)
    const app = ThwimpAppearance.fromTables(chars, tables, placeholder)
    expect(app.parts[0].char.id).toBe(0x567)
  })
})

describe('ThwimpAppearance.fromTables() — ?? fallback branches', () => {
  it('spriteAttr too short → spriteAttr[0x27]=undefined → ?? 0 → palette=8, charHigh=0', () => {
    // Uint8Array shorter than 0x28 → index 0x27 out of bounds → undefined
    const tables: SpriteTileTables = {
      tilemap:       new Uint8Array(0),
      tilemapOffset: new Uint8Array(0),
      spriteAttr:    new Uint8Array(0),
      dispX: [], dispY: [], gfxProp: [], spr0to13Prop: new Uint8Array(0), yoshiPal: new Uint8Array(0),
    }
    const placeholder = makeChar(0xFFFF)
    const app = ThwimpAppearance.fromTables(new Map(), tables, placeholder)
    // attr=0, palette=8+(0>>1 & 7)=8, charHigh=0
    expect(app.parts[0].palette).toBe(8)
    // All parts use placeholder since chars is empty
    expect(app.parts.every(p => p.char === placeholder)).toBe(true)
  })

  it('chars missing key → ?? placeholder used for all 4 corners', () => {
    const tables = makeTables({ attrByte: 0x02, tilemapOffset: 0, tilemap: [0x67, 0x69, 0x88, 0xCE] })
    const placeholder = makeChar(0xFFFF)
    const app = ThwimpAppearance.fromTables(new Map(), tables, placeholder)
    expect(app.parts.every(p => p.char === placeholder)).toBe(true)
  })
})
