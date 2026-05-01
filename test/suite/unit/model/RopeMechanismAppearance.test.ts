/**
 * RopeMechanismAppearance tests.
 *
 * 1. Palette derivation
 *    Sprite $64's smoke puffs render via CODE_029927 (bank_02.asm:3351-3352),
 *    which writes SpriteProperties straight into OAMTileAttr. SpriteProperties
 *    is the global priority byte set once at level init by bank_00.asm:2401-2402
 *    (`LDA #!OBJ_Priority2 / STA SpriteProperties`) → `$20`. Decoded palette
 *    index is `(0x20 >> 1) & 7 = 0` → CGRAM row `8 + 0 = 8`. fromTables takes
 *    `smokePalette` as a separate parameter from `bodyPalette` so a future
 *    "reuse bodyPalette" regression cannot hide the real source.
 *
 * 2. Smoke lifecycle (CODE_029927, bank_02.asm:3280-3339)
 *    Spawn cadence: every 8 frames (CODE_018063 condition
 *    `(slot*4 XOR EffFrame) & 7 == 0`, bank_01.asm:11823). Lifetime: 19
 *    visible frames (timer init = $13 = 19; on the frame where pre-DEC
 *    timer = 0 the BNE falls through to a cleanup branch that hides the
 *    sprite and frees the slot — line 3281-3290).
 *
 *    Tile by puff age, derived from DATA_029922 indexed by post-DEC
 *    timer>>2 (post-DEC timer at age N = 18 - N):
 *      age  0..6  → $62
 *      age  7..10 → $64
 *      age 11..18 → $66
 *
 *    yRise (DEC SmokeSpriteYPos at line 3296-3298): triggered when pre-DEC
 *    timer & 7 == 0. pre-DEC at age N = 19 - N, so first DEC at age 3,
 *    second at age 11. yRise = 0 / 1 / 2 for ages 0..2 / 3..10 / 11..18.
 *
 *    X spawn parity (DATA_01D717 = $F8,$00 indexed by bit 3 of
 *    `slot*4 XOR EffFrame`): consecutive spawns alternate dx=-8 vs dx=0
 *    (anchor-relative 0 vs 8).
 *
 *    Cohort alive count: 3 only when phase ∈ [0, 2]; 2 for phase ∈ [3, 7].
 *    Phase 7 is special — newest cohort has aged into the $64 tile bucket,
 *    yielding a brief "$64 + $66" 2-alive snapshot distinct from the
 *    standard "$62 + $66" 2-alive snapshot of phases 3..6.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import {
  RopeMechanismAppearance,
  smokeCohortsAt,
} from '../../../../src/rom/model/sprites/appearances/RopeMechanismAppearance'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { PixelPos, RenderTarget } from '../../../../src/rom/model/RenderTarget'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import { makeTestMapStore, resetEditorStore } from '../fixtures/stores'

const TRANSPARENT_ROW: RgbaColor[] = Array(16).fill([0, 0, 0, 0] as RgbaColor)
const STUB_BEHAVIOR: SpriteBehavior = { displayName: 'stub', spawns: false } as never

function stubMapStore() {
  const palette = {
    row: () => TRANSPARENT_ROW,
    color: () => [0, 0, 0, 0] as RgbaColor,
    cells: [] as never,
    backAreaColor: null as never,
  } as unknown as Palette
  return makeTestMapStore({ palette })
}

function makeChar(tag = 0): Char {
  // Stamp tag into the first byte so blit captures can identify which tile.
  const buf = new Uint8Array(64)
  buf[0] = tag & 0xFF
  return new Char(tag, new StaticPixelsBehavior(buf))
}

const PLACEHOLDER = makeChar()

function buildChars(): Map<number, Char> {
  const chars = new Map<number, Char>()
  // RopeMechanismAppearance reads OBJ_CHAR_BASE (0x400) + tile, plus 0x10
  // siblings for big-tile composition. Cover a generous range so neither
  // motor/body/knot lookups nor smoke (charHigh=0) lookups miss. Tag each
  // Char's pixels[0] with its low tile id so smoke-blit captures can decode
  // tile identity ($62, $64, $66) from the captured pixel buffer.
  for (let i = 0x400; i <= 0x4FF; i++) chars.set(i, makeChar(i & 0xFF))
  return chars
}

interface BlitCall { pos: PixelPos; tileTag: number }

function capturingTarget() {
  const calls: BlitCall[] = []
  const target: RenderTarget = {
    blit8x8(pixels, pos) { calls.push({ pos, tileTag: pixels[0] }) },
    fillRect() {},
  }
  return { target, calls }
}

/** Filter for smoke blits — identify by tile tag ($62/$64/$66). Rope body
 * subtiles ($CE/$CF/$DE/$DF) and motor ($C0/$C1/$C2/$C3/$D0/$D1/$D2/$D3/$E0..$E3,$F0..$F3)
 * never overlap this range. */
