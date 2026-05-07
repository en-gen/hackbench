/**
 * MapBuilder end-to-end integration — exercises the full build pipeline
 * (CharFactory → TileFactory → SpriteFactory → L2Factory → L3Factory →
 * palette → scroll-setup → SmwMap). Catches real bugs anywhere in that
 * chain that the ROM-shape-specific synthetic unit tests miss.
 *
 * Not an exhaustive enumeration — picks a small set of representative
 * levels (vanilla starter, water level, vertical castle, sub-area).
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  buildMapWithGraph,
  buildMap,
  buildMapPayload,
} from '../../../src/rom/model/MapBuilder'

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

describe.skipIf(!romPresent)('MapBuilder — vanilla ROM end-to-end', () => {
  it('builds Yoshi\'s House ($104) without throwing', () => {
    const rom = SmwRom.open(ROM_PATH)
    const built = buildMapWithGraph(rom, 0x104)
    expect(built.map).toBeTruthy()
    expect(built.chars.size).toBeGreaterThan(0)
    expect(built.tiles.size).toBeGreaterThan(0)
  })

  it('builds Donut Plains 1 ($105) and produces a level with sprites', () => {
    const rom = SmwRom.open(ROM_PATH)
    const built = buildMapWithGraph(rom, 0x105)
    expect(built.map.sprites.length).toBeGreaterThan(0)
  })

  it('builds Iggy\'s Castle ($0C7) — castle/auto-scroll context', () => {
    const rom = SmwRom.open(ROM_PATH)
    expect(() => buildMapWithGraph(rom, 0x0C7)).not.toThrow()
  })

  it('builds Vanilla Dome 1 ($009) — auto-scroll level with cmd $01', () => {
    const rom = SmwRom.open(ROM_PATH)
    const built = buildMapWithGraph(rom, 0x009)
    expect(built.map).toBeTruthy()
  })

  it('builds Yoshi\'s Island 4 ($102) — sublevel with secondary entrance', () => {
    const rom = SmwRom.open(ROM_PATH)
    expect(() => buildMapWithGraph(rom, 0x102)).not.toThrow()
  })

  it('honours per-level overrides without throwing', () => {
    const rom = SmwRom.open(ROM_PATH)
    expect(() => buildMapWithGraph(rom, 0x105, {
      bgPalette: 1,
      fgPalette: 2,
      bgColor: 3,
      spritePalette: 4,
      spriteSet: 5,
      objectTileset: 0,
      marioVariant: 1,
    })).not.toThrow()
  })

  it('buildMap returns just the SmwMap (no chars/tiles graph)', () => {
    const rom = SmwRom.open(ROM_PATH)
    const map = buildMap(rom, 0x105)
    expect(map).toBeTruthy()
  })

  it('buildMapPayload produces a JSON-serializable payload', () => {
    const rom = SmwRom.open(ROM_PATH)
    const payload = buildMapPayload(rom, 0x105)
    expect(payload).toBeTruthy()
    // Must round-trip through JSON without throwing.
    expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow()
  })
})
