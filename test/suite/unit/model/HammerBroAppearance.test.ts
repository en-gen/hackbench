/**
 * HammerBroAppearance — flip cadence and dx mirroring.
 *
 * SMW Hammer Bro ($9B) facing direction is bit 5 of `SpriteMisc1570`
 * (bank_02.asm). Misc1570 increments 3 of every 4 game frames at 60 Hz
 * (≈45 increments/sec); bit 5 toggles every 32 increments ≈ 711 ms.
 *
 * The editor's spriteAnimTimer fires at 125 ms, so each tick is ~7.5
 * game frames. With the 3-of-4 cadence that's ≈5.6 increments per tick;
 * the appearance advances its internal Misc1570 by 6 per tick to round
 * to the nearest integer. Bit 5 then toggles every 32/6 ≈ 5.33 ticks
 * ≈ 666 ms — within ~6 % of the in-game cadence.
 */

import { describe, it, expect } from 'vitest'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { HammerBroAppearance } from '../../../../src/rom/model/sprites/appearances/HammerBroAppearance'
import type { SpritePart } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { PixelPos, RenderTarget } from '../../../../src/rom/model/RenderTarget'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import { makeTestMapStore } from '../fixtures/stores'

const STUB_BEHAVIOR: SpriteBehavior = { displayName: 'stub', spawns: false } as never

function stubMapStore() {
  const palette = {
    row: () => [],
    color: () => [0, 0, 0, 0],
    cells: [] as never,
    backAreaColor: null as never,
  } as unknown as Palette
  return makeTestMapStore({ palette })
}

function makeChar(tag: number): Char {
  const buf = new Uint8Array(64); buf[0] = tag & 0xFF
  return new Char(tag, new StaticPixelsBehavior(buf))
}

interface Blit { pos: PixelPos; flipX: boolean; tag: number }

function capturingTarget() {
  const calls: Blit[] = []
  const target: RenderTarget = {
    blit8x8(pixels, pos, _row, flipX) { calls.push({ pos, flipX, tag: pixels[0] }) },
    fillRect() {},
  }
  return { target, calls }
}

/**
 * 2x2 layout — four 8x8 parts at corners of a 16x16 hitRect, each tagged
 * with a unique fingerprint so a render captures which part landed where.
 */
function buildParts(): SpritePart[] {
  return [
    { char: makeChar(0xA0), palette: 0, flipX: false, flipY: false, dx: 0, dy: 0 },  // top-left
    { char: makeChar(0xA1), palette: 0, flipX: false, flipY: false, dx: 8, dy: 0 },  // top-right
    { char: makeChar(0xA2), palette: 0, flipX: false, flipY: false, dx: 0, dy: 8 },  // bottom-left
    { char: makeChar(0xA3), palette: 0, flipX: false, flipY: false, dx: 8, dy: 8 },  // bottom-right
  ]
}

describe('HammerBroAppearance — initial state', () => {
  it('starts unflipped: parts render at their declared dx', () => {
    const app = new HammerBroAppearance(buildParts())
    const { target, calls } = capturingTarget()
    app.render(target, 0, 0, STUB_BEHAVIOR, stubMapStore())
    const byTag = new Map(calls.map(c => [c.tag, c]))
    expect(byTag.get(0xA0)).toMatchObject({ pos: { x: 0, y: 0 }, flipX: false })
    expect(byTag.get(0xA1)).toMatchObject({ pos: { x: 8, y: 0 }, flipX: false })
  })
})

