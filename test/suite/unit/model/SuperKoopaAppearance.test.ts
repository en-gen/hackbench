/**
 * SuperKoopaAppearance.test.ts - branch coverage for render() + fromTables().
 *
 * Test tree:
 *   render() - pose selection
 *     - behavior not instanceof SuperKoopaBehavior → flashing=false → grounded pose
 *     - instanceof but dropsFeather=false → flashing=false → grounded pose
 *     - dropsFeather=true, isAirborne=false → groundedFlash pose
 *     - dropsFeather=false, isAirborne=true → airborne pose
 *     - dropsFeather=true, isAirborne=true → airborneFlash pose
 *     - flap=1 after tickAnimation → flapB used instead of flapA
 *   fromTables() - spriteId branch
 *     - spriteId=$71 → normalCapeOverride=$08 → distinct palette on palOverride parts
 *     - spriteId=$72 → normalCapeOverride=$04 → distinct palette on palOverride parts
 *   fromTables() - faceRight / flipX
 *     - faceRight=true → all parts have flipX=true
 *     - faceRight=false → all parts have flipX=false
 *   fromTables() - size=8 vs size=16 in FRAME_0
 *     - three size=8 entries → 1 part each; one size=16 entry → 4 parts; total 7
 *   fromTables() - palOverride vs standard path (bit 1 of attrByte)
 *     - FRAME_0 entry 0 (attrByte=0x03): palOverride=true → uses capeOverride for palette
 *     - FRAME_0 entry 3 (attrByte=0x00): palOverride=false → uses bodyAttr5
 *   fromTables() - charHigh bit (finalAttr & 0x01)
 *     - FRAME_0 entry 0 with $71 (palOverride, finalAttr=0x09, bit0=1) → charHigh=0x100
 *     - FRAME_0 entry 3 (palOverride=false, spriteAttrByte=0) → charHigh=0
 *   fromTables() - placeholder fallback
 *     - empty chars map → placeholder used for all parts
 *   fromTables() - airborne parameter propagated to isAirborne
 */

import { describe, it, expect } from 'vitest'
import {
  SuperKoopaAppearance,
  type SuperKoopaPoseFrames,
} from '../../../../src/rom/model/sprites/appearances/SuperKoopaAppearance'
import { SuperKoopaBehavior } from '../../../../src/rom/model/sprites/behaviors/SuperKoopaBehavior'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { makeTestMapStore } from '../fixtures/stores'
import { Palette } from '../../../../src/rom/model/palette/Palette'
import { Color } from '../../../../src/rom/model/palette/Color'
import { StaticColorBehavior } from '../../../../src/rom/model/palette/behaviors/StaticColorBehavior'
import type { RenderTarget, PixelPos, PixelSize } from '../../../../src/rom/model/RenderTarget'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import type { SpritePart } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeChar(id: number): Char {
  return new Char(id, new StaticPixelsBehavior(new Uint8Array(64)))
}

function makePalette(): Palette {
  const black: RgbaColor = [0, 0, 0, 255]
  const cell = () => new Color(new StaticColorBehavior(black))
  const cells = Array.from({ length: 16 }, () => Array.from({ length: 16 }, cell))
  return new Palette(cells, cell())
}

const mapStore = makeTestMapStore({ palette: makePalette() })

/** Records each blit8x8 call as the dx offset of the part (via pos.x - spriteX). */
interface BlitCall {
  x: number
  y: number
  flipX: boolean
  flipY: boolean
}
function makeMockTarget(spriteX = 0): { calls: BlitCall[]; target: RenderTarget } {
  const calls: BlitCall[] = []
  return {
    calls,
    target: {
      blit8x8(
        _pixels: Uint8Array,
        pos: PixelPos,
        _row: RgbaColor[],
        flipX: boolean,
        flipY: boolean,
      ) {
        calls.push({ x: pos.x - spriteX, y: pos.y, flipX, flipY })
      },
      fillRect(_pos: PixelPos, _size: PixelSize, _color: RgbaColor) {},
    },
  }
}

/** Create a single-part pose frame with a unique dx so we can identify which pose rendered. */
function singlePartFrame(dx: number): SpritePart[] {
  return [{ char: makeChar(dx), palette: 8, flipX: false, flipY: false, dx, dy: 0 }]
}

