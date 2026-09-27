/**
 * OverworldL1: the reader gate, grid composition and rendering, on synthetic
 * bytes. No ROM: CI has none, so every refusal is proven here.
 *
 * The operands are planted at NON-vanilla targets (tile data in bank $0D,
 * char data in bank $0E, the tileset table at $04E000), so a reader that
 * hardcodes OWL1TileData or OWL1CharData reads zeroes and fails.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  OW_L1_COLS,
  OW_L1_READER_PINS,
  OW_L1_ROWS,
  composeOverworldL1Grid,
  readOverworldL1,
  renderOverworldL1,
} from '../../../src/rom/OverworldL1'
import { map16ByteOffset } from '../../../src/rom/OverworldLoader'
import { VRAM_CHAR_BASE, type VramState } from '../../../src/rom/GfxLoader'
import type { RgbaColor } from '../../../src/rom/GraphicsDecoder'
import { WorkingRom } from '../../../src/project/WorkingRom'
import { FULL_WORD_MASK } from '../../../src/rom/PaletteOp'
import { flip } from '../support/syntheticRom'
import { CORPUS, VANILLA, freshRom, hasRom, hasRoms } from '../support/corpus'

const TILE_DATA = 0x0d9000
const CHAR_DATA = 0x0e8000
const TILESET_TABLE = 0x04e000
const BANK_SELECTS = [0x058a3c, 0x058b18]

/** Pins, operands, two bank selects and data, all at synthetic targets. */
function plantedRom(): RomFile {
  const buf = Buffer.alloc(0x80000, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  for (const pin of OW_L1_READER_PINS) rom.writeAt(pin.addr, [...pin.bytes])
  rom.writeAt(0x04dc16, [TILESET_TABLE & 0xff, (TILESET_TABLE >> 8) & 0xff, TILESET_TABLE >> 16])
  rom.writeAt(0x04dc1d, [0x13])
  rom.writeAt(0x04dc3b, [CHAR_DATA & 0xff, (CHAR_DATA >> 8) & 0xff])
  rom.writeAt(0x04dc5b, [TILE_DATA & 0xff, (TILE_DATA >> 8) & 0xff])
  rom.writeAt(0x04dc62, [TILE_DATA >> 16])
  rom.writeAt(TILESET_TABLE, [0x12])
  for (const at of BANK_SELECTS) plantBankSelect(rom, at, 0x0d, 0x10, CHAR_DATA >> 16)
  // Tile index = row + col, wrapping, so every cell is distinguishable.
  for (let row = 0; row < 32; row++)
    for (let col = 0; col < 64; col++)
      rom.writeAt(TILE_DATA + map16ByteOffset((col >> 5) as 0 | 1, row, col & 31), [
        (row * 7 + col) & 0xff,
      ])
  for (let i = 0; i < 256; i++) {
    // TL, BL, TR, BR words: char i + quadrant, palette row (i & 7).
    const words = [0, 1, 2, 3].map(q => ((i * 4 + q) & 0x3ff) | ((i & 7) << 10))
    rom.writeAt(
      CHAR_DATA + i * 8,
      words.flatMap(w => [w & 0xff, w >> 8]),
    )
  }
  return rom
}

function plantBankSelect(rom: RomFile, at: number, lo: number, thr: number, hi: number): void {
  rom.writeAt(at, [0xa0, lo, 0xad, 0x31, 0x19, 0xc9, thr, 0x30, 0x02, 0xa0, hi, 0x84, 0x0c])
}

const read = (rom: RomFile) => {
  const r = readOverworldL1(rom)
  if (!r.ok) throw new Error(r.reason)
  return r
}

describe('readOverworldL1 on a synthetic ROM', () => {
  it('reads every address from the operands, not from vanilla constants', () => {
    const r = read(plantedRom())
    expect(r.objectTileset).toBe(0x12)
    expect(r.spriteTileset).toBe(0x13)
    expect(r.tileData[map16ByteOffset(1, 3, 5)]).toBe((3 * 7 + 37) & 0xff)
    expect(r.charData.length).toBe(256 * 8)
    expect(r.charData[8 * 9 + 2]).toBe((9 * 4 + 1) & 0xff)
  })

  it('refuses when any pinned byte changes: every byte, flipped one at a time', () => {
    const pinned = OW_L1_READER_PINS.flatMap(p => p.bytes.map((_, i) => p.addr + i))
    expect(pinned.length).toBe(24)
    for (const addr of pinned) {
      const rom = plantedRom()
      flip(rom, addr)
      const r = readOverworldL1(rom)
      expect(r.ok, `flip at $${addr.toString(16)}`).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/not stock at \$/)
    }
  })

  it('picks the low bank when the tileset is below the CMP threshold', () => {
    const rom = plantedRom()
    for (const at of BANK_SELECTS) plantBankSelect(rom, at, CHAR_DATA >> 16, 0x20, 0x05)
    expect(read(rom).charData[8 * 9 + 2]).toBe((9 * 4 + 1) & 0xff)
  })

  it('refuses when the bank selects disagree, or are absent', () => {
    const rom = plantedRom()
    plantBankSelect(rom, BANK_SELECTS[1]!, 0x0d, 0x10, 0x05)
    expect(readOverworldL1(rom)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/disagree/),
    })
    const none = plantedRom()
    for (const at of BANK_SELECTS) flip(none, at + 12)
    expect(readOverworldL1(none)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not present/),
    })
  })

  it('refuses a source in RAM or below $8000, which no static read can see', () => {
    const ram = plantedRom()
    ram.writeAt(0x04dc62, [0x7f])
    expect(readOverworldL1(ram)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/tile data/),
    })
    const low = plantedRom()
    low.writeAt(0x04dc3b, [0x00, 0x10])
    expect(readOverworldL1(low)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/char data/),
    })
    const table = plantedRom()
    table.writeAt(0x04dc16, [0x00, 0x00, 0x7e])
    expect(readOverworldL1(table).ok).toBe(false)
  })
})

