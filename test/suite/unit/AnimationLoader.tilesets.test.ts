/**
 * Tileset-specific animation group tests for AnimationLoader.
 *
 * SMW's DATA_05B98B maps each object tileset (0–13) to an offset into
 * AnimatedTileData, giving six distinct animation groups. This suite verifies
 * that loadAnimationData() selects the correct group for each tileset and that
 * tilesets sharing an offset produce identical results.
 *
 * AnimatedTileData entry layout (behavior-2 tiles produce these at VRAM chars):
 *   Group A (offset  0, tilesets 0/10/12): Water @ $070, Lava @ $04C, static @ $044/$048/$040
 *   Group B (offset  5, tilesets  1/11):   Water @ $070, Coin @ $04C, Escl-Up @ $044, Escl-Dn @ $048, Candle @ $040
 *   Group C (offset 10, tilesets   2/8):   Water @ $070, Rope @ $04C, Diag-Up @ $044, Diag-Dn @ $048, static @ $040
 *   Group D (offset 15, tileset      3):   static @ $070, GradLava @ $04C, DiagLava @ $044, LavaWall @ $048, GradLavaRev @ $040
 *   Group E (offset 20, tilesets 4/5/7/9/13): static @ $070, GhostLantern @ $04C, Seaweed @ $044, static @ $048/$040
 *   Group F (offset 25, tileset      6):   static @ $070, Shining-stars @ $04C, Twinkling-stars @ $044, static @ $048/$040
 *
 * ROM reference: bank_05.asm DATA_05B98B, DATA_05B96B (extended to 24 bytes),
 *                AnimatedTileData table ($05B999).
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import { loadAnimationData, AnimationData } from '../../../src/rom/AnimationLoader'

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Collect all animated chars across all frames for the given animation data. */
function animatedChars(animData: AnimationData): Set<number> {
  const chars = new Set<number>()
  for (const frameSlots of animData.frames) {
    for (const slot of frameSlots) {
      for (let i = 0; i < slot.tiles.length; i++) {
        chars.add(slot.charBase + i)
      }
    }
  }
  return chars
}

/**
 * Return per-frame pixel data for the first tile at charBase, or null if the
 * char is not animated. Used to check whether frames differ (animated) or are
 * identical (static source data).
 */
function charFrameData(animData: AnimationData, charBase: number): (Uint8Array | null)[] {
  return animData.frames.map(frameSlots => {
    const slot = frameSlots.find(s => s.charBase === charBase)
    return slot ? slot.tiles[0] : null
  })
}

/** True if at least two frames have non-identical pixel data for the given char. */
function isAnimatedAt(animData: AnimationData, charBase: number): boolean {
  const frames = charFrameData(animData, charBase)
  const present = frames.filter(f => f !== null) as Uint8Array[]
  if (present.length < 2) return false
  const ref = present[0].join(',')
  return present.some(f => f.join(',') !== ref)
}

/** True if all 4 frames have identical pixel data (static source). */
function isStaticAt(animData: AnimationData, charBase: number): boolean {
  const frames = charFrameData(animData, charBase)
  const present = frames.filter(f => f !== null) as Uint8Array[]
  if (present.length < 2) return true
  const ref = present[0].join(',')
  return present.every(f => f.join(',') === ref)
}

