import { describe, it, expect } from 'vitest'
import { computed, ref } from '@vue/reactivity'
import { existsSync } from 'fs'
import { loadAnimationData } from '../../../../src/rom/AnimationLoader'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { loadVram } from '../../../../src/rom/GfxLoader'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { Char } from '../../../../src/rom/model/chars/Char'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { AnimatedPixels } from '../../../../src/rom/model/chars/behaviors/AnimatedPixels'
import { StaticPixels } from '../../../../src/rom/model/chars/behaviors/StaticPixels'
import type { RenderContext } from '../../../../src/rom/model/RenderTarget'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

function mockCtx(animFrame = 0): RenderContext {
  return {
    animFrame: ref(animFrame),
    palAnimFrame: ref(0),
    pSwitchActive: ref(false),
    switchPalaceState: ref<readonly [boolean, boolean, boolean, boolean]>([false, false, false, false]),
    palette: null as never,
    camera: ref({ tileX: 0, tileY: 0, focused: false }),
    zoom: ref(1),
    layerToggles: ref({ l1: true, l2: true, sprites: true, screens: true, block: true, mapGrid: false }),
  }
}

describe('AnimatedPixels behavior', () => {
  it('returns the frame at ctx.animFrame.value (wraps modulo length)', () => {
    const f0 = new Uint8Array(64).fill(1)
    const f1 = new Uint8Array(64).fill(2)
    const f2 = new Uint8Array(64).fill(3)
    const behavior = new AnimatedPixels([f0, f1, f2])
    expect(behavior.getPixels(mockCtx(0))).toBe(f0)
    expect(behavior.getPixels(mockCtx(1))).toBe(f1)
    expect(behavior.getPixels(mockCtx(2))).toBe(f2)
    expect(behavior.getPixels(mockCtx(3))).toBe(f0) // wraps
  })

  it('computed() wrapping an AnimatedPixels char invalidates only on animFrame change', () => {
    const ctx = mockCtx(0)
    const f0 = new Uint8Array(64).fill(10)
    const f1 = new Uint8Array(64).fill(20)
    const char = new Char(0x100, new AnimatedPixels([f0, f1]))
    const reactive = computed(() => char.getPixels(ctx))

    expect(reactive.value).toBe(f0)

    ctx.palAnimFrame.value = 7
    expect(reactive.value).toBe(f0) // still cached

    ctx.animFrame.value = 1
    expect(reactive.value).toBe(f1)
  })
})

describe.skipIf(!existsSync(ROM_PATH))('CharFactory animation wiring (vanilla ROM)', () => {
  it('wraps animated chars with AnimatedPixels; leaves others Static', () => {
    const rom = SmwRom.open(ROM_PATH)
    // Level $105 (YI1) uses tileset 0 and has standard animation (coins, ? blocks, etc)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const animData = loadAnimationData(rom.rom, header.objectTileset)!

    const chars = buildChars(vram, animData)

    // At least one animated char should exist
    const animatedChars = [...chars.values()].filter(c => c.behavior instanceof AnimatedPixels)
    expect(animatedChars.length).toBeGreaterThan(0)

    // And most chars should still be static
    const staticChars = [...chars.values()].filter(c => c.behavior instanceof StaticPixels)
    expect(staticChars.length).toBeGreaterThan(animatedChars.length * 10)
  })
})
