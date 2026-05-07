/**
 * Appearance factory methods + LineBrownPlatBehavior.xShiftPx — branch coverage.
 *
 * Targets:
 *   LineBrownPlatBehavior.xShiftPx — direction ternary (2 branches)
 *   LineBrownPlatAppearance
 *     fromTables — chars.get()??placeholder (2 branches per call site)
 *     render     — behavior.lineGuide?.direction??'reverse' (4 branches total)
 *   VolcanoLotusAppearance
 *     fromTables — chars.get()??placeholder (2 branches), bigTile flipX ternary (2 branches)
 *     tickAnimation / render — loop coverage
 *   LineCheckerPlatAppearance.fromTables
 *     checkerMode=true / false ternaries (6 branches)
 *     chars.get()??placeholder (2 branches)
 *   CharginChuckAppearance.fromTables
 *     faceRight ternary (2 branches)
 *   KeyholeAppearance.fromTables
 *     chars.get()??placeholder × 2 lookups (4 branches)
 */

import { describe, it, expect } from 'vitest'
import type { RenderTarget }   from '../../../../src/rom/model/RenderTarget'
import type { MapStore }       from '../../../../src/rom/model/stores/mapStore'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import { Char }                from '../../../../src/rom/model/chars/Char'
import { LineBrownPlatBehavior }    from '../../../../src/rom/model/sprites/behaviors/LineBrownPlatBehavior'
import { LineBrownPlatAppearance }  from '../../../../src/rom/model/sprites/appearances/LineBrownPlatAppearance'
import { VolcanoLotusAppearance }   from '../../../../src/rom/model/sprites/appearances/VolcanoLotusAppearance'
import { LineCheckerPlatAppearance }from '../../../../src/rom/model/sprites/appearances/LineCheckerPlatAppearance'
import { CharginChuckAppearance }   from '../../../../src/rom/model/sprites/appearances/CharginChuckAppearance'
import { KeyholeAppearance }        from '../../../../src/rom/model/sprites/appearances/KeyholeAppearance'

// ── shared stubs ──────────────────────────────────────────────────────────────

const PLACEHOLDER = new Char(0, { getPixels: () => new Uint8Array(64) })
const DUMMY_CHAR  = new Char(1, { getPixels: () => new Uint8Array(64) })

const MOCK_TARGET: RenderTarget = { blit8x8: () => {}, fillRect: () => {} }
// Minimal palette-like object; only .row() is called in render paths.
const MOCK_MAP_STORE = { palette: { row: (_n: number) => new Array(16) } } as unknown as MapStore

const MOCK_BEHAVIOR: SpriteBehavior = { kind: 'mock' }

// ── LineBrownPlatBehavior.xShiftPx ────────────────────────────────────────────

describe('LineBrownPlatBehavior.xShiftPx — direction ternary', () => {
  it("'forward' → 0x28 = 40 px (CODE_01DAA2: SpriteMisc1602=$10 path)", () => {
    expect(LineBrownPlatBehavior.xShiftPx('forward')).toBe(0x28)
  })

  it("'reverse' → 0x18 = 24 px (CODE_01DAA2: SpriteMisc1602=$00 path)", () => {
    expect(LineBrownPlatBehavior.xShiftPx('reverse')).toBe(0x18)
  })
})

// ── LineBrownPlatAppearance.fromTables ────────────────────────────────────────

describe('LineBrownPlatAppearance.fromTables — ?? placeholder branch', () => {
  it('empty chars map → every part uses placeholder (fallback branch)', () => {
    const app = LineBrownPlatAppearance.fromTables(new Map(), 13, 0, PLACEHOLDER, 'forward')
    expect(app).toBeInstanceOf(LineBrownPlatAppearance)
    // 3 slots × 4 chars each = 12 parts, all using placeholder
    expect(app.platformParts.length).toBe(12)
    expect(app.platformParts.every(p => p.char === PLACEHOLDER)).toBe(true)
  })

  it('populated chars map → at least one part uses the provided char (found branch)', () => {
    // c(0x60) → chars.get(0x400 + 0 + 0x60) = chars.get(0x460)
    const chars = new Map([[0x460, DUMMY_CHAR]])
    const app = LineBrownPlatAppearance.fromTables(chars, 13, 0, PLACEHOLDER, 'reverse')
    expect(app.platformParts.some(p => p.char === DUMMY_CHAR)).toBe(true)
  })
})

// ── LineBrownPlatAppearance.render — lineGuide?.direction ?? 'reverse' ────────

describe('LineBrownPlatAppearance.render — lineGuide optional chain branches', () => {
  const app = LineBrownPlatAppearance.fromTables(new Map(), 13, 0, PLACEHOLDER, 'forward')

  it('behavior without lineGuide → ?? falls through to default "reverse" direction', () => {
    // lineGuide is undefined → ?. short-circuits to undefined → ?? takes 'reverse'
    expect(() => app.render(MOCK_TARGET, 64, 32, MOCK_BEHAVIOR, MOCK_MAP_STORE)).not.toThrow()
  })

  it('behavior with lineGuide.direction="forward" → uses forward xShift', () => {
    const behaviorFwd: SpriteBehavior = {
      kind: 'mock',
      lineGuide: { trackTile: { col: 2, row: 0 }, direction: 'forward' },
    }
    expect(() => app.render(MOCK_TARGET, 64, 32, behaviorFwd, MOCK_MAP_STORE)).not.toThrow()
  })

  it('behavior with lineGuide.direction="reverse" → uses reverse xShift', () => {
    const behaviorRev: SpriteBehavior = {
      kind: 'mock',
      lineGuide: { trackTile: { col: 3, row: 0 }, direction: 'reverse' },
    }
    expect(() => app.render(MOCK_TARGET, 64, 32, behaviorRev, MOCK_MAP_STORE)).not.toThrow()
  })
})

