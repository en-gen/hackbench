import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { loadVram } from '../../../../src/rom/GfxLoader'
import { Char } from '../../../../src/rom/model/chars/Char'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { Tile } from '../../../../src/rom/model/tiles/Tile'
import { buildTiles } from '../../../../src/rom/model/tiles/TileFactory'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

describe.skipIf(!existsSync(ROM_PATH))('CharFactory / TileFactory (vanilla ROM)', () => {
  it('buildChars wraps every loaded VRAM char as a Char with StaticPixelsBehavior', () => {
    const rom = SmwRom.open(ROM_PATH)
    const vram = loadVram(rom.rom, /* tilesetId */ 0, /* spriteSet */ 0)

    const chars = buildChars(vram)

    expect(chars.size).toBeGreaterThan(100)

    const sample = chars.values().next().value as Char
    expect(sample).toBeInstanceOf(Char)
    expect(sample.behavior).toBeInstanceOf(StaticPixelsBehavior)
    expect(sample.getPixels()).toHaveLength(64)
  })

  it('buildTiles wraps every Map16 entry as a Tile with StaticQuadBehavior', () => {
    const rom = SmwRom.open(ROM_PATH)
    const vram = loadVram(rom.rom, 0, 0)
    const chars = buildChars(vram)

    const tiles = buildTiles(rom.rom, 0, chars)

    // Vanilla Map16 table is 512 entries (MAP16_TOTAL_TILES).
    expect(tiles.size).toBe(512)

    const tile = tiles.get(0x100)
    expect(tile).toBeInstanceOf(Tile)
    expect(tile!.behavior).toBeInstanceOf(StaticQuadBehavior)
  })

  it('tile subtiles reference real chars from the graph', () => {
    const rom = SmwRom.open(ROM_PATH)
    const vram = loadVram(rom.rom, 0, 0)
    const chars = buildChars(vram)
    const tiles = buildTiles(rom.rom, 0, chars)

    // Tile $100 is a standard ground tile in SMW; verify its TL subtile
    // references a char that exists in the char graph.
    const tile = tiles.get(0x100)!
    const quad = (tile.behavior as StaticQuadBehavior).quad
    const tl = quad[0]
    // The TL subtile's char came from the chars map (or placeholder id=-1).
    // A real ground tile should hit a real char.
    expect(tl.char.id).not.toBe(-1)
    expect(chars.has(tl.char.id)).toBe(true)
  })
})
