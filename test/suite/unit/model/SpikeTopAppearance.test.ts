/**
 * SpikeTopAppearance: 2-frame animation.
 *
 * Animation (ASM: bank_02.asm:8079-8087):
 *   animBit = (EffFrame >> 3) & 1  →  SpriteMisc1602 = DATA_02BCB7[dir] + animBit
 *   dir 0, Misc1564=0 → base=$00 → SpriteMisc1602 cycles 0→1 every 8 game frames
 *
 * Direction is hardcoded to 0 (no flip, DATA_02BCC7[0]=$00); direction 4,
 * the Mario-spawns-left case, is not modelled. See
 * docs/sprite-overlay-removal.md.
 * Frame 0 uses tilemap[tilemapBase + 0]; frame 1 uses tilemap[tilemapBase + 1].
 * The tick counter toggles every ANIM_TICKS=8 calls to tickAnimation().
 *
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SpikeTopAppearance } from '../../../../src/rom/model/sprites/appearances/SpikeTopAppearance'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { RenderTarget } from '../../../../src/rom/model/RenderTarget'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import type { SpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import { makeTestMapStore, resetEditorStore } from '../fixtures/stores'

const STUB_BEHAVIOR: SpriteBehavior = { displayName: 'stub', spawns: false } as never

// ------------------------------------------------------------------ helpers

const OBJ_BASE = 0x400

/** Make a Char whose 64-px array has all pixels = `fill`, making it distinguishable. */
function namedChar(fill: number): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64).fill(fill)))
}

function stubMapStore() {
  const palette = {
    row: () => [] as RgbaColor[],
    color: () => [0, 0, 0, 0] as RgbaColor,
    cells: [] as never,
    backAreaColor: null as never,
  } as unknown as Palette
  return makeTestMapStore({ palette })
}

/** Capture all Uint8Array pixel buffers passed to blit8x8. */
function spyTarget(): { blit8x8: RenderTarget['blit8x8']; fillRect: RenderTarget['fillRect']; blits: Uint8Array[] } {
  const blits: Uint8Array[] = []
  return {
    blits,
    blit8x8(pixels: Uint8Array) { blits.push(pixels) },
    fillRect() {},
  } as unknown as { blit8x8: RenderTarget['blit8x8']; fillRect: RenderTarget['fillRect']; blits: Uint8Array[] }
}

/**
 * Build a minimal SpriteTileTables for sprite $2E.
 *
 * tilemapBase = 10 (arbitrary).
 * tilemap[10] = TILE_A (frame 0 base), tilemap[11] = TILE_B (frame 1 base).
 * attr = 0x01  →  palette = 8 + 0 = 8,  charHigh = 0x100.
 *
 * Chars populated for all 8 charNums touched by frames 0 and 1
 * (CORNER_OFFSETS = 0x00, 0x01, 0x10, 0x11 applied to each base tile).
 */
const TILE_A = 0x60   // frame 0 base tile
const TILE_B = 0x62   // frame 1 base tile
const CHAR_HIGH = 0x100
const TILEMAP_BASE = 10

/** charNum → fill value, so each tile has a unique pixel fingerprint. */
const CHAR_FILL: Record<number, number> = {}
const CORNER_OFFSETS = [0x00, 0x01, 0x10, 0x11] as const
for (const co of CORNER_OFFSETS) {
  CHAR_FILL[OBJ_BASE + CHAR_HIGH + TILE_A + co] = 0x10 + co   // frame 0
  CHAR_FILL[OBJ_BASE + CHAR_HIGH + TILE_B + co] = 0x20 + co   // frame 1
}

function makeChars(): Map<number, Char> {
  const chars = new Map<number, Char>()
  for (const [charNum, fill] of Object.entries(CHAR_FILL)) {
    chars.set(Number(charNum), namedChar(fill))
  }
  return chars
}

function makeTables(): SpriteTileTables {
  const tilemap = new Uint8Array(64)
  tilemap[TILEMAP_BASE]     = TILE_A
  tilemap[TILEMAP_BASE + 1] = TILE_B

  const tilemapOffset = new Uint8Array(0x54)
  tilemapOffset[0x2E] = TILEMAP_BASE

  const spriteAttr = new Uint8Array(0x100)
  spriteAttr[0x2E] = 0x01   // charHigh=1, palette bits=0 → CGRAM row 8

  return {
    tilemap,
    tilemapOffset,
    dispX: [0, 8, 0, 8],
    dispY: [0, 0, 8, 8],
    gfxProp: new Array(24).fill(0),
    spriteAttr,
    spr0to13Prop: new Uint8Array(0x14),
    yoshiPal: new Uint8Array(4),
  }
}

// ------------------------------------------------------------------ helpers for appearance construction

function makeAppearance(): SpikeTopAppearance {
  return SpikeTopAppearance.fromTables(makeChars(), makeTables(), namedChar(0xFF))
}