/** Assert two AnimationData objects produce identical frame output at a char. */
function expectSameCharData(
  a: AnimationData, b: AnimationData, charBase: number, label: string,
): void {
  const framesA = charFrameData(a, charBase)
  const framesB = charFrameData(b, charBase)
  for (let f = 0; f < 4; f++) {
    const fa = framesA[f]?.join(',') ?? 'null'
    const fb = framesB[f]?.join(',') ?? 'null'
    expect(fa, `${label} frame ${f} char $${charBase.toString(16).padStart(3, '0')}`).toBe(fb)
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AnimationLoader tileset groups', () => {
  if (!romPresent) {
    it.skip('ROM not available', () => {})
    return
  }

  const rom = SmwRom.open(ROM_PATH)

  // Cache animation data per tileset (expensive to recompute each test)
  const animCache = new Map<number, AnimationData>()
  function anim(tilesetId: number): AnimationData {
    if (!animCache.has(tilesetId)) {
      const data = loadAnimationData(rom.rom, tilesetId)
      expect(data, `loadAnimationData(${tilesetId}) returned null`).not.toBeNull()
      animCache.set(tilesetId, data!)
    }
    return animCache.get(tilesetId)!
  }

  // ── Behavior-2 VRAM destination chars ────────────────────────────────────
  // tileIdx 14 → group 4 sub 2, DestA = VRAM $0700 → char $070
  // tileIdx 15 → group 5 sub 0, DestC = VRAM $04C0 → char $04C
  // tileIdx 16 → group 5 sub 1, DestB = VRAM $0440 → char $044
  // tileIdx 17 → group 5 sub 2, DestA = VRAM $0480 → char $048
  // tileIdx 18 → group 6 sub 0, DestC = VRAM $0400 → char $040

  it('all 14 tilesets load without error', () => {
    for (let ts = 0; ts < 14; ts++) {
      const data = loadAnimationData(rom.rom, ts)
      expect(data, `tileset ${ts}`).not.toBeNull()
      expect(data!.frameCount).toBe(4)
      expect(data!.frames).toHaveLength(4)
    }
  })

  // ── Group A: tilesets 0, 10, 12 (offset 0) ───────────────────────────────

  describe('Group A (offset 0) — tilesets 0, 10, 12 — Water + Lava', () => {
    it('tileset 0 char $070 is animated (Water)', () => {
      expect(animatedChars(anim(0)).has(0x070)).toBe(true)
      expect(isAnimatedAt(anim(0), 0x070)).toBe(true)
    })

    it('tileset 0 char $04C is animated (Lava)', () => {
      expect(animatedChars(anim(0)).has(0x04C)).toBe(true)
      expect(isAnimatedAt(anim(0), 0x04C)).toBe(true)
    })

    it('tilesets 0, 10, 12 produce identical animation data', () => {
      for (const char of [0x070, 0x04C, 0x044, 0x048, 0x040]) {
        expectSameCharData(anim(0), anim(10), char, 'ts0 vs ts10')
        expectSameCharData(anim(0), anim(12), char, 'ts0 vs ts12')
      }
    })
  })

  // ── Group B: tilesets 1, 11 (offset 5) ───────────────────────────────────

  describe('Group B (offset 5) — tilesets 1, 11 — Coin + Escalators + Candle', () => {
    it('tileset 1 char $070 is animated (Water — same source data as Group A)', () => {
      expect(isAnimatedAt(anim(1), 0x070)).toBe(true)
    })

    it('tileset 1 char $04C is animated (Coin)', () => {
      // Note: Group B "Coin" entries in DATA_05BA39 intentionally share the same
      // AnimatedTiles source offsets as Group A "Lava" ($1180 etc.), so pixel data
      // is identical — only the applied palette differs at runtime.
      expect(isAnimatedAt(anim(1), 0x04C)).toBe(true)
    })

    it('tileset 1 char $044 is animated (Escalator Up)', () => {
      expect(isAnimatedAt(anim(1), 0x044)).toBe(true)
    })

    it('tileset 1 char $048 is animated (Escalator Down)', () => {
      expect(isAnimatedAt(anim(1), 0x048)).toBe(true)
    })

    it('tileset 1 char $040 is animated (Candle glow — tileIdx 18 fix)', () => {
      // Before the bug fix, tileIdx 18 was treated as behavior 0 (static ?Block).
      // After the fix, it reads behavior $02 from the DATA_05B97D spill byte,
      // giving adjustedIdx = 18 + 5 = 23 → Candle glow animation.
      expect(isAnimatedAt(anim(1), 0x040)).toBe(true)
    })

    it('tileset 1 char $040 differs from tileset 0 (Candle vs static)', () => {
      // Tileset 0 has adjustedIdx 18 → static ?Block at char $040 (all frames same).
      // Tileset 1 has adjustedIdx 23 → Candle glow (4 distinct frames).
      const ts0_static = isStaticAt(anim(0), 0x040)
      const ts1_animated = isAnimatedAt(anim(1), 0x040)
      expect(ts0_static).toBe(true)
      expect(ts1_animated).toBe(true)
    })

    it('tilesets 1 and 11 produce identical animation data', () => {
      for (const char of [0x070, 0x04C, 0x044, 0x048, 0x040]) {
        expectSameCharData(anim(1), anim(11), char, 'ts1 vs ts11')
      }
    })
  })

  // ── Group C: tilesets 2, 8 (offset 10) ───────────────────────────────────

  describe('Group C (offset 10) — tilesets 2, 8 — Rope + Diagonal ropes', () => {
    it('tileset 2 char $04C is animated (Rope)', () => {
      expect(isAnimatedAt(anim(2), 0x04C)).toBe(true)
    })

    it('tileset 2 char $04C differs from tilesets 0 and 1', () => {
      const ts0 = charFrameData(anim(0), 0x04C)[0]?.join(',')
      const ts1 = charFrameData(anim(1), 0x04C)[0]?.join(',')
      const ts2 = charFrameData(anim(2), 0x04C)[0]?.join(',')
      expect(ts2).not.toBe(ts0)
      expect(ts2).not.toBe(ts1)
    })

    it('tileset 2 char $044 is animated (Diagonal rope Up)', () => {
      expect(isAnimatedAt(anim(2), 0x044)).toBe(true)
    })

    it('tileset 2 char $048 is animated (Diagonal rope Down)', () => {
      expect(isAnimatedAt(anim(2), 0x048)).toBe(true)
    })

    it('tilesets 2 and 8 produce identical animation data', () => {
      for (const char of [0x070, 0x04C, 0x044, 0x048, 0x040]) {
        expectSameCharData(anim(2), anim(8), char, 'ts2 vs ts8')
      }
    })
  })

  // ── Group D: tileset 3 (offset 15) ───────────────────────────────────────

  describe('Group D (offset 15) — tileset 3 — Underground lava variants', () => {
    it('tileset 3 char $04C is animated (Gradual sloped lava)', () => {
      expect(isAnimatedAt(anim(3), 0x04C)).toBe(true)
    })

    it('tileset 3 char $044 is animated (Diagonal sloped lava)', () => {
      expect(isAnimatedAt(anim(3), 0x044)).toBe(true)
    })

    it('tileset 3 char $048 is animated (Lava wall)', () => {
      expect(isAnimatedAt(anim(3), 0x048)).toBe(true)
    })

    it('tileset 3 char $040 is animated (Gradual sloped lava reversed — tileIdx 18 fix)', () => {
      // adjustedIdx = 18 + 15 = 33 → Gradual sloped lava reversed (4-frame reverse cycle)
      expect(isAnimatedAt(anim(3), 0x040)).toBe(true)
    })

    it('tileset 3 char $04C differs from tileset 0 (GradLava vs Lava)', () => {
      const ts0 = charFrameData(anim(0), 0x04C)[0]?.join(',')
      const ts3 = charFrameData(anim(3), 0x04C)[0]?.join(',')
      expect(ts3).not.toBe(ts0)
    })
  })

  // ── Group E: tilesets 4, 5, 7, 9, 13 (offset 20) ────────────────────────

  describe('Group E (offset 20) — tilesets 4/5/7/9/13 — Ghost house lantern + Seaweed', () => {
    it('tileset 5 char $04C is animated (Ghost house lantern)', () => {
      expect(isAnimatedAt(anim(5), 0x04C)).toBe(true)
    })

    it('tileset 5 char $04C differs from tileset 0 (lantern vs lava)', () => {
      const ts0 = charFrameData(anim(0), 0x04C)[0]?.join(',')
      const ts5 = charFrameData(anim(5), 0x04C)[0]?.join(',')
      expect(ts5).not.toBe(ts0)
    })

    it('tileset 5 char $044 is animated (Seaweed)', () => {
      expect(isAnimatedAt(anim(5), 0x044)).toBe(true)
    })

    it('tilesets 4, 5, 7, 9, 13 all produce identical animation data', () => {
      const chars = [0x070, 0x04C, 0x044, 0x048, 0x040]
      for (const other of [5, 7, 9, 13]) {
        for (const char of chars) {
          expectSameCharData(anim(4), anim(other), char, `ts4 vs ts${other}`)
        }
      }
    })
  })

  // ── Group F: tileset 6 (offset 25) ───────────────────────────────────────

  describe('Group F (offset 25) — tileset 6 — Switch Palace stars', () => {
    it('tileset 6 char $070 is animated (Shining stars)', () => {
      // tileIdx 14, adjustedIdx = 14 + 25 = 39 → AnimatedTileData entries 156-159 (Shining stars)
      expect(isAnimatedAt(anim(6), 0x070)).toBe(true)
    })

    it('tileset 6 char $04C is animated (Twinkling stars)', () => {
      // tileIdx 15, adjustedIdx = 15 + 25 = 40 → AnimatedTileData entries 160-163 (Twinkling stars)
      expect(isAnimatedAt(anim(6), 0x04C)).toBe(true)
    })

    it('tileset 6 char $04C differs from Groups C, D, E at $04C', () => {
      // Groups C/D/E use Rope, Gradual lava, Ghost lantern respectively — all different from Twinkling stars
      const ts6 = charFrameData(anim(6), 0x04C)[0]?.join(',')
      for (const other of [2, 3, 5]) {
        const tsOther = charFrameData(anim(other), 0x04C)[0]?.join(',')
        expect(ts6, `ts6 vs ts${other} at $04C`).not.toBe(tsOther)
      }
    })
  })

  // ── Cross-group sanity ───────────────────────────────────────────────────

  describe('cross-group sanity', () => {
    it('Groups C/D/E/F produce distinct $04C data from each other', () => {
      // Groups A+B share the same AnimatedTiles source offsets at $04C (design intent),
      // but C/D/E/F each use unique sources: Rope, GradLava, GhostLantern, TwinklingStars.
      const groups = [
        { ts: 2, label: 'C-Rope' },
        { ts: 3, label: 'D-GradLava' },
        { ts: 5, label: 'E-Lantern' },
        { ts: 6, label: 'F-TwinklStars' },
      ]
      const frame0s = groups.map(g => ({
        label: g.label,
        data: charFrameData(anim(g.ts), 0x04C)[0]?.join(',') ?? 'null',
      }))
      const seen = new Set<string>()
      for (const { label, data } of frame0s) {
        expect(seen.has(data), `${label} $04C duplicates a prior group`).toBe(false)
        seen.add(data)
      }
    })

    it('Groups D and F produce distinct $044 data', () => {
      // Group D: Diagonal sloped lava; Group F: static ?Block — both different
      const tsD = charFrameData(anim(3), 0x044)[0]?.join(',')
      const tsF = charFrameData(anim(6), 0x044)[0]?.join(',')
      expect(tsD).not.toBe(tsF)
    })

    it('tileIdx 18 (char $040) is static for Groups A/C/E/F, animated for Groups B and D', () => {
      // Groups A, C, E, F: adjustedIdx 18, 28, 38, 43 all → static ?Block ($1800)
      for (const ts of [0, 2, 5, 6]) {
        expect(isStaticAt(anim(ts), 0x040), `tileset ${ts} $040 should be static`).toBe(true)
      }
      // Group B (tileset 1): adjustedIdx 23 → Candle glow (animated)
      expect(isAnimatedAt(anim(1), 0x040)).toBe(true)
      // Group D (tileset 3): adjustedIdx 33 → Gradual sloped lava reversed (animated)
      expect(isAnimatedAt(anim(3), 0x040)).toBe(true)
    })
  })
})