function makePoseFrames(dxA: number, dxB: number): SuperKoopaPoseFrames {
  return { flapA: singlePartFrame(dxA), flapB: singlePartFrame(dxB) }
}

/** Build an appearance with a known pose layout for render() branch testing. */
function makeAppearance(isAirborne: boolean): SuperKoopaAppearance {
  return new SuperKoopaAppearance(
    makePoseFrames(1, 2), // grounded:      flapA dx=1, flapB dx=2
    makePoseFrames(3, 4), // groundedFlash: flapA dx=3, flapB dx=4
    makePoseFrames(5, 6), // airborne:      flapA dx=5, flapB dx=6
    makePoseFrames(7, 8), // airborneFlash: flapA dx=7, flapB dx=8
    isAirborne,
  )
}

function makeSkBehavior(dropsFeather: boolean): SuperKoopaBehavior {
  const b = Object.create(SuperKoopaBehavior.prototype) as SuperKoopaBehavior
  b.dropsFeather = () => dropsFeather
  return b
}

// ── render() - pose selection ─────────────────────────────────────────────

describe('SuperKoopaAppearance.render() - pose selection', () => {
  it('behavior not instanceof SuperKoopaBehavior → flashing=false → grounded flapA', () => {
    const app = makeAppearance(false)
    const { calls, target } = makeMockTarget()
    app.render(target, 0, 0, {} as never, mapStore)
    // grounded.flapA has dx=1
    expect(calls).toHaveLength(1)
    expect(calls[0].x).toBe(1)
  })

  it('instanceof but dropsFeather=false → flashing=false → grounded flapA', () => {
    const app = makeAppearance(false)
    const { calls, target } = makeMockTarget()
    app.render(target, 0, 0, makeSkBehavior(false), mapStore)
    expect(calls[0].x).toBe(1)
  })

  it('dropsFeather=true, isAirborne=false → groundedFlash flapA (dx=3)', () => {
    const app = makeAppearance(false)
    const { calls, target } = makeMockTarget()
    app.render(target, 0, 0, makeSkBehavior(true), mapStore)
    expect(calls[0].x).toBe(3)
  })

  it('dropsFeather=false, isAirborne=true → airborne flapA (dx=5)', () => {
    const app = makeAppearance(true)
    const { calls, target } = makeMockTarget()
    app.render(target, 0, 0, makeSkBehavior(false), mapStore)
    expect(calls[0].x).toBe(5)
  })

  it('dropsFeather=true, isAirborne=true → airborneFlash flapA (dx=7)', () => {
    const app = makeAppearance(true)
    const { calls, target } = makeMockTarget()
    app.render(target, 0, 0, makeSkBehavior(true), mapStore)
    expect(calls[0].x).toBe(7)
  })

  it('after tickAnimation flap becomes 1 → flapB used (dx=2 for grounded)', () => {
    const app = makeAppearance(false)
    app.tickAnimation()
    const { calls, target } = makeMockTarget()
    app.render(target, 0, 0, makeSkBehavior(false), mapStore)
    // grounded.flapB has dx=2
    expect(calls[0].x).toBe(2)
  })

  it('tickAnimation twice returns to flapA (dx=1)', () => {
    const app = makeAppearance(false)
    app.tickAnimation()
    app.tickAnimation()
    const { calls, target } = makeMockTarget()
    app.render(target, 0, 0, makeSkBehavior(false), mapStore)
    expect(calls[0].x).toBe(1)
  })
})

// ── fromTables() - spriteId branch ───────────────────────────────────────

