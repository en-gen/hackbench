import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { readGfxFile } from '../../../src/rom/GfxLoader'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const ROM_PATH = romPath(VANILLA)
const romPresent = hasRom(VANILLA)

describe.skipIf(!romPresent)('SmwRom integration (requires the corpus vanilla ROM)', () => {
  let rom: SmwRom

  it('opens without throwing', () => {
    rom = SmwRom.open(ROM_PATH)
    expect(rom).toBeTruthy()
  })

  it('internal ROM name is SUPER MARIOWORLD', () => {
    rom ??= SmwRom.open(ROM_PATH)
    expect(rom.internalName).toMatch(/^SUPER MARIOWORLD/)
  })

  it('getSummary reports isVanilla=true', () => {
    rom ??= SmwRom.open(ROM_PATH)
    const summary = rom.getSummary()
    expect(summary.isVanilla).toBe(true)
    expect(summary.romSizeKb).toBeGreaterThan(0)
  })

  it('level $000 has a valid L1 pointer', () => {
    rom ??= SmwRom.open(ROM_PATH)
    const ptr = rom.getLevelL1Pointer(0x000)
    expect(ptr).not.toBeNull()
    expect(ptr).toBeGreaterThan(0)
  })

  it('level $000 raw data can be parsed', () => {
    rom ??= SmwRom.open(ROM_PATH)
    const data = rom.getLevelRawData(0x000)
    expect(data).not.toBeNull()
    const { objects, screens } = parseLevelObjects(data!)
    expect(screens).toBeGreaterThanOrEqual(1)
    expect(objects.length).toBeGreaterThan(0)
  })

  it('reports 512 level entries total', () => {
    rom ??= SmwRom.open(ROM_PATH)
    const pointers = rom.getAllLevelPointers()
    expect(pointers).toHaveLength(0x200)
  })

  it('GFX file 0 decompresses to non-empty bytes', () => {
    rom ??= SmwRom.open(ROM_PATH)
    const read = readGfxFile(rom.rom, 0)
    expect(read.ok && read.bytes.length).toBeGreaterThan(0)
  })
})
