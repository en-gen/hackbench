/**
 * CharFactory — synthetic branch coverage.
 *
 * Exercises collectAnimFrames and buildChars using synthetic VramState +
 * AnimationData, so coverage runs without a ROM file.
 *
 * Test tree:
 *   collectAnimFrames
 *     animData = undefined → empty map (early return)
 *     slot.altTiles?.[i] non-null → altTile truthy → altFrames created + filled
 *     anim.altFrames hole → altFrames dropped; char falls back to AnimatedPixelsBehavior
 *   buildChars (behavior selection)
 *     no animData → StaticPixelsBehavior
 *     animData, no altTiles → AnimatedPixelsBehavior
 *     animData with altTiles in all frames → PSwitchAlternateBehavior  ← anim?.altFrames true branch
 *     animData with altFrames hole → AnimatedPixelsBehavior (altFrames dropped)
 */

import { describe, it, expect } from 'vitest'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { PSwitchAlternateBehavior } from '../../../../src/rom/model/chars/behaviors/PSwitchAlternateBehavior'
import { AnimatedPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/AnimatedPixelsBehavior'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import type { VramState } from '../../../../src/rom/GfxLoader'
import type { AnimationData } from '../../../../src/rom/AnimationLoader'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PIXELS     = new Uint8Array(64).fill(1)
const ALT_PIXELS = new Uint8Array(64).fill(2)

// fg1 slot: VRAM_CHAR_BASE.fg1 = 0x000. Index 0 → char 0x000.
const VRAM: VramState = { fg1: [PIXELS] }

// ── No animData → StaticPixelsBehavior ───────────────────────────────────────

describe('buildChars — animData=undefined: StaticPixelsBehavior for every char', () => {
  it('each VRAM tile gets StaticPixelsBehavior when no animData is provided', () => {
    const chars = buildChars(VRAM)
    expect(chars.get(0x000)?.behavior).toBeInstanceOf(StaticPixelsBehavior)
  })
})

// ── animData with no altTiles → AnimatedPixelsBehavior ───────────────────────

describe('buildChars — animData present, no altTiles: AnimatedPixelsBehavior', () => {
  it('char gets AnimatedPixelsBehavior when slot has tiles but no altTiles', () => {
    const animData: AnimationData = {
      frameCount: 2,
      intervalMs: 133,
      frames: [
        [{ charBase: 0x000, tiles: [PIXELS] }],
        [{ charBase: 0x000, tiles: [PIXELS] }],
      ],
    }
    const chars = buildChars(VRAM, animData)
    expect(chars.get(0x000)?.behavior).toBeInstanceOf(AnimatedPixelsBehavior)
  })
})

// ── altTiles in all frames → PSwitchAlternateBehavior ────────────────────────

describe('buildChars — altTiles present in all frames: PSwitchAlternateBehavior', () => {
  it('charNum gets PSwitchAlternateBehavior when altTiles filled in every frame', () => {
    // Covers:
    //   collectAnimFrames line 98: slot.altTiles?.[i] non-null → truthy branch
    //   collectAnimFrames line 99: if (altTile) true
    //   collectAnimFrames line 100: if (!anim.altFrames) true (first frame)
    //   buildChars line 52: anim?.altFrames truthy → PSwitchAlternateBehavior
    const animData: AnimationData = {
      frameCount: 2,
      intervalMs: 133,
      frames: [
        [{ charBase: 0x000, tiles: [PIXELS], altTiles: [ALT_PIXELS] }],
        [{ charBase: 0x000, tiles: [PIXELS], altTiles: [ALT_PIXELS] }],
      ],
    }
    const chars = buildChars(VRAM, animData)
    expect(chars.get(0x000)?.behavior).toBeInstanceOf(PSwitchAlternateBehavior)
  })
})

// ── empty tiles array → char dropped ─────────────────────────────────────────

describe('buildChars — frame with tiles.length === 0: animation dropped, StaticPixelsBehavior used', () => {
  it('frame slot with empty Uint8Array fires anim.frames[f].length === 0 TRUE branch', () => {
    // slot.tiles[0] = new Uint8Array(0) is truthy (not filtered by `if (!tile) continue`),
    // so anim.frames[f] = new Uint8Array(0). At the drop-check loop,
    // `anim.frames[f].length === 0` is true → this charNum is added to toDelete
    // and removed from the animFrames map. buildChars then sees no animation
    // for char 0x000 → assigns StaticPixelsBehavior (not AnimatedPixelsBehavior).
    const animData: AnimationData = {
      frameCount: 1,
      intervalMs: 133,
      frames: [
        [{ charBase: 0x000, tiles: [new Uint8Array(0)] }],
      ],
    }
    const chars = buildChars(VRAM, animData)
    // Char 0x000 still exists (from VRAM) but without animation → StaticPixelsBehavior
    expect(chars.get(0x000)?.behavior).toBeInstanceOf(StaticPixelsBehavior)
  })
})

// ── altFrames hole → altFrames dropped, AnimatedPixelsBehavior ───────────────

describe('buildChars — altFrames hole in frame 1: altFrames dropped', () => {
  it('char falls back to AnimatedPixelsBehavior when altFrames has a missing frame', () => {
    // Frame 0 has altTiles → anim.altFrames created, altFrames[0] filled.
    // Frame 1 has no altTiles → altFrames[1] remains undefined → hole detected
    // → anim.altFrames set to undefined → buildChars selects AnimatedPixelsBehavior.
    const animData: AnimationData = {
      frameCount: 2,
      intervalMs: 133,
      frames: [
        [{ charBase: 0x000, tiles: [PIXELS], altTiles: [ALT_PIXELS] }],
        [{ charBase: 0x000, tiles: [PIXELS] }],   // no altTiles on frame 1
      ],
    }
    const chars = buildChars(VRAM, animData)
    expect(chars.get(0x000)?.behavior).toBeInstanceOf(AnimatedPixelsBehavior)
  })
})