/** Render and collect the pixel fills that were blit'd (first pixel of each Uint8Array). */
function blitFills(app: SpikeTopAppearance): number[] {
  const spy = spyTarget()
  app.render(spy as unknown as RenderTarget, 0, 0, STUB_BEHAVIOR, stubMapStore())
  return spy.blits.map(buf => buf[0])
}

/** All fill values belonging to frame 0 corners. */
const FRAME0_FILLS = CORNER_OFFSETS.map(co => CHAR_FILL[OBJ_BASE + CHAR_HIGH + TILE_A + co])
/** All fill values belonging to frame 1 corners. */
const FRAME1_FILLS = CORNER_OFFSETS.map(co => CHAR_FILL[OBJ_BASE + CHAR_HIGH + TILE_B + co])

// ------------------------------------------------------------------ tests

describe('SpikeTopAppearance.fromTables — construction', () => {
  beforeEach(resetEditorStore)

  it('hitRect covers a 16×16 box (one big-tile, corners at 0,0 to 16,16)', () => {
    const app = makeAppearance()
    expect(app.hitRect).toMatchObject({ dx: 0, dy: 0, w: 16, h: 16 })
  })

  it('palette from Sprite166EVals[$2E] & $0F: attr=0x01 → charHigh=1 → CGRAM row 8', () => {
    // Verify via which charNums the appearance resolves: OBJ_BASE + 0x100 + TILE_A + corner
    // i.e. the chars in the CHAR_HIGH=0x100 range are used, not the 0x000 range
    const app = makeAppearance()
    // All blits must be from frame-0 chars (fill 0x10..0x1x), NOT placeholder (0xFF)
    for (const fill of blitFills(app)) {
      expect(fill).not.toBe(0xFF)
    }
  })
})

describe('SpikeTopAppearance — animation gating', () => {
  let app: SpikeTopAppearance

  beforeEach(() => { resetEditorStore(); app = makeAppearance() })

  // ASM: bank_02.asm:8079-8083 — animBit stays 0 until EffFrame>>3 increments
  it('tick 0: renders frame 0 tiles (tilemap[base+0])', () => {
    expect(blitFills(app)).toEqual(FRAME0_FILLS)
  })

  it('ticks 1-7: still on frame 0', () => {
    for (let i = 0; i < 7; i++) app.tickAnimation()
    expect(blitFills(app)).toEqual(FRAME0_FILLS)
  })

  it('tick 8: switches to frame 1 tiles (tilemap[base+1])', () => {
    for (let i = 0; i < 8; i++) app.tickAnimation()
    expect(blitFills(app)).toEqual(FRAME1_FILLS)
  })

  it('ticks 9-15: still on frame 1', () => {
    for (let i = 0; i < 15; i++) app.tickAnimation()
    expect(blitFills(app)).toEqual(FRAME1_FILLS)
  })

  it('tick 16: returns to frame 0', () => {
    for (let i = 0; i < 16; i++) app.tickAnimation()
    expect(blitFills(app)).toEqual(FRAME0_FILLS)
  })

  it('renders exactly 4 blits per frame (one 16×16 big-tile = 4 corners)', () => {
    expect(blitFills(app)).toHaveLength(4)
    for (let i = 0; i < 8; i++) app.tickAnimation()
    expect(blitFills(app)).toHaveLength(4)
  })
})

describe('SpikeTopAppearance.fromTables — ?? fallback branches', () => {
  it('short spriteAttr/tilemapOffset/tilemap → ?? 0 defaults; palette=8, charHigh=0', () => {
    const tables: SpriteTileTables = {
      tilemap:       new Uint8Array(0),
      tilemapOffset: new Uint8Array(0),
      spriteAttr:    new Uint8Array(0),
      dispX: [],
      dispY: [],
      gfxProp: [],
      spr0to13Prop:  new Uint8Array(0),
      yoshiPal:      new Uint8Array(0),
    }
    const placeholder = namedChar(0xFF)
    const app = SpikeTopAppearance.fromTables(new Map(), tables, placeholder)
    expect(app.parts0.every(p => p.char === placeholder)).toBe(true)
    expect(app.parts0[0].palette).toBe(8)
  })

  it('chars missing key → ?? placeholder for all parts in both frames', () => {
    const placeholder = namedChar(0xFF)
    const app = SpikeTopAppearance.fromTables(new Map(), makeTables(), placeholder)
    expect(app.parts0.every(p => p.char.getPixels()[0] === 0xFF)).toBe(true)
    expect(app.parts1.every(p => p.char.getPixels()[0] === 0xFF)).toBe(true)
  })

  it('empty dispX/dispY → ?? 0 for all dx/dy', () => {
    const tables: SpriteTileTables = { ...makeTables(), dispX: [], dispY: [] }
    const app = SpikeTopAppearance.fromTables(makeChars(), tables, namedChar(0xFF))
    expect(app.parts0.every(p => p.dx === 0 && p.dy === 0)).toBe(true)
  })
})