describe('composeOverworldL1Grid', () => {
  it('lays the two buffer halves side by side as one 64x32 grid', () => {
    const r = read(plantedRom())
    const grid = composeOverworldL1Grid(r.tileData, r.charData)
    expect(grid.length).toBe(OW_L1_COLS * OW_L1_ROWS)
    for (const [row, col] of [
      [0, 0],
      [0, 31],
      [0, 32],
      [17, 40],
      [31, 63],
    ] as const) {
      const tile = grid[row * 64 + col]!
      const id = (row * 7 + col) & 0xff
      expect(tile.id).toBe(id)
      // decodeOwMap16's order: TL, BL, TR, BR words.
      expect([tile.tl, tile.bl, tile.tr, tile.br].map(s => s.charNum)).toEqual(
        [0, 1, 2, 3].map(q => (id * 4 + q) & 0x3ff),
      )
      expect(tile.tl.palette).toBe(id & 7)
    }
  })
})

/** fg1 (base 0) holding every BG char: char c is solid color 1 + (c % 15). */
function syntheticVram(): VramState {
  expect(VRAM_CHAR_BASE.fg1).toBe(0)
  return { fg1: Array.from({ length: 0x400 }, (_, c) => new Uint8Array(64).fill(1 + (c % 15))) }
}
/** Palette row r, color k paints (r, k, 0). */
const palette = {
  colors: Array.from({ length: 256 }, (_, i): RgbaColor => [i >> 4, i & 15, 0, 255]),
}

describe('renderOverworldL1', () => {
  it('paints each cell with its own quadrant chars at 1024x512', () => {
    const r = read(plantedRom())
    const rgba = renderOverworldL1(
      composeOverworldL1Grid(r.tileData, r.charData),
      syntheticVram(),
      palette,
    )
    expect(rgba.length).toBe(1024 * 512 * 4)
    // Cell (row 5, col 40), BR quadrant: pixel (40*16+12, 5*16+12).
    const id = (5 * 7 + 40) & 0xff
    const char = (id * 4 + 3) & 0x3ff
    const at = ((5 * 16 + 12) * 1024 + 40 * 16 + 12) * 4
    expect([rgba[at], rgba[at + 1], rgba[at + 3]]).toEqual([id & 7, 1 + (char % 15), 255])
  })

  it('an edit to the working copy tile data changes the drawn pixels', () => {
    const rom = plantedRom()
    const working = new WorkingRom(Uint8Array.from(rom.buffer), false)
    const draw = () => {
      const r = read(RomFile.fromBytes('w.sfc', Buffer.from(working.bytes())))
      return renderOverworldL1(
        composeOverworldL1Grid(r.tileData, r.charData),
        syntheticVram(),
        palette,
      )
    }
    const before = draw()
    const at = TILE_DATA + map16ByteOffset(0, 2, 3)
    const old = rom.readWord(at)!
    const hex = (w: number) => `$${w.toString(16).padStart(4, '0')}`
    working.append({
      id: 'l1',
      label: 'L1 tile',
      ops: [
        {
          address: `$${at.toString(16)}`,
          old: hex(old),
          new: hex(old ^ 0x0005),
          mask: FULL_WORD_MASK,
        },
      ],
    })
    const after = draw()
    const cell = ((2 * 16 + 1) * 1024 + 3 * 16 + 1) * 4
    expect(after.subarray(cell, cell + 4)).not.toEqual(before.subarray(cell, cell + 4))
    // Only that cell moved.
    const far = (20 * 16 * 1024 + 50 * 16) * 4
    expect(after.subarray(far, far + 4)).toEqual(before.subarray(far, far + 4))
  })
})

describe.skipIf(!hasRom(VANILLA))('readOverworldL1 on vanilla', () => {
  it('reads OWL1TileData and OWL1CharData where the disassembly puts them', () => {
    const rom = freshRom()
    const r = read(rom)
    expect(Array.from(r.tileData)).toEqual(Array.from(rom.readAt(0x0cf7df, 0x800)!))
    expect(Array.from(r.charData)).toEqual(Array.from(rom.readAt(0x05d000, 0x800)!))
    expect([r.objectTileset, r.spriteTileset]).toEqual([0x11, 0x11])
  })
})

describe.skipIf(!hasRoms(CORPUS))('readOverworldL1 across the corpus', () => {
  it('reads the unhooked ROMs and refuses the ones whose overworld load is diverted', () => {
    const verdicts = CORPUS.map(name => [name, readOverworldL1(freshRom(name)).ok] as const)
    // Measured: GPW2, Invictus and Seven Vanilla Levels no longer JSL CODE_04DC09.
    expect(verdicts.filter(([, ok]) => ok).length).toBe(3)
    expect(verdicts.find(([n]) => n === VANILLA)?.[1]).toBe(true)
  })
})