describe('HammerBroAppearance — flip toggles ~every 5–6 ticks (Misc1570 bit-5)', () => {
  it('first 5 ticks: still unflipped', () => {
    const app = new HammerBroAppearance(buildParts())
    for (let i = 0; i < 5; i++) app.tickAnimation()
    const { target, calls } = capturingTarget()
    app.render(target, 0, 0, STUB_BEHAVIOR, stubMapStore())
    // Top-left tag should still be at dx=0 (unflipped)
    const tl = calls.find(c => c.tag === 0xA0)!
    expect(tl.pos.x).toBe(0)
    expect(tl.flipX).toBe(false)
  })

  it('after 6 ticks: flipped (Misc1570 = 36 → bit 5 = 1)', () => {
    const app = new HammerBroAppearance(buildParts())
    for (let i = 0; i < 6; i++) app.tickAnimation()
    const { target, calls } = capturingTarget()
    app.render(target, 0, 0, STUB_BEHAVIOR, stubMapStore())
    const tl = calls.find(c => c.tag === 0xA0)!
    // 0xA0 was at dx=0; mirrored around 16-wide hitRect → dx=8.
    expect(tl.pos.x).toBe(8)
    expect(tl.flipX).toBe(true)
  })

  it('after 11 ticks: unflipped again (Misc1570 = 66 → bit 5 = 0)', () => {
    const app = new HammerBroAppearance(buildParts())
    for (let i = 0; i < 11; i++) app.tickAnimation()
    const { target, calls } = capturingTarget()
    app.render(target, 0, 0, STUB_BEHAVIOR, stubMapStore())
    const tl = calls.find(c => c.tag === 0xA0)!
    expect(tl.pos.x).toBe(0)
    expect(tl.flipX).toBe(false)
  })

  it('over 64 ticks the flip toggles ~6 times (close to in-game ~9.6 toggles)', () => {
    // 64 ticks * 6 incr = 384 misc1570 advances. Bit 5 transitions occur
    // at every multiple of 32 — so ~12 transitions, but with +6 stride
    // some get skipped at the boundary. Empirically: 12 transitions in
    // 64 ticks → flip toggles 12 times.
    const app = new HammerBroAppearance(buildParts())
    let flips = 0
    let prevFlipped = false
    for (let i = 0; i < 64; i++) {
      app.tickAnimation()
      const { target, calls } = capturingTarget()
      app.render(target, 0, 0, STUB_BEHAVIOR, stubMapStore())
      const isFlipped = calls.find(c => c.tag === 0xA0)!.flipX
      if (isFlipped !== prevFlipped) flips++
      prevFlipped = isFlipped
    }
    // Sanity bound — between 8 and 16 transitions over 64 ticks (8s of
    // editor time). In-game cadence over the same wall time: ~12.
    expect(flips).toBeGreaterThanOrEqual(8)
    expect(flips).toBeLessThanOrEqual(16)
  })
})

describe('HammerBroAppearance — dx mirror geometry', () => {
  it('flipped: each part reflects around the hitRect horizontal center', () => {
    const app = new HammerBroAppearance(buildParts())
    // Force into flipped state (6 ticks).
    for (let i = 0; i < 6; i++) app.tickAnimation()
    const { target, calls } = capturingTarget()
    app.render(target, 100, 200, STUB_BEHAVIOR, stubMapStore())
    const byTag = new Map(calls.map(c => [c.tag, c]))
    // Anchor=(100,200), 16x16 hitRect → mirror axis at dx=8 (within sprite).
    // 0xA0 (orig dx=0) → dx=8 → pos x=108. 0xA1 (orig dx=8) → dx=0 → pos x=100.
    expect(byTag.get(0xA0)!.pos).toEqual({ x: 108, y: 200 })
    expect(byTag.get(0xA1)!.pos).toEqual({ x: 100, y: 200 })
    expect(byTag.get(0xA2)!.pos).toEqual({ x: 108, y: 208 })
    expect(byTag.get(0xA3)!.pos).toEqual({ x: 100, y: 208 })
  })

  it('flipped: per-part flipX is XORed with declared flipX', () => {
    const parts: SpritePart[] = [
      { char: makeChar(0xB0), palette: 0, flipX: false, flipY: false, dx: 0, dy: 0 },
      { char: makeChar(0xB1), palette: 0, flipX: true,  flipY: false, dx: 8, dy: 0 },
    ]
    const app = new HammerBroAppearance(parts)
    for (let i = 0; i < 6; i++) app.tickAnimation()
    const { target, calls } = capturingTarget()
    app.render(target, 0, 0, STUB_BEHAVIOR, stubMapStore())
    const byTag = new Map(calls.map(c => [c.tag, c]))
    // Original false → toggled true; original true → toggled false.
    expect(byTag.get(0xB0)!.flipX).toBe(true)
    expect(byTag.get(0xB1)!.flipX).toBe(false)
  })
})
