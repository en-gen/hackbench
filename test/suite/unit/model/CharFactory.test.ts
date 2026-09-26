/**
 * CharFactory - synthetic branch coverage.
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
import { buildChars, vramFromChars } from '../../../../src/rom/model/chars/CharFactory'
import { PSwitchAlternateBehavior } from '../../../../src/rom/model/chars/behaviors/PSwitchAlternateBehavior'
import { AnimatedPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/AnimatedPixelsBehavior'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import type { VramState } from '../../../../src/rom/GfxLoader'
import type { AnimationData } from '../../../../src/rom/AnimationLoader'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PIXELS = new Uint8Array(64).fill(1)
const ALT_PIXELS = new Uint8Array(64).fill(2)

// fg1 slot: VRAM_CHAR_BASE.fg1 = 0x000. Index 0 → char 0x000.
const VRAM: VramState = { fg1: [PIXELS] }

// ── No animData → StaticPixelsBehavior ───────────────────────────────────────

describe('buildChars - animData=undefined: StaticPixelsBehavior for every char', () => {
  it('each VRAM tile gets StaticPixelsBehavior when no animData is provided', () => {
    const chars = buildChars(VRAM)
    expect(chars.get(0x000)?.behavior).toBeInstanceOf(StaticPixelsBehavior)
  })
})

// ── animData with no altTiles → AnimatedPixelsBehavior ───────────────────────

describe('buildChars - animData present, no altTiles: AnimatedPixelsBehavior', () => {
  it('char gets AnimatedPixelsBehavior when slot has tiles but no altTiles', () => {
    const animData: AnimationData = {
      frameCount: 2,
      intervalMs: 133,
      frames: [[{ charBase: 0x000, tiles: [PIXELS] }], [{ charBase: 0x000, tiles: [PIXELS] }]],
    }
    const chars = buildChars(VRAM, animData)
    expect(chars.get(0x000)?.behavior).toBeInstanceOf(AnimatedPixelsBehavior)
  })
})

// ── altTiles in all frames → PSwitchAlternateBehavior ────────────────────────

describe('buildChars - altTiles present in all frames: PSwitchAlternateBehavior', () => {
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
        [{ charBase: 0x000, tiles: [PIXELS], alt: { switch: 'blue', tiles: [ALT_PIXELS] } }],
        [{ charBase: 0x000, tiles: [PIXELS], alt: { switch: 'blue', tiles: [ALT_PIXELS] } }],
      ],
    }
    const chars = buildChars(VRAM, animData)
    expect(chars.get(0x000)?.behavior).toBeInstanceOf(PSwitchAlternateBehavior)
  })
})

// ── empty tiles array → char dropped ─────────────────────────────────────────

describe('buildChars - frame with tiles.length === 0: animation dropped, StaticPixelsBehavior used', () => {
  it('frame slot with empty Uint8Array fires anim.frames[f].length === 0 TRUE branch', () => {
    // slot.tiles[0] = new Uint8Array(0) is truthy (not filtered by `if (!tile) continue`),
    // so anim.frames[f] = new Uint8Array(0). At the drop-check loop,
    // `anim.frames[f].length === 0` is true → this charNum is added to toDelete
    // and removed from the animFrames map. buildChars then sees no animation
    // for char 0x000 → assigns StaticPixelsBehavior (not AnimatedPixelsBehavior).
    const animData: AnimationData = {
      frameCount: 1,
      intervalMs: 133,
      frames: [[{ charBase: 0x000, tiles: [new Uint8Array(0)] }]],
    }
    const chars = buildChars(VRAM, animData)
    // Char 0x000 still exists (from VRAM) but without animation → StaticPixelsBehavior
    expect(chars.get(0x000)?.behavior).toBeInstanceOf(StaticPixelsBehavior)
  })
})

// ── vramFromChars: chars model → VramState snapshot ──────────────────────────

describe('vramFromChars', () => {
  it('with no animData at all, every char is StaticPixelsBehavior over the base array, so the whole slot is returned unchanged by reference', () => {
    const chars = buildChars(VRAM) // no animData -> StaticPixelsBehavior(sheet[i]) for every char
    const snapshot = vramFromChars(VRAM, chars)
    expect(snapshot.fg1).toBe(VRAM.fg1)
  })

  /**
   * The claim this whole fix depends on, and the one an earlier draft of
   * this file's doc comment got backwards: an ANIMATED char's frame data
   * comes from AnimationLoader, decoded from a separate part of the cart
   * than the tileset's own GFX file - so even at PHASE 0, before any
   * tickAnimation(), its pixels are a genuinely different array than
   * whatever the GFX file left at that VRAM slot, and the slot must be
   * patched. `FRAME0_DISTINCT_FROM_BASE` deliberately has the SAME
   * content as `PIXELS` but is a different Uint8Array instance, so this
   * pins the check as reference equality, not a content diff - matching
   * `vramFromChars`'s own `pixels === sheet[i]` early-out.
   */
  it('an animated char already differs from base at phase 0, before any tickAnimation', () => {
    const frame0DistinctFromBase = new Uint8Array(PIXELS) // same bytes, different object
    const animData: AnimationData = {
      frameCount: 2,
      intervalMs: 133,
      frames: [
        [{ charBase: 0x000, tiles: [frame0DistinctFromBase] }],
        [{ charBase: 0x000, tiles: [ALT_PIXELS] }],
      ],
    }
    const chars = buildChars(VRAM, animData)
    const snapshot = vramFromChars(VRAM, chars) // no tickAnimation() call
    expect(snapshot.fg1).not.toBe(VRAM.fg1) // slot IS copied
    expect(snapshot.fg1![0]).toBe(frame0DistinctFromBase) // frame 0's own array, not base's
    expect(snapshot.fg1![0]).not.toBe(VRAM.fg1![0])
  })

  it("after tickAnimation, the snapshot reflects the animated char's new frame, base untouched", () => {
    const animData: AnimationData = {
      frameCount: 2,
      intervalMs: 133,
      frames: [[{ charBase: 0x000, tiles: [PIXELS] }], [{ charBase: 0x000, tiles: [ALT_PIXELS] }]],
    }
    const chars = buildChars(VRAM, animData)
    for (const char of chars.values()) char.tickAnimation()

    const snapshot = vramFromChars(VRAM, chars)
    expect(snapshot.fg1).not.toBe(VRAM.fg1) // slot copied, not mutated in place
    expect(snapshot.fg1![0]).toBe(ALT_PIXELS)
    expect(VRAM.fg1![0]).toBe(PIXELS) // base is never mutated
  })

  it('a char with no entry in `chars` (VRAM has a slot the model does not cover) keeps its base pixels', () => {
    const twoTileVram: VramState = { fg1: [PIXELS, ALT_PIXELS] }
    const partialChars = new Map(buildChars({ fg1: [PIXELS] })) // only char 0x000
    const snapshot = vramFromChars(twoTileVram, partialChars)
    expect(snapshot.fg1![1]).toBe(ALT_PIXELS) // untouched: no Char for 0x001
  })
})

