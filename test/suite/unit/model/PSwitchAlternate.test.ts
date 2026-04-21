import { describe, it, expect } from 'vitest'
import { computed, ref } from '@vue/reactivity'
import { Char } from '../../../../src/rom/model/chars/Char'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { AnimatedPixels } from '../../../../src/rom/model/chars/behaviors/AnimatedPixels'
import { PSwitchAlternate } from '../../../../src/rom/model/chars/behaviors/PSwitchAlternate'
import { StaticPixels } from '../../../../src/rom/model/chars/behaviors/StaticPixels'
import type { RenderContext } from '../../../../src/rom/model/RenderTarget'
import type { VramState } from '../../../../src/rom/GfxLoader'

function mockCtx(pSwitchActive = false, animFrame = 0): RenderContext {
  return {
    animFrame: ref(animFrame),
    palAnimFrame: ref(0),
    pSwitchActive: ref(pSwitchActive),
    switchPalaceState: ref<readonly [boolean, boolean, boolean, boolean]>([false, false, false, false]),
    palette: null as never,
    camera: ref({ tileX: 0, tileY: 0, focused: false }),
    zoom: ref(1),
    layerToggles: ref({ l1: true, l2: true, sprites: true, screens: true, block: true, mapGrid: false }),
  }
}

describe('PSwitchAlternate behavior', () => {
  it('returns the normal behavior when pSwitchActive is false', () => {
    const normal = new StaticPixels(new Uint8Array(64).fill(1))
    const alt = new StaticPixels(new Uint8Array(64).fill(2))
    const b = new PSwitchAlternate(normal, alt)
    expect(b.getPixels(mockCtx(false))).toBe((normal as StaticPixels).pixels)
  })

  it('returns the alt behavior when pSwitchActive is true', () => {
    const normal = new StaticPixels(new Uint8Array(64).fill(1))
    const alt = new StaticPixels(new Uint8Array(64).fill(2))
    const b = new PSwitchAlternate(normal, alt)
    expect(b.getPixels(mockCtx(true))).toBe((alt as StaticPixels).pixels)
  })

  it('composes with AnimatedPixels — animated coin that responds to P-switch', () => {
    const coinFrames = [
      new Uint8Array(64).fill(10),
      new Uint8Array(64).fill(11),
      new Uint8Array(64).fill(12),
    ]
    const usedBlock = new Uint8Array(64).fill(99)
    const behavior = new PSwitchAlternate(
      new AnimatedPixels(coinFrames),
      new StaticPixels(usedBlock),
    )

    // P-switch off: cycles through coin frames
    expect(behavior.getPixels(mockCtx(false, 0))).toBe(coinFrames[0])
    expect(behavior.getPixels(mockCtx(false, 1))).toBe(coinFrames[1])
    expect(behavior.getPixels(mockCtx(false, 2))).toBe(coinFrames[2])
    // P-switch on: used block, regardless of animFrame
    expect(behavior.getPixels(mockCtx(true, 0))).toBe(usedBlock)
    expect(behavior.getPixels(mockCtx(true, 1))).toBe(usedBlock)
  })

  it('CharFactory wraps paired chars in PSwitchAlternate over their base behaviors', () => {
    // Build a synthetic VRAM with two chars in the fg1 slot — coin at
    // index 0x5C (flat 0x05C) and used-block at 0x82 (flat 0x082).
    const fg1Sheet: Uint8Array[] = new Array(128)
    fg1Sheet[0x5C] = new Uint8Array(64).fill(1) // coin
    fg1Sheet[0x82] = new Uint8Array(64).fill(2) // used block
    const vram: VramState = { fg1: fg1Sheet }
    const pairs = [{ normalCharNum: 0x5C, altCharNum: 0x82 }]

    const chars = buildChars(vram, undefined, pairs)

    const coin = chars.get(0x5C)!
    const usedBlock = chars.get(0x82)!
    expect(coin.behavior).toBeInstanceOf(PSwitchAlternate)
    expect(usedBlock.behavior).toBeInstanceOf(StaticPixels) // not paired, stays plain

    const psa = coin.behavior as PSwitchAlternate
    expect(psa.normal).toBeInstanceOf(StaticPixels)
    expect(psa.alt).toBeInstanceOf(StaticPixels)
    expect((psa.alt as StaticPixels).pixels).toBe(fg1Sheet[0x82])
  })

  it('computed() tracks pSwitchActive + animFrame transitively', () => {
    const ctx = mockCtx(false, 0)
    const coin = new Uint8Array(64).fill(7)
    const used = new Uint8Array(64).fill(8)
    const behavior = new PSwitchAlternate(
      new AnimatedPixels([coin, new Uint8Array(64).fill(70)]),
      new StaticPixels(used),
    )
    const char = new Char(0x100, behavior)
    const reactive = computed(() => char.getPixels(ctx))

    expect(reactive.value).toBe(coin)

    // animFrame change invalidates (normal branch depends on it)
    ctx.animFrame.value = 1
    expect(reactive.value[0]).toBe(70)

    // pSwitch change invalidates (top-level branch)
    ctx.pSwitchActive.value = true
    expect(reactive.value).toBe(used)

    // palAnimFrame doesn't affect either branch — cached
    ctx.palAnimFrame.value = 5
    expect(reactive.value).toBe(used)
  })
})
