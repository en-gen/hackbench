/**
 * OverworldL1's reader gate and grid on synthetic bytes. No ROM: CI has none,
 * so every refusal is proven here. See support/syntheticOverworld.ts.
 */
import { describe, it, expect } from 'vitest'
import { OW_L1_READER, composeOverworldL1Grid, readOverworldL1 } from '../../../src/rom/OverworldL1'
import { map16ByteOffset } from '../../../src/rom/OverworldLoader'
import { flip } from '../support/syntheticRom'
import {
  BANK_SELECTS,
  CHAR_DATA,
  plantBankSelect,
  syntheticOverworldRom,
  tileAt,
} from '../support/syntheticOverworld'
import { CORPUS, VANILLA, freshRom, hasRom, hasRoms } from '../support/corpus'
import type { RomFile } from '../../../src/rom/RomFile'

const read = (rom: RomFile) => {
  const r = readOverworldL1(rom)
  if (!r.ok) throw new Error(r.reason)
  return r
}
const refusal = (rom: RomFile) => {
  const r = readOverworldL1(rom)
  return r.ok ? 'drawn' : r.reason
}

describe('readOverworldL1 on a synthetic ROM', () => {
  it('reads every address from the operands, not from vanilla constants', () => {
    const r = read(syntheticOverworldRom())
    expect([r.objectTileset, r.spriteTileset]).toEqual([0x12, 0x13])
    expect(r.tileData[map16ByteOffset(1, 3, 5)]).toBe(tileAt(3, 37))
    expect(r.charData.length).toBe(256 * 8)
    expect(r.charData[8 * 9 + 2]).toBe((9 * 4 + 1) & 0x7f)
  })

  it('refuses when any pinned byte changes: every byte, flipped one at a time', () => {
    const pinned = OW_L1_READER.flatMap(p =>
      p.bytes.map((_, i) => ({ addr: p.addr + i, bank: i === p.bankAt })),
    )
    expect(pinned.length).toBe(38)
    for (const { addr, bank } of pinned) {
      const rom = syntheticOverworldRom()
      flip(rom, addr)
      // A bank byte ignores bit 7 (FastROM), so its flip keeps bit 7.
      if (bank) rom.writeAt(addr, [rom.readByte(addr)! ^ 0x80])
      expect(refusal(rom), `flip at $${addr.toString(16)}`).toMatch(/not stock: \$[0-9A-F]{6} \(/)
    }
  })

  it('accepts the FastROM mirror of the JSL CODE_04DC09 bank', () => {
    const rom = syntheticOverworldRom()
    rom.writeAt(0x00a129, [0x84])
    expect(readOverworldL1(rom).ok).toBe(true)
  })

  it('picks the low bank when the tileset is below the CMP threshold', () => {
    const rom = syntheticOverworldRom()
    for (const at of BANK_SELECTS) plantBankSelect(rom, at, CHAR_DATA >> 16, 0x20, 0x05)
    expect(read(rom).charData[8 * 9 + 2]).toBe((9 * 4 + 1) & 0x7f)
  })

  it('refuses when the bank selects disagree, or are absent', () => {
    const rom = syntheticOverworldRom()
    plantBankSelect(rom, BANK_SELECTS[1]!, 0x0d, 0x10, 0x05)
    expect(refusal(rom)).toMatch(/disagree/)
    const none = syntheticOverworldRom()
    for (const at of BANK_SELECTS) flip(none, at + 12)
    expect(refusal(none)).toMatch(/not present/)
  })

  it('refuses a source in RAM or below $8000, which no static read can see', () => {
    const ram = syntheticOverworldRom()
    ram.writeAt(0x04dc62, [0x7f])
    expect(refusal(ram)).toMatch(/tile data/)
    const low = syntheticOverworldRom()
    low.writeAt(0x04dc3b, [0x00, 0x10])
    expect(refusal(low)).toMatch(/char data/)
    const table = syntheticOverworldRom()
    table.writeAt(0x04dc16, [0x00, 0x00, 0x7e])
    expect(refusal(table)).toMatch(/tileset table/)
  })

  it('lays half 0 left of half 1, decoding each id through its char entry', () => {
    const r = read(syntheticOverworldRom())
    const grid = composeOverworldL1Grid(r.tileData, r.charData)
    expect(grid.length).toBe(64 * 32)
    const tile = grid[17 * 64 + 40]!
    expect(tile.id).toBe(tileAt(17, 40))
    // decodeOwMap16's order: TL, BL, TR, BR words.
    expect([tile.tl, tile.bl, tile.tr, tile.br].map(s => s.charNum)).toEqual(
      [0, 1, 2, 3].map(q => (tile.id * 4 + q) & 0x7f),
    )
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
  it('reads the unhooked readers and refuses the ones whose overworld load is diverted', () => {
    // Measured: GPW2, Invictus and Seven Vanilla Levels no longer JSL CODE_04DC09.
    const drawn = CORPUS.filter(name => readOverworldL1(freshRom(name)).ok)
    expect(drawn.length).toBe(3)
    expect(drawn).toContain(VANILLA)
  })
})