function smokeBlits(calls: BlitCall[]): BlitCall[] {
  return calls.filter(c => c.tileTag === 0x62 || c.tileTag === 0x64 || c.tileTag === 0x66)
}

describe('RopeMechanismAppearance.fromTables — smoke palette source', () => {
  it('smoke parts use smokePalette, not bodyPalette', () => {
    // Distinct sentinels so a regression that reuses bodyPalette becomes a
    // visible test failure (instead of silently matching when both equal 8).
    const app = RopeMechanismAppearance.fromTables(
      buildChars(),
      /* motorPalette */ 11,
      /* bodyPalette  */ 5,
      /* smokePalette */ 7,
      /* charHigh     */ 0,
      PLACEHOLDER,
    )
    for (const frame of app.smokePuffFrames) {
      for (const part of frame) {
        expect(part.palette).toBe(7)
      }
    }
  })

  it('body and knot parts still use bodyPalette', () => {
    const app = RopeMechanismAppearance.fromTables(
      buildChars(),
      /* motorPalette */ 11,
      /* bodyPalette  */ 5,
      /* smokePalette */ 7,
      /* charHigh     */ 0,
      PLACEHOLDER,
    )
    for (const part of app.bodyTemplate) expect(part.palette).toBe(5)
    for (const part of app.knotTemplate) expect(part.palette).toBe(5)
  })

  it('motor frames use motorPalette', () => {
    const app = RopeMechanismAppearance.fromTables(
      buildChars(),
      /* motorPalette */ 11,
      /* bodyPalette  */ 5,
      /* smokePalette */ 7,
      /* charHigh     */ 0,
      PLACEHOLDER,
    )
    for (const frame of app.motorFrames) {
      for (const part of frame) expect(part.palette).toBe(11)
    }
  })

  it('SpriteProperties=$20 derivation: (0x20 >> 1) & 7 = 0 → CGRAM row 8', () => {
    // ASM-derived constant — this is what SpriteFactory should compute.
    // bank_00.asm:2401-2402 sets SpriteProperties = !OBJ_Priority2 = $20
    // at level init; CODE_029927 (bank_02.asm:3351-3352) writes it to
    // OAMTileAttr unmodified.
    const SPRITE_PROPERTIES_AT_SMOKE_RENDER = 0x20
    const expectedRow = 8 + ((SPRITE_PROPERTIES_AT_SMOKE_RENDER >> 1) & 0x07)
    expect(expectedRow).toBe(8)
  })
})

function buildAppearance() {
  return RopeMechanismAppearance.fromTables(
    buildChars(),
    /* motorPalette */ 11,
    /* bodyPalette  */ 8,
    /* smokePalette */ 8,
    /* charHigh     */ 0,
    PLACEHOLDER,
  )
}

/**
 * Seed the appearance's internal smoke frame to a specific in-game phase
 * (bypassing tickAnimation's 3-game-frame quantum), render at (0,0), and
 * return the smoke blits sorted by puff age (newest first → oldest last).
 *
 * Sort key: smoke blits have y in {-6, -7, -8} for ages 0-7, 8-15, 16-19
 * respectively (yRise = age >> 3). Sorting by descending y groups them
 * newest-to-oldest.
 */
