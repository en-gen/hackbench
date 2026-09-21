import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'fs'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { loadAnimationData } from '../../../../src/rom/AnimationLoader'
import { loadVram } from '../../../../src/rom/GfxLoader'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { buildMap } from '../../../../src/rom/model/MapBuilder'
import { buildGraph } from '../../../../src/rom/model/rehydrate'
import { serialize } from '../../../../src/rom/model/serialize'
import { buildTiles } from '../../../../src/rom/model/tiles/TileFactory'
import { AnimatedPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/AnimatedPixelsBehavior'
import { PipeVariantsBehavior } from '../../../../src/rom/model/tiles/behaviors/PipeVariantsBehavior'
import { SwitchPalaceAlternateBehavior } from '../../../../src/rom/model/tiles/behaviors/SwitchPalaceAlternateBehavior'
import type { PixelPos, PixelSize, RenderTarget } from '../../../../src/rom/model/RenderTarget'
import { resetEditorStore } from '../fixtures/stores'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

class CollectingTarget implements RenderTarget {
  blits: { charId: number; posX: number; posY: number }[] = []
  private pixelsToId = new WeakMap<Uint8Array, number>()
  registerChar(id: number, pixels: Uint8Array) {
    this.pixelsToId.set(pixels, id)
  }
  blit8x8(pixels: Uint8Array, pos: PixelPos, _row: RgbaColor[], _fx: boolean, _fy: boolean): void {
    this.blits.push({ charId: this.pixelsToId.get(pixels) ?? -1, posX: pos.x, posY: pos.y })
  }
  fillRect(_p: PixelPos, _s: PixelSize, _c: RgbaColor): void {}
}

describe.skipIf(!existsSync(ROM_PATH))('MapPayload round-trip (vanilla ROM)', () => {
  beforeEach(resetEditorStore)

  it('serializes a built map and rehydrates a structurally-equivalent graph', () => {
    const rom = SmwRom.open(ROM_PATH)
    const original = buildMap(rom, 0x105)
    // Rebuild the char/tile tables to hand to serialize (buildMap doesn't expose them)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const animData = loadAnimationData(rom.rom, header.objectTileset) ?? undefined
    const chars = buildChars(vram, animData)
    const tiles = buildTiles(rom.rom, header.objectTileset, chars)

    const payload = serialize(original, chars, tiles)
    const { map: rehydrated } = buildGraph(payload)

    expect(rehydrated.id).toBe(original.id)
    expect(rehydrated.tileset).toBe(original.tileset)
    expect(rehydrated.screenCount).toBe(original.screenCount)
    expect(rehydrated.l1.length).toBe(original.l1.length)
    expect(rehydrated.l1[0].length).toBe(original.l1[0].length)

    // Behavior-kind preservation on known tile classes. The L1 grid
    // holds ids; resolve against the rehydrated l1Tiles lookup.
    const pipe = rehydrated.l1Tiles.get(0x133)!
    expect(pipe.behavior).toBeInstanceOf(PipeVariantsBehavior)

    // Ground-plane tiles still render; subtile chars resolve
    const ground = rehydrated.l1Tiles.get(0x100)
    if (ground) {
      const firstSub = (ground.behavior as any).quad[0]
      expect(firstSub.char).toBeDefined()
      expect(firstSub.char.getPixels).toBeDefined()
    }
  })

  it('rehydrated map renders identically to the original (blit count matches)', () => {
    const rom = SmwRom.open(ROM_PATH)
    const original = buildMap(rom, 0)
    const raw = rom.getLevelRawData(0)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const animData = loadAnimationData(rom.rom, header.objectTileset) ?? undefined
    const chars = buildChars(vram, animData)
    const tiles = buildTiles(rom.rom, header.objectTileset, chars)

    const payload = serialize(original, chars, tiles)
    const { map: rehydrated } = buildGraph(payload)

    const t1 = new CollectingTarget()
    const t2 = new CollectingTarget()
    original.render(t1)
    rehydrated.render(t2)

    expect(t2.blits.length).toBe(t1.blits.length)
    // Every blit should share the same (x, y) positions across both renders
    for (let i = 0; i < t1.blits.length; i++) {
      expect(t2.blits[i].posX).toBe(t1.blits[i].posX)
      expect(t2.blits[i].posY).toBe(t1.blits[i].posY)
    }
  })

  it('preserves AnimatedPixelsBehavior and SwitchPalaceAlternateBehavior through round-trip', () => {
    const rom = SmwRom.open(ROM_PATH)
    const map = buildMap(rom, 0x105)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const animData = loadAnimationData(rom.rom, header.objectTileset) ?? undefined
    const chars = buildChars(vram, animData)
    const tiles = buildTiles(rom.rom, header.objectTileset, chars)

    const payload = serialize(map, chars, tiles)
    const { chars: reChars, tiles: reTiles } = buildGraph(payload)

    // At least one char is AnimatedPixelsBehavior
    const hasAnimated = [...reChars.values()].some(
      c => c.behavior instanceof AnimatedPixelsBehavior,
    )
    expect(hasAnimated).toBe(true)

    // Switch-palace tiles preserved
    for (let c = 0; c < 4; c++) {
      expect(reTiles.get(0x06a + c)!.behavior).toBeInstanceOf(SwitchPalaceAlternateBehavior)
      expect(reTiles.get(0x16a + c)!.behavior).toBeInstanceOf(SwitchPalaceAlternateBehavior)
    }
  })
})