describe('SuperKoopaAppearance.fromTables() - spriteId cape override', () => {
  const placeholder = makeChar(0xffff)

  function buildChars(): Map<number, Char> {
    const map = new Map<number, Char>()
    for (let i = 0; i < 0x300; i++) {
      map.set(0x400 + i, makeChar(i))
    }
    return map
  }

  it('spriteId=$71 → normalCapeOverride=0x08 → first part palette=12', () => {
    // FRAME_0[0]: attrByte=0x03, palOverride=true
    // finalAttr = (0x03 | 0x08) & 0xFD = 0x09 → palette = 8 + (0x09>>1 & 7) = 8+4=12
    const app = SuperKoopaAppearance.fromTables(buildChars(), placeholder, 0, 0x71, false, false)
    expect(app.grounded.flapA[0].palette).toBe(12)
  })

  it('spriteId=$72 → normalCapeOverride=0x04 → first part palette=10', () => {
    // FRAME_0[0]: attrByte=0x03, palOverride=true
    // finalAttr = (0x03 | 0x04) & 0xFD = 0x05 → palette = 8 + (0x05>>1 & 7) = 8+2=10
    const app = SuperKoopaAppearance.fromTables(buildChars(), placeholder, 0, 0x72, false, false)
    expect(app.grounded.flapA[0].palette).toBe(10)
  })
})

// ── fromTables() - faceRight / flipX ─────────────────────────────────────

describe('SuperKoopaAppearance.fromTables() - faceRight / flipX', () => {
  const placeholder = makeChar(0xffff)

  function buildChars(): Map<number, Char> {
    const map = new Map<number, Char>()
    for (let i = 0; i < 0x300; i++) map.set(0x400 + i, makeChar(i))
    return map
  }

  it('faceRight=true → all parts have flipX=true', () => {
    const app = SuperKoopaAppearance.fromTables(buildChars(), placeholder, 0, 0x71, true, false)
    expect(app.grounded.flapA.every(p => p.flipX)).toBe(true)
  })

  it('faceRight=false → all parts have flipX=false', () => {
    const app = SuperKoopaAppearance.fromTables(buildChars(), placeholder, 0, 0x71, false, false)
    expect(app.grounded.flapA.every(p => !p.flipX)).toBe(true)
  })
})

// ── fromTables() - size=8 vs size=16 ─────────────────────────────────────

describe('SuperKoopaAppearance.fromTables() - FRAME_0 part count (3×size8 + 1×size16)', () => {
  it('grounded.flapA has 7 parts: 3 size-8 entries + 1 size-16 entry × 4 sub-tiles', () => {
    const placeholder = makeChar(0xffff)
    const map = new Map<number, Char>()
    for (let i = 0; i < 0x300; i++) map.set(0x400 + i, makeChar(i))
    const app = SuperKoopaAppearance.fromTables(map, placeholder, 0, 0x71, false, false)
    expect(app.grounded.flapA).toHaveLength(7)
  })
})

// ── fromTables() - palOverride vs standard path ───────────────────────────

describe('SuperKoopaAppearance.fromTables() - palOverride vs standard path', () => {
  function buildChars(): Map<number, Char> {
    const map = new Map<number, Char>()
    for (let i = 0; i < 0x300; i++) map.set(0x400 + i, makeChar(i))
    return map
  }

  it('first part (attrByte=0x03, palOverride=true) has palette derived from capeOverride', () => {
    // For spriteId=$71: normalCapeOverride=0x08 → finalAttr=(0x03|0x08)&0xFD=0x09 → palette=12
    const app = SuperKoopaAppearance.fromTables(buildChars(), makeChar(0), 0, 0x71, false, false)
    expect(app.grounded.flapA[0].palette).toBe(12)
  })

  it('last part (FRAME_0[3], attrByte=0x00, palOverride=false) uses bodyAttr5 path → palette=8', () => {
    // spriteAttrByte=0 → bodyAttr5=0 → finalAttr=0 → palette=8+(0>>1 & 7)=8
    const app = SuperKoopaAppearance.fromTables(buildChars(), makeChar(0), 0, 0x71, false, false)
    // FRAME_0[3] is size=16, produces parts at indices 3..6
    expect(app.grounded.flapA[3].palette).toBe(8)
  })
})

// ── fromTables() - charHigh bit ───────────────────────────────────────────