function renderSmoke(effFrame: number): BlitCall[] {
  const app = buildAppearance()
  app.smokeFrame = effFrame
  const { target, calls } = capturingTarget()
  app.render(target, 0, 0, STUB_BEHAVIOR, stubMapStore())
  return smokeBlits(calls).sort((a, b) => b.pos.y - a.pos.y)
}

describe('RopeMechanismAppearance.render — smoke lifecycle', () => {
  beforeEach(resetEditorStore)

  // Per CODE_029927 (bank_02.asm:3280-3339):
  //   tile bucket by age:  0..6 → $62, 7..10 → $64, 11..18 → $66
  //   yRise by age:         0..2 → 0,  3..10 → 1,    11..18 → 2
  //   lifetime:             ages 0..18 visible (19 frames); age 19 → cleanup
  //   spawn cadence:        every 8 frames; X parity flips per spawn cycle
  // Cohorts at any frame are { newest age=phase, middle age=phase+8, oldest=phase+16 }
  // where `phase = effFrame & 7`. Oldest is alive only when phase ≤ 2.

  describe('"3 alive" window — phases 0..2', () => {
    it('phase 0 (cycle 0 even): $62 y=-6 dx=0, $64 y=-7 dx=8, $66 y=-8 dx=0', () => {
      // ages 0, 8, 16 → tiles $62/$64/$66; yRise 0/1/2; even parity 0/8/0.
      const smoke = renderSmoke(0)
      expect(smoke).toEqual([
        { pos: { x: 0, y: -6 }, tileTag: 0x62 },
        { pos: { x: 8, y: -7 }, tileTag: 0x64 },
        { pos: { x: 0, y: -8 }, tileTag: 0x66 },
      ])
    })

    it('phase 2 (last frame of 3-alive window, cycle 0)', () => {
      // ages 2, 10, 18. age 2 still tile $62 yRise 0; age 10 tile $64 yRise 1;
      // age 18 tile $66 yRise 2. Same cluster geometry as phase 0.
      const smoke = renderSmoke(2)
      expect(smoke).toEqual([
        { pos: { x: 0, y: -6 }, tileTag: 0x62 },
        { pos: { x: 8, y: -7 }, tileTag: 0x64 },
        { pos: { x: 0, y: -8 }, tileTag: 0x66 },
      ])
    })

    it('phase 8 = phase 0 of cycle 1 (odd parity flips X)', () => {
      const smoke = renderSmoke(8)
      expect(smoke).toEqual([
        { pos: { x: 8, y: -6 }, tileTag: 0x62 },
        { pos: { x: 0, y: -7 }, tileTag: 0x64 },
        { pos: { x: 8, y: -8 }, tileTag: 0x66 },
      ])
    })
  })

  describe('"2 alive standard" window — phases 3..6 (newest still $62)', () => {
    it('phase 3 (oldest just died, newest yRise lifts to 1)', () => {
      // age 3 → tile $62, yRise=1 (DEC SmokeSpriteYPos triggered at age 3).
      // age 11 → tile $66, yRise=2 (second DEC at age 11).
      // age 19 → cleanup → not rendered.
      const smoke = renderSmoke(3)
      expect(smoke).toEqual([
        { pos: { x: 0, y: -7 }, tileTag: 0x62 },
        { pos: { x: 8, y: -8 }, tileTag: 0x66 },
      ])
    })

    it('phase 6 (last frame before newest tile flips to $64)', () => {
      // age 6 → tile $62 yRise 1; age 14 → tile $66 yRise 2.
      const smoke = renderSmoke(6)
      expect(smoke).toEqual([
        { pos: { x: 0, y: -7 }, tileTag: 0x62 },
        { pos: { x: 8, y: -8 }, tileTag: 0x66 },
      ])
    })

    it('phase 4 of cycle 1 (odd parity, X flipped)', () => {
      // effFrame 12 → newestAge 4, cycle 1 (odd). age 4 → $62 yRise 1 dx=8;
      // age 12 → $66 yRise 2 dx=0.
      const smoke = renderSmoke(12)
      expect(smoke).toEqual([
        { pos: { x: 8, y: -7 }, tileTag: 0x62 },
        { pos: { x: 0, y: -8 }, tileTag: 0x66 },
      ])
    })
  })

  describe('"2 alive newest=$64" window — phase 7 only', () => {
    it('phase 7 (newest cohort has aged into the $64 tile bucket)', () => {
      // age 7 → tile $64 (DATA_029922 index 2 hits at post-DEC timer 11).
      // age 15 → tile $66 yRise 2.
      // This is the brief 1-of-8 phase the prior model never visited.
      const smoke = renderSmoke(7)
      expect(smoke).toEqual([
        { pos: { x: 0, y: -7 }, tileTag: 0x64 },
        { pos: { x: 8, y: -8 }, tileTag: 0x66 },
      ])
    })

    it('phase 7 of cycle 1 (odd parity)', () => {
      // effFrame 15 → newestAge 7, cycle 1.
      const smoke = renderSmoke(15)
      expect(smoke).toEqual([
        { pos: { x: 8, y: -7 }, tileTag: 0x64 },
        { pos: { x: 0, y: -8 }, tileTag: 0x66 },
      ])
    })
  })

  describe('full-cycle invariants', () => {
    it('puff count: 3 during phases 0-2; 2 during phases 3-7 (3/8 vs 5/8 time-share)', () => {
      for (let p = 0; p <= 2; p++) expect(renderSmoke(p), `phase ${p}`).toHaveLength(3)
      for (let p = 3; p <= 7; p++) expect(renderSmoke(p), `phase ${p}`).toHaveLength(2)
    })

    it('$64 tile is visible during phase 0-2 (middle cohort) AND phase 7 (newest)', () => {
      for (let p = 0; p <= 2; p++) {
        const tags = renderSmoke(p).map(b => b.tileTag)
        expect(tags, `phase ${p}`).toContain(0x64)
      }
      for (let p = 3; p <= 6; p++) {
        const tags = renderSmoke(p).map(b => b.tileTag)
        expect(tags, `phase ${p}`).not.toContain(0x64)
      }
      // Phase 7 brings $64 back as the newest cohort.
      expect(renderSmoke(7).map(b => b.tileTag)).toContain(0x64)
    })

    it('phase loops back at frame 16 (cycle 2 even = same parity as cycle 0)', () => {
      expect(smokeCohortsAt(16)).toEqual(smokeCohortsAt(0))
    })

    it('translates by (x, y) anchor — smoke at effFrame=0, anchor (100, 200)', () => {
      const app = buildAppearance()
      const { target, calls } = capturingTarget()
      app.render(target, 100, 200, STUB_BEHAVIOR, stubMapStore())
      const smoke = smokeBlits(calls).sort((a, b) => b.pos.y - a.pos.y)
      expect(smoke).toEqual([
        { pos: { x: 100, y: 194 }, tileTag: 0x62 },  // 200 - 6
        { pos: { x: 108, y: 193 }, tileTag: 0x64 },  // 200 - 7, dx=8
        { pos: { x: 100, y: 192 }, tileTag: 0x66 },  // 200 - 8
      ])
    })
  })

  describe('tickAnimation drives the lifecycle at GAME_FRAMES_PER_TICK pace', () => {
    // ×3 multiplier visits all 8 phases over an 8-tick cycle. Phase visit
    // order: 0, 3, 6, 1, 4, 7, 2, 5. Time-share matches in-game proportions.
    it('puff count over an 8-tick cycle has 3-of-8 ticks at 3-alive (matches game 3/8)', () => {
      const app = buildAppearance()
      const ms = stubMapStore()
      const counts: number[] = []
      for (let i = 0; i < 8; i++) {
        const { target, calls } = capturingTarget()
        app.render(target, 0, 0, STUB_BEHAVIOR, ms)
        counts.push(smokeBlits(calls).length)
        app.tickAnimation()
      }
      // Phases visited: 0, 3, 6, 1, 4, 7, 2, 5
      // Counts:         3, 2, 2, 3, 2, 2, 3, 2
      expect(counts).toEqual([3, 2, 2, 3, 2, 2, 3, 2])
    })

    it('X parity follows cycle: even for ticks 0-2 (cycle 0), odd for ticks 3-5 (cycle 1)', () => {
      // Tick 0 → effFrame 0  (cycle 0)
      // Tick 1 → effFrame 3  (cycle 0)
      // Tick 2 → effFrame 6  (cycle 0)
      // Tick 3 → effFrame 9  (cycle 1)
      // Tick 4 → effFrame 12 (cycle 1)
      // Tick 5 → effFrame 15 (cycle 1)
      // Tick 6 → effFrame 18 (cycle 2)
      // Tick 7 → effFrame 21 (cycle 2)
      const app = buildAppearance()
      const ms = stubMapStore()
      const newestDxs: number[] = []
      for (let i = 0; i < 8; i++) {
        const { target, calls } = capturingTarget()
        app.render(target, 0, 0, STUB_BEHAVIOR, ms)
        const newest = smokeBlits(calls).sort((a, b) => b.pos.y - a.pos.y)[0]
        newestDxs.push(newest.pos.x)
        app.tickAnimation()
      }
      expect(newestDxs).toEqual([0, 0, 0, 8, 8, 8, 0, 0])
    })

    it('all three smoke tiles ($62, $64, $66) appear within an 8-tick cycle', () => {
      // Coverage check: ×3 multiplier hits phase 7 once per 8 ticks, so the
      // newest-as-$64 state (otherwise rare) is exercised.
      const app = buildAppearance()
      const ms = stubMapStore()
      const seen = new Set<number>()
      for (let i = 0; i < 8; i++) {
        const { target, calls } = capturingTarget()
        app.render(target, 0, 0, STUB_BEHAVIOR, ms)
        for (const b of smokeBlits(calls)) seen.add(b.tileTag)
        app.tickAnimation()
      }
      expect(seen).toEqual(new Set([0x62, 0x64, 0x66]))
    })
  })

  describe('smokeCohortsAt — pure lifecycle math', () => {
    it('phase 0: 3 cohorts, ages 0/8/16, even parity', () => {
      expect(smokeCohortsAt(0)).toEqual([
        { tileIdx: 0, puffDx: 0, yRise: 0 },
        { tileIdx: 1, puffDx: 8, yRise: 1 },
        { tileIdx: 2, puffDx: 0, yRise: 2 },
      ])
    })

    it('phase 3: oldest dead; newest yRise lifts to 1, middle showing $66', () => {
      expect(smokeCohortsAt(3)).toEqual([
        { tileIdx: 0, puffDx: 0, yRise: 1 },
        { tileIdx: 2, puffDx: 8, yRise: 2 },
      ])
    })

    it('phase 7: newest aged into $64 bucket — distinct visual state', () => {
      expect(smokeCohortsAt(7)).toEqual([
        { tileIdx: 1, puffDx: 0, yRise: 1 },
        { tileIdx: 2, puffDx: 8, yRise: 2 },
      ])
    })

    it('phase 8: cycle 1 with odd parity flips all X offsets', () => {
      expect(smokeCohortsAt(8)).toEqual([
        { tileIdx: 0, puffDx: 8, yRise: 0 },
        { tileIdx: 1, puffDx: 0, yRise: 1 },
        { tileIdx: 2, puffDx: 8, yRise: 2 },
      ])
    })

    it('phase loop: effFrame 16 = effFrame 0', () => {
      expect(smokeCohortsAt(16)).toEqual(smokeCohortsAt(0))
    })
  })
})
