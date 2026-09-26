/**
 * A slot's name comes from the overworld walk's own entrances, not a bias
 * formula alone: which translevel lands on which slot depends on the walk's
 * tile count, so a dropped or added tile moves it in a way the formula by
 * itself cannot predict.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { levelNameForSlot } from '../../../src/rom/SmwLevelNames'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { OW_ADDR } from '../../../src/rom/OverworldLoader'
import { plantStockSubmapCode, SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'

const BUF_SIZE = 0x80000

/** A stock-shaped overworld with `mainTiles` launch tiles in the main-map
 *  half and `subTiles` in the sub-map half, giving translevels 1..N in
 *  buffer order. */
function buildRom(mainTiles: number, subTiles: number): RomFile {
  const buf = Buffer.alloc(BUF_SIZE, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  plantStockSubmapCode(rom)
  for (let i = 0; i < mainTiles; i++) rom.writeAt(OW_ADDR.L1_TILEDATA + i, [0x6e])
  for (let i = 0; i < subTiles; i++) rom.writeAt(OW_ADDR.L1_TILEDATA + 0x400 + i, [0x6e])
  return rom
}

const ADDR_LEVEL_NAME_STRINGS = 0x049ac5
const ADDR_PREFIX_TABLE = 0x049c91
const ADDR_TYPE_TABLE = 0x049ccf
const ADDR_SUFFIX_TABLE = 0x049ced
const ADDR_LEVEL_NAMES = 0x04a0fc

const writeWord = (rom: RomFile, addr: number, value: number): void =>
  rom.writeAt(addr, [value & 0xff, (value >> 8) & 0xff])

/** Plants the name "AB" at `translevel`. */
function plantName(rom: RomFile, translevel: number): void {
  rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x00, [0x00, 0x81])
  rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x10, [0x9f, 0x80]) // type skip-marker
  rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x20, [0x9a]) // suffix, empty
  writeWord(rom, ADDR_PREFIX_TABLE + 0, 0x00)
  writeWord(rom, ADDR_TYPE_TABLE + 0, 0x10)
  writeWord(rom, ADDR_SUFFIX_TABLE + 0, 0x20)
  writeWord(rom, ADDR_LEVEL_NAMES + translevel * 2, 0x8000)
}

const entrancesOf = (rom: RomFile) =>
  deriveOverworldEntrances(new SmwRom(rom), undefined, SYNTHETIC_FINGERPRINTS)

describe('SmwRom.getLevelName: the walk decides, not the bias formula alone', () => {
  it('a dropped main tile: a slot the formula alone would name stays unreached', () => {
    // 35 main tiles (one short of stock) + 1 sub tile. Main translevels
    // 1-35 land unbiased on $001-$023; the sub tile's translevel (36, still
    // under the $25 threshold) lands unbiased on $124, not on $024.
    const rom = buildRom(35, 1)
    plantName(rom, 36)
    const smw = new SmwRom(rom)
    const idx = entrancesOf(rom)
    expect(smw.getLevelName(0x124, idx)).toBe('AB')
    expect(smw.getLevelName(0x024, idx)).toBeNull()
  })

  it('an added main tile: a slot the formula alone would name stays unreached', () => {
    // 37 main tiles (one more than stock) + 1 sub tile. The sub tile's
    // translevel is now 38, biased to $102, not the $101 a fixed 36/1 split
    // would assume. Translevel 37 is real too, but it lands on the main
    // half (layout 0, biased to $001): naming it is the trap a bias-only
    // reconstruction of $101 (low byte 1, "biased" to 37) falls into.
    const rom = buildRom(37, 1)
    plantName(rom, 38)
    plantName(rom, 37)
    const smw = new SmwRom(rom)
    const idx = entrancesOf(rom)
    expect(smw.getLevelName(0x102, idx)).toBe('AB')
    expect(smw.getLevelName(0x101, idx)).toBeNull()
  })

  it('refuses a slot reached by two translevels that decode to different names', () => {
    // 37 main tiles: translevel 37 is biased back to $001, colliding with
    // translevel 1's own unbiased $001.
    const rom = buildRom(37, 0)
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x00, [0x00, 0x81]) // "AB"
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x30, [0x02, 0x83]) // "CD"
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x10, [0x9f, 0x80])
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x20, [0x9a])
    writeWord(rom, ADDR_PREFIX_TABLE + 0, 0x00)
    writeWord(rom, ADDR_PREFIX_TABLE + 2, 0x30)
    writeWord(rom, ADDR_TYPE_TABLE + 0, 0x10)
    writeWord(rom, ADDR_SUFFIX_TABLE + 0, 0x20)
    writeWord(rom, ADDR_LEVEL_NAMES + 1 * 2, 0x8000) // translevel 1 -> "AB"
    writeWord(rom, ADDR_LEVEL_NAMES + 37 * 2, 0x8100) // translevel 37 -> "CD"
    const smw = new SmwRom(rom)
    expect(smw.getLevelName(0x001, entrancesOf(rom))).toBeNull()
  })

  it('refuses a slot reached by a named translevel and an empty one, rather than picking the name', () => {
    // Same $001 collision as above, but translevel 37's LevelNames entry is
    // left at $0000 (empty) instead of naming it something else.
    const rom = buildRom(37, 0)
    plantName(rom, 1) // translevel 1 -> "AB"; translevel 37 stays unplanted (empty)
    const smw = new SmwRom(rom)
    expect(smw.getLevelName(0x001, entrancesOf(rom))).toBeNull()
  })

  it('$139-$13B get no name even with the table filled, since the walk never reaches them', () => {
    const rom = buildRom(36, 28) // plantOverworldTiles' own 36/28 shape
    plantName(rom, 0x5d)
    plantName(rom, 0x5e)
    plantName(rom, 0x5f)
    const smw = new SmwRom(rom)
    const idx = entrancesOf(rom)
    expect(smw.getLevelName(0x139, idx)).toBeNull()
    expect(smw.getLevelName(0x13a, idx)).toBeNull()
    expect(smw.getLevelName(0x13b, idx)).toBeNull()
  })

  it('an unreadable overworld refuses, with a reason, on every slot', () => {
    const buf = Buffer.alloc(BUF_SIZE, 0)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('blank.sfc', buf)
    plantName(rom, 5)
    const smw = new SmwRom(rom)
    const idx = entrancesOf(rom)
    expect(idx.overworldReadable).toBe(false)
    expect(smw.getLevelName(0x005, idx)).toBeNull()
    const result = levelNameForSlot(rom, idx, 0x005)
    expect(result.name).toBeNull()
    expect(result.reason).toBe(idx.notes[0])
  })
})
