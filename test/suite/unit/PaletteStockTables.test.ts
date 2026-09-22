import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import {
  buildStockTables,
  countCustomPaletteLevels,
  AttributedGroup,
} from '../../../src/rom/PaletteStockTables'
import { loadRomPalettes, loadBackAreaColors } from '../../../src/rom/PaletteLoader'

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

// A real Lunar Magic hack, for the one positive case a vanilla-only corpus
// cannot give countCustomPaletteLevels: not part of the standard fixture
// set (gitignored either way), so this is skipped rather than required.
const HACK_ROM_PATH = resolve(__dirname, '../../roms/Invictus 1.0.sfc')
const hackRomPresent = existsSync(HACK_ROM_PATH)

// Loaded lazily inside each it(), matching GfxLoader.test.ts's convention, so
// describe.skipIf's block body never touches the filesystem at collection
// time. Cached because every test in this file reads the same cart.
let cached: { rom: RomFile; groups: AttributedGroup[] } | undefined
function load(): { rom: RomFile; groups: AttributedGroup[] } {
  if (!cached) {
    const rom = RomFile.load(ROM_PATH)
    cached = { rom, groups: buildStockTables(rom) }
  }
  return cached
}
const group = (id: string) => load().groups.find(g => g.id === id)!

describe.skipIf(!romPresent)('buildStockTables (vanilla cart)', () => {
  it("reads the review's three cited StatusBarColors mismatches correctly, not as black", () => {
    // bg variant 0, CGRAM row 0: col 8 = $7393, col 10 = $0CFB, col 15 = $2D7F.
    const row0 = group('bg').variants[0].rows[0]
    expect(row0[8]).toMatchObject({
      written: true,
      table: 'StatusBarColors',
      color: [156, 231, 231, 255],
    })
    expect(row0[10]).toMatchObject({
      written: true,
      table: 'StatusBarColors',
      color: [222, 57, 24, 255],
    })
    expect(row0[15]).toMatchObject({
      written: true,
      table: 'StatusBarColors',
      color: [255, 90, 90, 255],
    })
  })

  it('every StatusBarColors cell carries the address it actually read, cross-checked against the raw table', () => {
    const { rom, groups } = load()
    const bg = groups.find(g => g.id === 'bg')!
    const truth = loadRomPalettes(rom)
    for (let row = 0; row < 2; row++) {
      const attributedRow = bg.variants[0].rows[row]
      for (let col = 8; col < 16; col++) {
        const cell = attributedRow[col]
        expect(cell, `bg row ${row} col ${col}`).toMatchObject({
          written: true,
          table: 'StatusBarColors',
          color: truth.bgSecondaryCols[row][col],
        })
      }
    }
  })

  it("fg cols 9-15 read BerryColors, not the group's own (unwritten-there) row", () => {
    const { rom, groups } = load()
    const fg = groups.find(g => g.id === 'fg')!
    const truth = loadRomPalettes(rom)
    for (let row = 0; row < 2; row++) {
      const attributedRow = fg.variants[0].rows[row]
      for (let col = 9; col < 16; col++) {
        const cell = attributedRow[col]
        expect(cell, `fg row ${row} col ${col}`).toMatchObject({
          written: true,
          table: 'BerryColors',
          color: truth.berryCols[row][col],
        })
      }
    }
  })

  it('sprite_sets rows 0, 5, 6 and 7 read BerryColors; the other six rows leave cols 9-15 unwritten', () => {
    const { rom, groups } = load()
    const spriteSets = groups.find(g => g.id === 'sprite_sets')!
    const truth = loadRomPalettes(rom)
    const berryRows: Record<number, number> = { 0: 2, 5: 0, 6: 1, 7: 2 }
    for (let row = 0; row < 10; row++) {
      const attributedRow = spriteSets.variants[0].rows[row]
      if (row in berryRows) {
        const bi = berryRows[row]
        for (let col = 9; col < 16; col++) {
          expect(attributedRow[col], `sprite_sets row ${row} col ${col}`).toMatchObject({
            written: true,
            table: 'BerryColors',
            color: truth.berryCols[bi][col],
          })
        }
      } else {
        for (let col = 9; col < 16; col++) {
          expect(attributedRow[col], `sprite_sets row ${row} col ${col}`).toEqual({
            written: false,
            color: null,
            table: null,
            romAddr: null,
          })
        }
      }
    }
  })

  it('column 0 of CGRAM row 0 reads BackAreaColors for every bg variant, matching loadBackAreaColors', () => {
    const { rom, groups } = load()
    const bg = groups.find(g => g.id === 'bg')!
    // Independently loaded, not read back off buildStockTables' own output.
    const backAreaColors = loadBackAreaColors(rom)
    bg.variants.forEach((v, vi) => {
      expect(v.rows[0][0], `bg variant ${vi}`).toMatchObject({
        written: true,
        table: 'BackAreaColors',
        color: backAreaColors[vi],
      })
      expect(v.backAreaColor).toEqual(backAreaColors[vi])
    })
  })

  it('column 0 of every OTHER row is unwritten, not a fabricated backdrop reading', () => {
    expect(group('bg').variants[0].rows[1][0]).toEqual({
      written: false,
      color: null,
      table: null,
      romAddr: null,
    })
    expect(group('fg').variants[0].rows[0][0]).toEqual({
      written: false,
      color: null,
      table: null,
      romAddr: null,
    })
  })

  it('column 1 reads the LoadCol8Pal opcode: $7FDD for CGRAM rows 0-7, $7FFF for rows 8-15', () => {
    // bgr555ToRgba(0x7FDD) = [239,247,255,255], bgr555ToRgba(0x7FFF) = [255,255,255,255]
    // (independently verified: r5=(v)&0x1F, g5=(v>>5)&0x1F, b5=(v>>10)&0x1F, each c5<<3|c5>>2).
    const bg = group('bg')
    expect(bg.variants[0].rows[0][1]).toMatchObject({
      written: true,
      table: 'LoadPalette (LoadCol8Pal)',
      color: [239, 247, 255, 255],
    })
    expect(bg.variants[0].rows[1][1]).toMatchObject({
      written: true,
      table: 'LoadPalette (LoadCol8Pal)',
      color: [239, 247, 255, 255],
    })
    // sp_ef rows 14-15 (CGRAM 14-15): $7FFF.
    expect(group('sp_ef').variants[0].rows[0][1]).toMatchObject({
      written: true,
      table: 'LoadPalette (LoadCol8Pal)',
      color: [255, 255, 255, 255],
    })
    // sprite_sets crosses the boundary: CGRAM rows 4-7 use $7FDD, rows 8-13 use $7FFF.
    expect(group('sprite_sets').variants[0].rows[0][1]).toMatchObject({
      color: [239, 247, 255, 255],
    }) // CGRAM row 4
    expect(group('sprite_sets').variants[0].rows[4][1]).toMatchObject({
      color: [255, 255, 255, 255],
    }) // CGRAM row 8
  })

  it('every written cell carries a non-null romAddr, and every unwritten cell carries neither colour nor address', () => {
    for (const g of load().groups) {
      for (const v of g.variants) {
        for (const row of v.rows) {
          for (const cell of row) {
            if (cell.written) {
              expect(cell.color).not.toBeNull()
              expect(cell.table).not.toBeNull()
            } else {
              expect(cell.color).toBeNull()
              expect(cell.table).toBeNull()
              expect(cell.romAddr).toBeNull()
            }
          }
        }
      }
    }
  })
})