// ── altFrames hole → altFrames dropped, AnimatedPixelsBehavior ───────────────

describe('buildChars - altFrames hole in frame 1: altFrames dropped', () => {
  it('char falls back to AnimatedPixelsBehavior when altFrames has a missing frame', () => {
    // Frame 0 has altTiles → anim.altFrames created, altFrames[0] filled.
    // Frame 1 has no altTiles → altFrames[1] remains undefined → hole detected
    // → anim.altFrames set to undefined → buildChars selects AnimatedPixelsBehavior.
    const animData: AnimationData = {
      frameCount: 2,
      intervalMs: 133,
      frames: [
        [{ charBase: 0x000, tiles: [PIXELS], alt: { switch: 'blue', tiles: [ALT_PIXELS] } }],
        [{ charBase: 0x000, tiles: [PIXELS] }], // no altTiles on frame 1
      ],
    }
    const chars = buildChars(VRAM, animData)
    expect(chars.get(0x000)?.behavior).toBeInstanceOf(AnimatedPixelsBehavior)
  })
})

describe('buildChars - silver and ON/OFF alternates: not bound to the blue toggle', () => {
  it.each(['silver', 'onOff'] as const)(
    'a %s slot animates without PSwitchAlternateBehavior',
    k => {
      const slot = { charBase: 0x000, tiles: [PIXELS], alt: { switch: k, tiles: [ALT_PIXELS] } }
      const chars = buildChars(VRAM, { frameCount: 2, intervalMs: 133, frames: [[slot], [slot]] })
      expect(chars.get(0x000)?.behavior).toBeInstanceOf(AnimatedPixelsBehavior)
    },
  )
})
