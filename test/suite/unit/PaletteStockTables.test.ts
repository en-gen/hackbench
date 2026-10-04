import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  buildStockTables,
  countCustomPaletteLevels,
  readLevelCol1,
  AttributedGroup,
  ADDR_COL1_BG_LDA,
  ADDR_COL1_OBJ_LDA,
} from '../../../src/rom/PaletteStockTables'
import {
  loadRomPalettes,
  loadBackAreaColors,
  buildLevelCgram,
  ADDR_BACK_AREA,
} from '../../../src/rom/PaletteLoader'
import { bgr555ToRgba } from '../../../src/rom/GraphicsDecoder'
import { INVICTUS, VANILLA, hasRom, romPath } from '../support/corpus'
import { plantPaletteCol1ReachPath } from '../support/syntheticGfxCart'
import { rgbaToBgr555 } from '../../../theia/extension/src/browser/palette-color-format'
import { WorkingRom } from '../../../src/project/WorkingRom'
import { loromToOffset } from '../../../src/rom/addressing'

const ROM_PATH = romPath(VANILLA)
const romPresent = hasRom(VANILLA)

// A real Lunar Magic hack, for the one positive case a vanilla-only corpus
// cannot give countCustomPaletteLevels: not part of the standard fixture
// set (gitignored either way), so this is skipped rather than required.
const HACK_ROM_PATH = romPath(INVICTUS)
const hackRomPresent = hasRom(INVICTUS)

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

  /**
   * Back Area Colors: a standalone group, not a field riding along with each
   * bg variant. That pairing implied a link the cartridge does not have -
   * see PaletteStockTables.ts's own comment on `buildBackAreaGroup`.
   */
  it('back_area is its own group of 8, with no CGRAM row, matching loadBackAreaColors', () => {
    const { rom, groups } = load()
    const backArea = groups.find(g => g.id === 'back_area')!
    expect(backArea).toBeTruthy()
    expect(backArea.cgRamRow).toBeNull()

    const truth = loadBackAreaColors(rom)
    expect(backArea.variants.length).toBe(1)
    const cells = backArea.variants[0].rows[0]
    expect(cells.length).toBe(8)
    cells.forEach((cell, i) => {
      expect(cell, `back_area index ${i}`).toEqual({
        written: true,
        table: 'BackAreaColors',
        color: truth[i],
        romAddr: 0x00b0a0 + i * 2,
      })
    })
  })

  it('column 0 is unwritten, not a fabricated backdrop reading', () => {
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

  it('column 1 reads the LoadCol8Pal operand: $7FDD for CGRAM rows 0-7, $7FFF for rows 8-15', () => {
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
  // A raw `buf[0x00abef] =` write is a FILE offset, not the SNES address
  // col1Cell reads; rom.writeAt converts, so it cannot drift the same way.
  it('reads the ROM value (not a hardcoded fallback), then fails closed when the opcode is replaced', () => {
    const rom = new RomFile('synthetic', Buffer.alloc(0x200000, 0))
    rom.writeAt(0x00ffd5, [0x20]) // LoROM header byte (SNES $00:FFD5 -> file $7FD5)
    rom.writeAt(0x00abef, [0xa9, 0x34, 0x12]) // LDA #$1234: a non-stock immediate
    const before = buildStockTables(rom).find(g => g.id === 'bg')!.variants[0].rows[0][1]
    expect(before).toMatchObject({ written: true, color: bgr555ToRgba(0x1234) })

    rom.writeAt(0x00abef, [0x22, 0x34, 0x12]) // planted: JSL instead of LDA #imm
    const after = buildStockTables(rom).find(g => g.id === 'bg')!.variants[0].rows[0][1]
    expect(after).toEqual({ written: false, color: null, table: null, romAddr: null })
  })

  it('CGRAM row 7 reads the BG address, row 8 the OBJ address - the col1Cell boundary', () => {
    const rom = new RomFile('synthetic', Buffer.alloc(0x200000, 0))
    rom.writeAt(0x00ffd5, [0x20])
    rom.writeAt(0x00abef, [0xa9, 0x34, 0x12]) // BG: LDA #$1234
    rom.writeAt(0x00abfa, [0xa9, 0x78, 0x56]) // OBJ: LDA #$5678
    // sprite_sets covers CGRAM rows 4-13: rows[3] is row 7, rows[4] is row 8.
    const rows = buildStockTables(rom).find(g => g.id === 'sprite_sets')!.variants[0].rows
    expect(rows[3][1]).toMatchObject({ color: bgr555ToRgba(0x1234) })
    expect(rows[4][1]).toMatchObject({ color: bgr555ToRgba(0x5678) })
  })
})

describe('readLevelCol1', () => {
  function stockRom(): RomFile {
    const rom = new RomFile('synthetic', Buffer.alloc(0x200000, 0))
    rom.writeAt(0x00ffd5, [0x20])
    plantPaletteCol1ReachPath(rom)
    return rom
  }

  it('refuses when the level-load path no longer reaches LoadPalette', () => {
    const rom = stockRom()
    rom.writeAt(0x00a5bc, [0x4c, 0xed, 0xab]) // JMP, not JSR: a hijacked call site
    const result = readLevelCol1(rom)
    expect('reason' in result && result.reason).toMatch(/JSR LoadPalette/)
  })

  it('refuses when LoadPalette itself is bypassed (REP #$30 replaced)', () => {
    const rom = stockRom()
    rom.writeAt(0x00abed, [0x80, 0x18]) // BRA +$18: skips the BG write while $ABEF stays intact
    const result = readLevelCol1(rom)
    expect('reason' in result && result.reason).toMatch(/REP #\$30/)
  })

  it('refuses when a LoadCol8Pal dispatch is bypassed', () => {
    const rom = stockRom()
    rom.writeAt(0x00abf7, [0x80, 0x03, 0x00]) // BRA over the BG JSR
    const result = readLevelCol1(rom)
    expect('reason' in result && result.reason).toMatch(/LoadCol8Pal \(BG\)/)
  })

  it('refuses when the column-1 LDA #imm opcode is replaced', () => {
    const rom = stockRom()
    rom.writeAt(0x00abef, [0x22, 0xdd, 0x7f])
    const result = readLevelCol1(rom)
    expect('reason' in result && result.reason).toMatch(/opcode/)
  })

  it('reads a non-stock immediate: the value comes from ROM, not STOCK_COL1', () => {
    const rom = stockRom()
    rom.writeAt(0x00abef, [0xa9, 0x34, 0x12]) // recolored BG column 1, still LDA #imm
    const result = readLevelCol1(rom)
    if ('reason' in result) throw new Error(result.reason)
    expect(result.bg).toBe(0x1234)
    expect(result.obj).toBe(0x7fff) // OBJ untouched by this edit
  })
})

describe('group order', () => {
  it('lists player, sprites, layer 1, layer 2, then back area colors', () => {
    const buf = Buffer.alloc(0x200000, 0)
    buf[0x7fd5] = 0x20
    const groups = buildStockTables(new RomFile('synthetic', buf))
    expect(groups.map(g => g.id)).toEqual([
      'player',
      'sprite_sets',
      'sp_ef',
      'fg',
      'bg',
      'back_area',
    ])
    expect(groups.find(g => g.id === 'sp_ef')!.label).toBe('Level Sprite Colors')
  })
})

describe('back area colors stay out of the palette rows', () => {
  // CODE_00922F zeroes CGRAM $00 before every upload (SMWDisX bank_00.asm:2047-2048),
  // so no back area color ever lands in a palette row, not even row 0's.
  it('column 0 is unwritten in every row of every CGRAM group, even with nonzero BackAreaColors', () => {
    const buf = Buffer.alloc(0x200000, 0)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('synthetic', buf)
    for (let i = 0; i < 8; i++) rom.writeAt(ADDR_BACK_AREA + i * 2, [0x1f + i, 0x7c])
    const groups = buildStockTables(rom)
    expect(groups.find(g => g.id === 'back_area')!.variants[0].rows[0][0].written).toBe(true)
    for (const g of groups.filter(g => g.cgRamRow !== null)) {
      g.variants.forEach((v, vi) =>
        v.rows.forEach((row, ri) =>
          expect(row[0], `${g.id} variant ${vi} row ${ri}`).toEqual({
            written: false,
            color: null,
            table: null,
            romAddr: null,
          }),
        ),
      )
    }
  })
})

// #270: the Palettes view edits through AttributedCell.romAddr, so for column
// 1 that must be the LDA #imm OPERAND (opcode + 1), never the opcode.
// SMWDisX bank_00.asm:5597 / :5601.
describe('column 1 edit target (#270)', () => {
  const hex4 = (n: number): string => `$${n.toString(16).toUpperCase().padStart(4, '0')}`

  function synthRom(): RomFile {
    const rom = new RomFile('synthetic', Buffer.alloc(0x200000, 0))
    rom.writeAt(0x00ffd5, [0x20])
    plantPaletteCol1ReachPath(rom)
    return rom
  }
  const cellAt = (rom: RomFile, cgramRow: number) =>
    buildStockTables(rom).find(g => g.id === 'sprite_sets')!.variants[0].rows[cgramRow - 4][1]

  // Distinct operands per site, so a row routed to the wrong site changes the
  // color as well as the address. Covers every group's CGRAM rows 0-15
  // (bg 0, fg 2, sprite_sets 4-13, player 8, sp_ef 14) with no corpus.
  it('every group routes CGRAM rows 0-7 to the BG operand and 8-15 to the OBJ operand', () => {
    const rom = synthRom()
    rom.writeAt(ADDR_COL1_BG_LDA + 1, [0x11, 0x11])
    rom.writeAt(ADDR_COL1_OBJ_LDA + 1, [0x22, 0x22])
    const seen = new Set<number>()
    for (const g of buildStockTables(rom)) {
      if (g.cgRamRow === null) continue
      g.variants[0].rows.forEach((row, ri) => {
        const cgramRow = g.cgRamRow! + ri
        seen.add(cgramRow)
        const bg = cgramRow <= 7
        expect(row[1], `${g.id} row ${cgramRow}`).toMatchObject({
          romAddr: (bg ? ADDR_COL1_BG_LDA : ADDR_COL1_OBJ_LDA) + 1,
          color: bgr555ToRgba(bg ? 0x1111 : 0x2222),
        })
      })
    }
    expect([...seen].sort((x, y) => x - y)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ])
  })

  // Not the Theia setWord/RPC path (needs a project on disk): the same
  // old/new words that path forwards, applied through WorkingRom.append, then
  // read back through the Palettes cell and buildLevelCgram, which the gfx
  // and map16 decoders feed from readLevelCol1.
  it('an edit at romAddr lands in the operand, keeps the opcode, and reads back via cell, readLevelCol1 and buildLevelCgram', () => {
    const rom = synthRom()
    for (const [row, opcode] of [
      [7, ADDR_COL1_BG_LDA],
      [8, ADDR_COL1_OBJ_LDA],
    ] as const) {
      const cell = cellAt(rom, row)
      const [r, g, b] = cell.color as unknown as number[]
      const oldWord = rgbaToBgr555({ r, g, b, a: 255 })
      const working = new WorkingRom(new Uint8Array(rom.buffer), false)
      working.append({
        id: 'e',
        label: 'e',
        scope: 'edit',
        ops: [
          {
            address: `$${(cell.romAddr as number).toString(16)}`,
            old: hex4(oldWord),
            new: '$1234',
          },
        ],
      })
      const edited = new RomFile('synthetic', Buffer.from(working.bytes()))
      const o = loromToOffset(opcode, edited.buffer.length, false) as number
      expect(edited.buffer[o]).toBe(0xa9)
      expect(cellAt(edited, row)).toMatchObject({ written: true, color: bgr555ToRgba(0x1234) })
      const col1 = readLevelCol1(edited)
      expect(col1).toMatchObject(row <= 7 ? { bg: 0x1234 } : { obj: 0x1234 })
      if ('reason' in col1) throw new Error(col1.reason)
      const cgram = buildLevelCgram(loadRomPalettes(edited), 0, 0, 0, col1)
      expect(cgram.rows[row][1]).toEqual(bgr555ToRgba(0x1234))
    }
  })

  it('refuses (no target) for every non-LDA opcode byte at either site', () => {
    for (const site of [ADDR_COL1_BG_LDA, ADDR_COL1_OBJ_LDA]) {
      for (let op = 0; op < 256; op++) {
        if (op === 0xa9) continue
        const rom = synthRom()
        rom.writeAt(site, [op])
        const row = site === ADDR_COL1_BG_LDA ? 7 : 8
        expect(cellAt(rom, row).romAddr, `opcode ${op} at ${site}`).toBeNull()
      }
    }
  })
})