describe.skipIf(!romPresent)('countCustomPaletteLevels', () => {
  it('is zero on vanilla: no Lunar Magic custom palette table to find', () => {
    expect(countCustomPaletteLevels(load().rom)).toBe(0)
  })
})

describe.skipIf(!hackRomPresent)('countCustomPaletteLevels (real hack cart)', () => {
  it('is nonzero on a cart that actually uses per-level custom palettes', () => {
    const rom = RomFile.load(HACK_ROM_PATH)
    expect(countCustomPaletteLevels(rom)).toBeGreaterThan(0)
  })
})

describe('col1 opcode gate', () => {
  it('fails closed (reports unwritten) when the opcode at the cited address is not LDA #imm', () => {
    // A minimal synthetic ROM with $22 (JSL) planted at the LDA #$7FDD site,
    // matching how CLAUDE.md describes a hijacked routine: same address,
    // different opcode. Does not need a real cart, so it always runs.
    const buf = Buffer.alloc(0x200000, 0)
    buf[0x7fd5] = 0x20 // LoROM header byte
    buf[0x00abef] = 0x22 // planted: JSL instead of LDA #imm
    const rom = new RomFile('synthetic', buf)
    const bg = buildStockTables(rom).find(g => g.id === 'bg')!
    expect(bg.variants[0].rows[0][1]).toEqual({
      written: false,
      color: null,
      table: null,
      romAddr: null,
    })
  })
})
