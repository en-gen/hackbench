/**
 * HammerBroPlatformAppearance.test.ts — branch coverage for sprite $9C.
 * (src/rom/model/sprites/appearances/HammerBroPlatformAppearance.ts)
 *
 * Test tree:
 *   render()
 *     - frame 0 → wingFrames[0] rendered
 *     - frame 1 → wingFrames[1] rendered (after tickAnimation)
 *   tickAnimation()
 *     - cycles 0 → 1 → 0
 *   fromTables()
 *     - chars present → used; chars missing → placeholder
 *     - flipX=true path (bigTile with flipX)
 */

import { describe, it, expect } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { HammerBroPlatformAppearance } from '../../../../src/rom/model/sprites/appearances/HammerBroPlatformAppearance'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { RenderTarget } from '../../../../src/rom/model/RenderTarget'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import { makeTestMapStore } from '../fixtures/stores'

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

/** Build an appearance with distinguishable wing frames. */
function makeAppearance(): HammerBroPlatformAppearance {
  const makePart = (fill: number) => ({
    char: makeChar(fill), palette: 9, flipX: false, flipY: false, dx: 0, dy: 0,
  })
  const platform = [makePart(0x01), makePart(0x02)]
  const frame0   = [makePart(0xA0)]
  const frame1   = [makePart(0xB0)]
  return new HammerBroPlatformAppearance(platform, [frame0, frame1])
}

function renderFills(app: HammerBroPlatformAppearance): number[] {
  const fills: number[] = []
  const target: RenderTarget = {
    blit8x8(pixels: Uint8Array) { fills.push(pixels[0]) },
    fillRect() {},
  }
  app.render(target, 0, 0, STUB_BEHAVIOR, stubMapStore())
  return fills
}

// ── renderOverlay ─────────────────────────────────────────────────────────────

describe('HammerBroPlatformAppearance.render', () => {
  it('frame 0 → wing frame 0 parts rendered (fill=0xA0)', () => {
    const app = makeAppearance()
    expect(renderFills(app)).toContain(0xA0)
    expect(renderFills(app)).not.toContain(0xB0)
  })

  it('after tickAnimation → frame 1 → wing frame 1 parts rendered (fill=0xB0)', () => {
    const app = makeAppearance()
    app.tickAnimation()
    expect(renderFills(app)).toContain(0xB0)
    expect(renderFills(app)).not.toContain(0xA0)
  })

  it('platform parts always rendered regardless of frame', () => {
    const app = makeAppearance()
    expect(renderFills(app)).toContain(0x01)
    app.tickAnimation()
    expect(renderFills(app)).toContain(0x01)
  })

  it('tickAnimation cycles: 0 → 1 → 0', () => {
    const app = makeAppearance()
    app.tickAnimation()  // → frame 1
    app.tickAnimation()  // → frame 0
    expect(renderFills(app)).toContain(0xA0)
    expect(renderFills(app)).not.toContain(0xB0)
  })
})

// ── fromTables ────────────────────────────────────────────────────────────────

describe('HammerBroPlatformAppearance.fromTables', () => {
  it('empty chars → all parts use placeholder', () => {
    const ph = makeChar(0xFF)
    const app = HammerBroPlatformAppearance.fromTables(new Map(), ph)
    const allParts = [
      ...app.platformParts,
      ...app.wingFrames[0],
      ...app.wingFrames[1],
    ]
    expect(allParts.every(p => p.char === ph)).toBe(true)
  })

  it('flipX=true parts (frame0 left wing) have flipX=true', () => {
    const ph = makeChar(0xFF)
    const app = HammerBroPlatformAppearance.fromTables(new Map(), ph)
    // frame0 has bigTile(0xC6, -14, -10, true) + bigTile(0xC6, 30, -10, false)
    // First 4 parts of frame0 → flipX=true; last 4 → flipX=false
    const frame0 = [...app.wingFrames[0]]
    expect(frame0.slice(0, 4).every(p => p.flipX === true)).toBe(true)
    expect(frame0.slice(4, 8).every(p => p.flipX === false)).toBe(true)
  })

  it('frame1 small tiles with flipX=true and flipX=false', () => {
    const ph = makeChar(0xFF)
    const app = HammerBroPlatformAppearance.fromTables(new Map(), ph)
    // frame1 has smallTile(0x5D, -6, -2, true) + smallTile(0x5D, 30, -2, false)
    const frame1 = [...app.wingFrames[1]]
    expect(frame1[0].flipX).toBe(true)   // left small tile
    expect(frame1[1].flipX).toBe(false)  // right small tile
  })

  it('platform parts never flipped', () => {
    const ph = makeChar(0xFF)
    const app = HammerBroPlatformAppearance.fromTables(new Map(), ph)
    expect(app.platformParts.every(p => p.flipX === false)).toBe(true)
  })

  it('chars map with a known tile: chars.get() returns defined → ?? left arm fires (char used, not placeholder)', () => {
    // `c(n) = chars.get(0x400 + (n & 0x1FF)) ?? placeholder`
    // With an empty map, only the right arm (?? placeholder) fires.
    // Providing charNum=0x440 covers the left arm (chars.get returns the Char).
    const ph = makeChar(0xFF)
    const knownChar = makeChar(0x42)
    const chars = new Map([[0x440, knownChar]])  // 0x400 + (0x40 & 0x1FF) = 0x440
    const app = HammerBroPlatformAppearance.fromTables(chars, ph)
    // The platformParts use c(0x40) → 0x440 → knownChar. At least one part is not placeholder.
    expect(app.platformParts.some(p => p.char === knownChar)).toBe(true)
  })
})
