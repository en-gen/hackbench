import { describe, it, expect } from 'vitest'
import { computed, ref } from '@vue/reactivity'
import { existsSync } from 'fs'
import { Char } from '../../../../src/rom/model/chars/Char'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { AnimatedPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/AnimatedPixelsBehavior'
import { PSwitchAlternateBehavior } from '../../../../src/rom/model/chars/behaviors/PSwitchAlternateBehavior'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import type { RenderContext } from '../../../../src/rom/model/RenderTarget'
import type { VramState } from '../../../../src/rom/GfxLoader'
import type { AnimationData, AnimFrameSlot } from '../../../../src/rom/AnimationLoader'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

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

describe('PSwitchAlternateBehavior behavior', () => {
  it('returns the normal behavior when pSwitchActive is false', () => {
    const normal = new StaticPixelsBehavior(new Uint8Array(64).fill(1))
    const alt = new StaticPixelsBehavior(new Uint8Array(64).fill(2))
    const b = new PSwitchAlternateBehavior(normal, alt)
    expect(b.getPixels(mockCtx(false))).toBe((normal as StaticPixelsBehavior).pixels)
  })

  it('returns the alt behavior when pSwitchActive is true', () => {
    const normal = new StaticPixelsBehavior(new Uint8Array(64).fill(1))
    const alt = new StaticPixelsBehavior(new Uint8Array(64).fill(2))
    const b = new PSwitchAlternateBehavior(normal, alt)
    expect(b.getPixels(mockCtx(true))).toBe((alt as StaticPixelsBehavior).pixels)
  })

  it('composes with AnimatedPixelsBehavior — animated coin that responds to P-switch', () => {
    const coinFrames = [
      new Uint8Array(64).fill(10),
      new Uint8Array(64).fill(11),
      new Uint8Array(64).fill(12),
    ]
    const usedBlock = new Uint8Array(64).fill(99)
    const behavior = new PSwitchAlternateBehavior(
      new AnimatedPixelsBehavior(coinFrames),
      new StaticPixelsBehavior(usedBlock),
    )

    // P-switch off: cycles through coin frames
    expect(behavior.getPixels(mockCtx(false, 0))).toBe(coinFrames[0])
    expect(behavior.getPixels(mockCtx(false, 1))).toBe(coinFrames[1])
    expect(behavior.getPixels(mockCtx(false, 2))).toBe(coinFrames[2])
    // P-switch on: used block, regardless of animFrame
    expect(behavior.getPixels(mockCtx(true, 0))).toBe(usedBlock)
    expect(behavior.getPixels(mockCtx(true, 1))).toBe(usedBlock)
  })

  it('CharFactory wraps chars whose anim slot carries altTiles in PSwitchAlternateBehavior', () => {
    // Synthetic coin slot at char $054 (FG1). `tiles` is the normal
    // coin-frame data; `altTiles` is the used-block data that the ROM
    // DMAs in when BluePSwitchTimer is non-zero. CharFactory should wrap
    // char $054 in PSwitchAlternateBehavior over matching
    // AnimatedPixelsBehaviors.
    const fg1Sheet: Uint8Array[] = new Array(128)
    fg1Sheet[0x54] = new Uint8Array(64).fill(1) // some baseline pixels in VRAM
    const vram: VramState = { fg1: fg1Sheet }

    const normalFrame = (f: number): Uint8Array => new Uint8Array(64).fill(10 + f) // coin f
    const altFrame = (f: number): Uint8Array => new Uint8Array(64).fill(90 + f)    // used block variant

    const slotFor = (f: number): AnimFrameSlot => ({
      charBase: 0x054,
      tiles: [normalFrame(f), new Uint8Array(64), new Uint8Array(64), new Uint8Array(64)],
      altTiles: [altFrame(f), new Uint8Array(64), new Uint8Array(64), new Uint8Array(64)],
    })
    const animData: AnimationData = {
      frameCount: 4,
      intervalMs: 133,
      frames: [[slotFor(0)], [slotFor(1)], [slotFor(2)], [slotFor(3)]],
    }

    const chars = buildChars(vram, animData)
    const coin = chars.get(0x054)!
    expect(coin.behavior).toBeInstanceOf(PSwitchAlternateBehavior)

    const psa = coin.behavior as PSwitchAlternateBehavior
    expect(psa.normal).toBeInstanceOf(AnimatedPixelsBehavior)
    expect(psa.alt).toBeInstanceOf(AnimatedPixelsBehavior)

    // Pixels come from altTiles when switch is active, tiles when not.
    const ctxOff: RenderContext = { ...mockCtx(false) }
    const ctxOn: RenderContext = { ...mockCtx(true) }
    expect(coin.getPixels(ctxOff)[0]).toBe(10) // frame 0 of normal
    expect(coin.getPixels(ctxOn)[0]).toBe(90)  // frame 0 of alt
  })

  it('computed() tracks pSwitchActive + animFrame transitively', () => {
    const ctx = mockCtx(false, 0)
    const coin = new Uint8Array(64).fill(7)
    const used = new Uint8Array(64).fill(8)
    const behavior = new PSwitchAlternateBehavior(
      new AnimatedPixelsBehavior([coin, new Uint8Array(64).fill(70)]),
      new StaticPixelsBehavior(used),
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

describe.skipIf(!existsSync(ROM_PATH))('buildChars end-to-end (vanilla ROM)', () => {
  it('vanilla coin animation chars ($06C-$06F) wear PSwitchAlternateBehavior', async () => {
    const { SmwRom } = await import('../../../../src/rom/SmwRom')
    const { parseLevelHeader } = await import('../../../../src/rom/LevelParser')
    const { loadVram } = await import('../../../../src/rom/GfxLoader')
    const { loadAnimationData } = await import('../../../../src/rom/AnimationLoader')

    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const animData = loadAnimationData(rom.rom, header.objectTileset)!
    const chars = buildChars(vram, animData)

    // Slot 13 (behavior=1, selector=0 blue, VRAM $06C0) feeds chars
    // $06C-$06F with coin frames normally, used-block pixels when blue
    // P-switch is active.
    for (const charNum of [0x06C, 0x06D, 0x06E, 0x06F]) {
      const c = chars.get(charNum)
      expect(c, `char $${charNum.toString(16)}`).toBeInstanceOf(Char)
      expect(c!.behavior, `char $${charNum.toString(16)} behavior`).toBeInstanceOf(PSwitchAlternateBehavior)
    }
  })

  it('? Block animation chars ($060-$063) stay plain AnimatedPixels (no P-switch)', async () => {
    const { SmwRom } = await import('../../../../src/rom/SmwRom')
    const { parseLevelHeader } = await import('../../../../src/rom/LevelParser')
    const { loadVram } = await import('../../../../src/rom/GfxLoader')
    const { loadAnimationData } = await import('../../../../src/rom/AnimationLoader')

    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const animData = loadAnimationData(rom.rom, header.objectTileset)!
    const chars = buildChars(vram, animData)

    // Slot 0 is behavior=0 (always ? Block frames), so the ? Block
    // chars at VRAM $0600 ($060-$063) must be plain AnimatedPixels, not
    // PSwitchAlternate.
    for (const charNum of [0x060, 0x061, 0x062, 0x063]) {
      const c = chars.get(charNum)!
      expect(c.behavior, `char $${charNum.toString(16)}`).toBeInstanceOf(AnimatedPixelsBehavior)
      expect(c.behavior).not.toBeInstanceOf(PSwitchAlternateBehavior)
    }
  })
})
