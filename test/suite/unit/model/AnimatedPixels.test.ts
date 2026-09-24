import { describe, it, expect, beforeEach } from 'vitest'
import { loadAnimationData } from '../../../../src/rom/AnimationLoader'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { loadVram } from '../../../../src/rom/GfxLoader'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { AnimatedPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/AnimatedPixelsBehavior'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { resetEditorStore } from '../fixtures/stores'
import { VANILLA, hasRom, romPath } from '../../support/corpus'

const ROM_PATH = romPath(VANILLA)

describe('AnimatedPixelsBehavior behavior', () => {
  beforeEach(resetEditorStore)

  it('starts on frame 0 and advances through the cycle on tickAnimation()', () => {
    const f0 = new Uint8Array(64).fill(1)
    const f1 = new Uint8Array(64).fill(2)
    const f2 = new Uint8Array(64).fill(3)
    const behavior = new AnimatedPixelsBehavior([f0, f1, f2])
    expect(behavior.getPixels()).toBe(f0)
    behavior.tickAnimation()
    expect(behavior.getPixels()).toBe(f1)
    behavior.tickAnimation()
    expect(behavior.getPixels()).toBe(f2)
    behavior.tickAnimation()
    expect(behavior.getPixels()).toBe(f0) // wraps
  })

  it('owns its frame state independently - separate instances do not share', () => {
    const f0 = new Uint8Array(64).fill(10)
    const f1 = new Uint8Array(64).fill(20)
    const a = new AnimatedPixelsBehavior([f0, f1])
    const b = new AnimatedPixelsBehavior([f0, f1])
    a.tickAnimation()
    expect(a.getPixels()).toBe(f1)
    expect(b.getPixels()).toBe(f0)
  })
})

describe.skipIf(!hasRom(VANILLA))('CharFactory animation wiring (vanilla ROM)', () => {
  it('wraps animated chars with AnimatedPixelsBehavior; leaves others Static', () => {
    const rom = SmwRom.open(ROM_PATH)
    // Level $105 (YI1) uses tileset 0 and has standard animation (coins, ? blocks, etc)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const animData = loadAnimationData(rom.rom, header.objectTileset)!

    const chars = buildChars(vram, animData)

    // At least one animated char should exist
    const animatedChars = [...chars.values()].filter(
      c => c.behavior instanceof AnimatedPixelsBehavior,
    )
    expect(animatedChars.length).toBeGreaterThan(0)

    // And most chars should still be static
    const staticChars = [...chars.values()].filter(c => c.behavior instanceof StaticPixelsBehavior)
    expect(staticChars.length).toBeGreaterThan(animatedChars.length * 10)
  })
})
