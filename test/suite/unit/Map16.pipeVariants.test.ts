import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import {
  MAP16_APP_TABLE,
  MAP16_TILE_BYTES,
  PIPE_VARIANT_TILE_START,
  PIPE_VARIANT_TILE_COUNT,
  applyPipePaletteVariant,
  buildMap16PointerTable,
  loadAllMap16,
  pipeVariantIndex,
} from '../../../src/rom/Map16'
import { SmwRom } from '../../../src/rom/SmwRom'

/**
 * Verifies the MAP16AppTable port reproduces the 4 palette-variant pointer
 * tables described in bank_05.asm lines 110-143 / 900-929.
 *
 * Each MAP16AppTable entry targets an 8-tile block in ROM whose Map16 data
 * bakes a specific palette row into tiles $133..$13A:
 *   variant 0 ($0D8AB0) -> palette 3 (grey gradient in FG pal 0)
 *   variant 1 ($0D84E0) -> palette 5 (StandardColors green)
 *   variant 2 ($0D8AF0) -> palette 6 (StandardColors yellow/brown)
 *   variant 3 ($0D8B30) -> palette 7 (StandardColors blue/purple)
 */

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

describe('Map16 pipe palette variants', () => {
  it('MAP16_APP_TABLE matches the 4 ROM pointers in bank_05.asm:884', () => {
    expect(MAP16_APP_TABLE).toEqual([0x0D8AB0, 0x0D84E0, 0x0D8AF0, 0x0D8B30])
  })

  it('pipeVariantIndex replicates (scroll >> 3) & 6 then >> 1', () => {
    // bank_05.asm:119-124 / 910-915: `LSR A LSR A LSR A / AND #$0006 / TAX`
    // produces a byte offset of 0/2/4/6 into MAP16AppTable. We divide by 2
    // to return the variant index (0-3).
    //
    // Variant changes every 16 units of the scroll counter — which matches
    // the observed "1 color per screen" cycle for horizontal levels (where
    // scroll increments by 1 per column, so 16 columns = 1 screen = 1
    // variant step).
    expect(pipeVariantIndex(0)).toBe(0)
    expect(pipeVariantIndex(15)).toBe(0)
    expect(pipeVariantIndex(16)).toBe(1)
    expect(pipeVariantIndex(31)).toBe(1)
    expect(pipeVariantIndex(32)).toBe(2)
    expect(pipeVariantIndex(47)).toBe(2)
    expect(pipeVariantIndex(48)).toBe(3)
    expect(pipeVariantIndex(63)).toBe(3)
    expect(pipeVariantIndex(64)).toBe(0)  // cycle repeats every 64 units (4 screens)
    expect(pipeVariantIndex(80)).toBe(1)
  })

  it('applyPipePaletteVariant redirects tiles $133..$13A to the variant block', () => {
    const pointers: number[] = new Array(512).fill(0)
    applyPipePaletteVariant(pointers, 0)
    for (let i = 0; i < PIPE_VARIANT_TILE_COUNT; i++) {
      expect(pointers[PIPE_VARIANT_TILE_START + i]).toBe(
        MAP16_APP_TABLE[0] + i * MAP16_TILE_BYTES,
      )
    }
    applyPipePaletteVariant(pointers, 3)
    expect(pointers[0x133]).toBe(MAP16_APP_TABLE[3])
    expect(pointers[0x13A]).toBe(MAP16_APP_TABLE[3] + 7 * MAP16_TILE_BYTES)
  })

  it('applyPipePaletteVariant does not touch pointers outside $133..$13A', () => {
    const before = new Array(512).fill(0).map((_, i) => 0x0D0000 | (i * 8))
    const after = [...before]
    applyPipePaletteVariant(after, 2)
    for (let i = 0; i < 512; i++) {
      if (i < PIPE_VARIANT_TILE_START || i >= PIPE_VARIANT_TILE_START + PIPE_VARIANT_TILE_COUNT) {
        expect(after[i]).toBe(before[i])
      }
    }
  })

  it.runIf(existsSync(ROM_PATH))(
    'loadAllMap16 with variant 0 returns tile $133 with palette 3 subtiles',
    () => {
      const rom = SmwRom.open(ROM_PATH)
      const tiles = loadAllMap16(rom.rom, /* tileset */ 0, /* variant */ 0)
      const t = tiles[0x133]
      expect(t.tl.palette).toBe(3)
      expect(t.bl.palette).toBe(3)
      expect(t.tr.palette).toBe(3)
      expect(t.br.palette).toBe(3)
    },
  )

  it.runIf(existsSync(ROM_PATH))(
    'loadAllMap16 with variant 1 returns tile $133 with palette 5 subtiles (default-green)',
    () => {
      const rom = SmwRom.open(ROM_PATH)
      const tiles = loadAllMap16(rom.rom, 0, 1)
      const t = tiles[0x133]
      expect(t.tl.palette).toBe(5)
      expect(t.br.palette).toBe(5)
    },
  )

  it.runIf(existsSync(ROM_PATH))(
    'loadAllMap16 with variant 2 returns tile $133 with palette 6 subtiles',
    () => {
      const rom = SmwRom.open(ROM_PATH)
      const tiles = loadAllMap16(rom.rom, 0, 2)
      expect(tiles[0x133].tl.palette).toBe(6)
    },
  )

  it.runIf(existsSync(ROM_PATH))(
    'loadAllMap16 with variant 3 returns tile $133 with palette 7 subtiles',
    () => {
      const rom = SmwRom.open(ROM_PATH)
      const tiles = loadAllMap16(rom.rom, 0, 3)
      expect(tiles[0x133].tl.palette).toBe(7)
    },
  )

  it.runIf(existsSync(ROM_PATH))(
    'non-pipe tiles (e.g. $133 neighbors outside $133..$13A) are unchanged across variants',
    () => {
      const rom = SmwRom.open(ROM_PATH)
      const baseline = buildMap16PointerTable(rom.rom, 0)
      const v0 = loadAllMap16(rom.rom, 0, 0)
      const v3 = loadAllMap16(rom.rom, 0, 3)
      // $132 is just before the variant range; its pointer must match the baseline.
      expect(baseline[0x132]).toBeDefined()
      // Both variants should produce the same tile $132 since it's outside the override.
      expect(v0[0x132]).toEqual(v3[0x132])
      // $13B is just after; also unchanged.
      expect(v0[0x13B]).toEqual(v3[0x13B])
    },
  )
})
