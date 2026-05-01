import { describe, it, expect, beforeEach } from 'vitest'
import { computed } from '@vue/reactivity'
import { existsSync } from 'fs'
import { loadAnimationData } from '../../../../src/rom/AnimationLoader'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { loadVram } from '../../../../src/rom/GfxLoader'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { Char } from '../../../../src/rom/model/chars/Char'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { AnimatedPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/AnimatedPixelsBehavior'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { editorStore, resetEditorStore } from '../fixtures/stores'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

describe('AnimatedPixelsBehavior behavior', () => {
  beforeEach(resetEditorStore)

  it('returns the frame at editorStore.animFrame (wraps modulo length)', () => {
    const f0 = new Uint8Array(64).fill(1)
    const f1 = new Uint8Array(64).fill(2)
    const f2 = new Uint8Array(64).fill(3)
    const behavior = new AnimatedPixelsBehavior([f0, f1, f2])
    editorStore.setAnimFrame(0)
    expect(behavior.getPixels()).toBe(f0)
    editorStore.setAnimFrame(1)
    expect(behavior.getPixels()).toBe(f1)
    editorStore.setAnimFrame(2)
    expect(behavior.getPixels()).toBe(f2)
    editorStore.setAnimFrame(3)
    expect(behavior.getPixels()).toBe(f0) // wraps
  })

  it('computed() wrapping an AnimatedPixelsBehavior char invalidates only on animFrame change', () => {
    const f0 = new Uint8Array(64).fill(10)
    const f1 = new Uint8Array(64).fill(20)
    const char = new Char(0x100, new AnimatedPixelsBehavior([f0, f1]))
    editorStore.setAnimFrame(0)
    const reactive = computed(() => char.getPixels())

    expect(reactive.value).toBe(f0)

    editorStore.setPalAnimFrame(7)
    expect(reactive.value).toBe(f0) // still cached

    editorStore.setAnimFrame(1)
    expect(reactive.value).toBe(f1)
  })
})

describe.skipIf(!existsSync(ROM_PATH))('CharFactory animation wiring (vanilla ROM)', () => {
  it('wraps animated chars with AnimatedPixelsBehavior; leaves others Static', () => {
    const rom = SmwRom.open(ROM_PATH)
    // Level $105 (YI1) uses tileset 0 and has standard animation (coins, ? blocks, etc)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const animData = loadAnimationData(rom.rom, header.objectTileset)!

    const chars = buildChars(vram, animData)

    // At least one animated char should exist
    const animatedChars = [...chars.values()].filter(c => c.behavior instanceof AnimatedPixelsBehavior)
    expect(animatedChars.length).toBeGreaterThan(0)

    // And most chars should still be static
    const staticChars = [...chars.values()].filter(c => c.behavior instanceof StaticPixelsBehavior)
    expect(staticChars.length).toBeGreaterThan(animatedChars.length * 10)
  })
})
