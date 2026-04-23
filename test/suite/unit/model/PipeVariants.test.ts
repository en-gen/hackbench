import { describe, it, expect } from 'vitest'
import { ref } from '@vue/reactivity'
import { existsSync } from 'fs'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { loadVram } from '../../../../src/rom/GfxLoader'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { Tile, type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { buildTiles } from '../../../../src/rom/model/tiles/TileFactory'
import { PipeVariantsBehavior } from '../../../../src/rom/model/tiles/behaviors/PipeVariantsBehavior'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { cellBoxOf, type RenderContext } from '../../../../src/rom/model/RenderTarget'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

/** Build a ctx with a given per-screen pipe-variant table. The behavior
 *  now derives its own screen idx from the cell it's rendering onto,
 *  so tests exercise it by passing different cell positions rather
 *  than mutating a caller-side `pipeVariantIdx`. */
function mockCtx(
  screenPipeVariantIdx?: readonly number[],
  levelOrientation: 'horizontal' | 'vertical' = 'horizontal',
): RenderContext {
  return {
    animFrame: ref(0),
    palAnimFrame: ref(0),
    pSwitchActive: ref(false),
    switchPalaceState: ref<readonly [boolean, boolean, boolean, boolean]>([false, false, false, false]),
    palette: null as never,
    camera: ref({ tileX: 0, tileY: 0, focused: false }),
    zoom: ref(1),
    layerToggles: ref({ l1: true, l2: true, sprites: true, screens: true, block: true, mapGrid: false }),
    levelOrientation,
    screenPipeVariantIdx,
  }
}

function makeQuad(charId: number, palette: number): SubtileQuad {
  const sub = () =>
    new SubTile(
      new Char(charId, new StaticPixelsBehavior(new Uint8Array(64))),
      palette,
      false,
      false,
      false,
    )
  return [sub(), sub(), sub(), sub()]
}

describe('PipeVariantsBehavior behavior', () => {
  it('picks the variant for the cell\'s screen in a horizontal level', () => {
    const variants = [makeQuad(10, 3), makeQuad(11, 5), makeQuad(12, 6), makeQuad(13, 7)]
    const behavior = new PipeVariantsBehavior(variants)
    const table = [0, 1, 2, 3] // 4 screens
    const ctx = mockCtx(table, 'horizontal')

    // screen 0: cols 0..15, screen 1: cols 16..31, etc. — check any col per screen.
    expect(behavior.selectQuad(ctx, cellBoxOf(5,  0))[0].palette).toBe(3)
    expect(behavior.selectQuad(ctx, cellBoxOf(20, 0))[0].palette).toBe(5)
    expect(behavior.selectQuad(ctx, cellBoxOf(40, 0))[0].palette).toBe(6)
    expect(behavior.selectQuad(ctx, cellBoxOf(55, 0))[0].palette).toBe(7)
  })

  it('uses row-based screen index in a vertical level', () => {
    const variants = [makeQuad(10, 3), makeQuad(11, 5)]
    const behavior = new PipeVariantsBehavior(variants)
    const ctx = mockCtx([0, 1], 'vertical')
    // screen 0: rows 0..15, screen 1: rows 16..31.
    expect(behavior.selectQuad(ctx, cellBoxOf(0, 5 ))[0].palette).toBe(3)
    expect(behavior.selectQuad(ctx, cellBoxOf(0, 20))[0].palette).toBe(5)
  })

  it('falls back to variant 0 when the table is missing', () => {
    const variants = [makeQuad(10, 3), makeQuad(11, 5)]
    const behavior = new PipeVariantsBehavior(variants)
    expect(behavior.selectQuad(mockCtx(undefined), cellBoxOf(0, 0))[0].palette).toBe(3)
    expect(behavior.selectQuad(mockCtx([]),        cellBoxOf(0, 0))[0].palette).toBe(3)
  })
})

describe.skipIf(!existsSync(ROM_PATH))('TileFactory pipe wiring (vanilla ROM)', () => {
  it('$133-$13A tiles get PipeVariantsBehavior; other tiles stay StaticQuadBehavior', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const chars = buildChars(vram)

    const tiles = buildTiles(rom.rom, header.objectTileset, chars)

    for (let id = 0x133; id < 0x133 + 8; id++) {
      const tile = tiles.get(id)
      expect(tile, `tile $${id.toString(16)}`).toBeInstanceOf(Tile)
      expect(tile!.behavior, `tile $${id.toString(16)} behavior`).toBeInstanceOf(PipeVariantsBehavior)
      // 4 variants
      const variants = (tile!.behavior as PipeVariantsBehavior).variants
      expect(variants).toHaveLength(4)
    }

    // Random non-pipe tile is a StaticQuadBehavior
    const ground = tiles.get(0x100)!
    expect(ground.behavior).toBeInstanceOf(StaticQuadBehavior)
  })

  it('pipe tiles render different palettes per variant index', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const chars = buildChars(vram)
    const tiles = buildTiles(rom.rom, header.objectTileset, chars)
    const pipe = tiles.get(0x133)!

    const palAt = (v: number) => (pipe.behavior as PipeVariantsBehavior).variants[v][0].palette
    // The MAP16AppTable variants bake different palette rows: 3 / 5 / 6 / 7.
    expect(palAt(0)).toBe(3)
    expect(palAt(1)).toBe(5)
    expect(palAt(2)).toBe(6)
    expect(palAt(3)).toBe(7)
  })
})