// ── VolcanoLotusAppearance.fromTables ─────────────────────────────────────────

describe('VolcanoLotusAppearance.fromTables — ?? and flipX branches', () => {
  it('empty map → all parts use placeholder (both bigTile ternary branches still hit)', () => {
    // bigTile is called with flipX=false and flipX=true; both branches covered
    const app = VolcanoLotusAppearance.fromTables(new Map(), PLACEHOLDER)
    expect(app).toBeInstanceOf(VolcanoLotusAppearance)
    expect(app.headParts.length).toBeGreaterThan(0)
  })

  it('partially-populated map → some parts use the provided char (found ?? branch)', () => {
    // bigTile(0xCE, -8, -1, false): c(0x100 + 0xCE) = c(0x1CE) → key 0x400 + 0x1CE = 0x5CE
    const chars = new Map([[0x5CE, DUMMY_CHAR]])
    const app = VolcanoLotusAppearance.fromTables(chars, PLACEHOLDER)
    // At least one part should be DUMMY_CHAR
    const allParts = [...app.headParts, ...app.flowerFrames[0], ...app.flowerFrames[1]]
    expect(allParts.some(p => p.char === DUMMY_CHAR)).toBe(true)
  })
})

describe('VolcanoLotusAppearance.tickAnimation + render', () => {
  it('tickAnimation advances frame and wraps (modulo flowerFrames.length=2)', () => {
    const app = VolcanoLotusAppearance.fromTables(new Map(), PLACEHOLDER)
    // Expose private field via bracket notation for verification
    expect((app as unknown as { frame: number }).frame).toBe(0)
    app.tickAnimation()
    expect((app as unknown as { frame: number }).frame).toBe(1)
    app.tickAnimation()   // wraps back to 0
    expect((app as unknown as { frame: number }).frame).toBe(0)
  })

  it('render — iterates headParts and current flower frame without throwing', () => {
    const app = VolcanoLotusAppearance.fromTables(new Map(), PLACEHOLDER)
    expect(() => app.render(MOCK_TARGET, 32, 32, MOCK_BEHAVIOR, MOCK_MAP_STORE)).not.toThrow()
    app.tickAnimation()   // advance to frame 1
    expect(() => app.render(MOCK_TARGET, 32, 32, MOCK_BEHAVIOR, MOCK_MAP_STORE)).not.toThrow()
  })
})

// ── LineCheckerPlatAppearance.fromTables ──────────────────────────────────────

describe('LineCheckerPlatAppearance.fromTables — checkerMode branches', () => {
  it('checkerMode=true → 5 big-tiles (20 parts), xShift=40, width=80', () => {
    const app = LineCheckerPlatAppearance.fromTables(new Map(), 13, 0, PLACEHOLDER, true)
    expect(app).toBeInstanceOf(LineCheckerPlatAppearance)
    expect(app.platformParts.length).toBe(5 * 4)   // 5 slots × 4 parts each
    expect(app.xShift).toBe(0x28)
    expect(app.width).toBe(80)
  })

  it('checkerMode=false → 3 big-tiles (12 parts), xShift=24, width=48', () => {
    const app = LineCheckerPlatAppearance.fromTables(new Map(), 13, 0, PLACEHOLDER, false)
    expect(app.platformParts.length).toBe(3 * 4)
    expect(app.xShift).toBe(0x18)
    expect(app.width).toBe(48)
  })

  it('populated chars map → some parts use provided char (found ?? branch)', () => {
    // checkerMode=false: c(0x60) → chars.get(0x400 + 0 + 0x60) = chars.get(0x460)
    const chars = new Map([[0x460, DUMMY_CHAR]])
    const app = LineCheckerPlatAppearance.fromTables(chars, 13, 0, PLACEHOLDER, false)
    expect(app.platformParts.some(p => p.char === DUMMY_CHAR)).toBe(true)
  })
})

// ── CharginChuckAppearance.fromTables ─────────────────────────────────────────

describe('CharginChuckAppearance.fromTables — faceRight ternary', () => {
  it('faceRight=true → parts built with right-facing offsets (no-throw)', () => {
    const app = CharginChuckAppearance.fromTables(new Map(), PLACEHOLDER, 11, 0x100, true)
    expect(app).toBeInstanceOf(CharginChuckAppearance)
    expect(app.parts.length).toBeGreaterThan(0)
  })

  it('faceRight=false → parts built with left-facing offsets (no-throw)', () => {
    const app = CharginChuckAppearance.fromTables(new Map(), PLACEHOLDER, 11, 0x100, false)
    expect(app).toBeInstanceOf(CharginChuckAppearance)
    expect(app.parts.length).toBeGreaterThan(0)
  })
})

// ── KeyholeAppearance.fromTables ──────────────────────────────────────────────

describe('KeyholeAppearance.fromTables — ?? placeholder branches', () => {
  it('empty map → both parts use placeholder (both ?? fallback branches)', () => {
    const app = KeyholeAppearance.fromTables(new Map(), PLACEHOLDER)
    expect(app).toBeInstanceOf(KeyholeAppearance)
    expect(app.parts.length).toBe(2)
    expect(app.parts.every(p => p.char === PLACEHOLDER)).toBe(true)
  })

  it('chars map with both keys → parts use provided chars (both ?? found branches)', () => {
    const OBJ_BASE = 0x400
    const chars = new Map([
      [OBJ_BASE + 0xEB, DUMMY_CHAR],
      [OBJ_BASE + 0xFB, DUMMY_CHAR],
    ])
    const app = KeyholeAppearance.fromTables(chars, PLACEHOLDER)
    expect(app.parts.every(p => p.char === DUMMY_CHAR)).toBe(true)
  })
})