describe('SuperKoopaAppearance.fromTables() - charHigh bit', () => {
  it('palOverride entry with finalAttr bit0=1 → charHigh=0x100 → char from [0x500..] range', () => {
    // FRAME_0[0]: attrByte=0x03, spriteId=$71 → finalAttr=0x09, bit0=1 → charHigh=0x100
    // char key = 0x400 + 0x100 + (0xC8 & 0x1FF) = 0x5C8
    const map = new Map<number, Char>()
    for (let i = 0; i < 0x300; i++) {
      map.set(0x400 + i, makeChar(i)) // low range (no charHigh)
      map.set(0x400 + 0x100 + i, makeChar(0x100 + i)) // high range (charHigh=0x100)
    }
    const placeholder = makeChar(0xffff)
    const app = SuperKoopaAppearance.fromTables(map, placeholder, 0, 0x71, false, false)
    // First part uses charHigh=0x100; char.id should be in [0x100..] range
    expect(app.grounded.flapA[0].char.id).toBeGreaterThanOrEqual(0x100)
  })

  it('standard path entry with spriteAttrByte=0 → charHigh=0 → char from [0x400..] base range', () => {
    // FRAME_0[3]: attrByte=0x00, palOverride=false, spriteAttrByte=0 → finalAttr=0 → charHigh=0
    // part indices 3..6 come from size=16 FRAME_0[3]
    const map = new Map<number, Char>()
    for (let i = 0; i < 0x300; i++) {
      map.set(0x400 + i, makeChar(i))
      map.set(0x400 + 0x100 + i, makeChar(0x100 + i))
    }
    const placeholder = makeChar(0xffff)
    const app = SuperKoopaAppearance.fromTables(map, placeholder, 0, 0x71, false, false)
    // FRAME_0[3] is the 16x16 body tile, parts at indices 3..6; charHigh=0 → char.id < 0x100
    expect(app.grounded.flapA[3].char.id).toBeLessThan(0x100)
  })
})

// ── fromTables() - placeholder fallback ──────────────────────────────────

describe('SuperKoopaAppearance.fromTables() - placeholder fallback', () => {
  it('empty chars map → all parts use placeholder', () => {
    const placeholder = makeChar(0xabcd)
    const app = SuperKoopaAppearance.fromTables(new Map(), placeholder, 0, 0x71, false, false)
    const allParts = [
      ...app.grounded.flapA,
      ...app.groundedFlash.flapA,
      ...app.airborne.flapA,
      ...app.airborneFlash.flapA,
    ]
    expect(allParts.every(p => p.char === placeholder)).toBe(true)
  })
})

// ── fromTables() - airborne parameter ────────────────────────────────────

describe('SuperKoopaAppearance.fromTables() - airborne flag', () => {
  it('airborne=true → appearance.isAirborne=true', () => {
    const app = SuperKoopaAppearance.fromTables(new Map(), makeChar(0), 0, 0x71, false, true)
    expect(app.isAirborne).toBe(true)
  })

  it('airborne=false → appearance.isAirborne=false', () => {
    const app = SuperKoopaAppearance.fromTables(new Map(), makeChar(0), 0, 0x71, false, false)
    expect(app.isAirborne).toBe(false)
  })
})

// ── fromTables() - faceRight=true column order for size=16 ───────────────

describe('SuperKoopaAppearance.fromTables() - flipX column reordering for size=16', () => {
  it('faceRight=false → first sub-tile of FRAME_0[3] has tile offset +0x00', () => {
    // co = [0x00, 0x01, 0x10, 0x11]; first part char key = 0x400 + (0xE0 + 0x00)
    const map = new Map<number, Char>()
    for (let i = 0; i < 0x300; i++) map.set(0x400 + i, makeChar(i))
    const app = SuperKoopaAppearance.fromTables(map, makeChar(0xffff), 0, 0x71, false, false)
    // part[3] is first sub-tile of FRAME_0[3] (size=16 at tile=0xE0)
    expect(app.grounded.flapA[3].char.id).toBe(0xe0)
  })

  it('faceRight=true → first sub-tile of FRAME_0[3] has tile offset +0x01 (col reversed)', () => {
    // co = [0x01, 0x00, 0x11, 0x10]; first part char key = 0x400 + (0xE0 + 0x01)
    const map = new Map<number, Char>()
    for (let i = 0; i < 0x300; i++) map.set(0x400 + i, makeChar(i))
    const app = SuperKoopaAppearance.fromTables(map, makeChar(0xffff), 0, 0x71, true, false)
    // part[3] is first sub-tile of FRAME_0[3] (size=16 at tile=0xE0, co[0]=0x01)
    expect(app.grounded.flapA[3].char.id).toBe(0xe1)
  })
})
