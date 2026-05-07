/**
 * PaletteLoader — synthetic-ROM tests for the loaders, CGRAM assembly, and
 * Lunar Magic custom-palette path. The ROM-dependent integration test is
 * skipped without a real ROM; this file pins down the boundary behavior.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  loadRomPalettes,
  buildLevelCgram,
  loadBackAreaColors,
  loadLevelPalette,
  loadCustomLevelPalette,
  getPaletteColor,
  ADDR_BACK_AREA,
  ADDR_BG_PAIR,
  ADDR_CUSTOM_PALETTE_TABLE,
  CUSTOM_PALETTE_LEVEL_COUNT,
} from '../../../src/rom/PaletteLoader'

function make4MbRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7FD5] = 0x20
  return new RomFile('mock.smc', buf)
}

function makeTinyRom(): RomFile {
  return new RomFile('tiny.smc', Buffer.alloc(0x100))
}

const writeWord = (rom: RomFile, addr: number, value: number): void => {
  rom.writeAt(addr, [value & 0xFF, (value >> 8) & 0xFF])
}

// ── loadRomPalettes ──────────────────────────────────────────────────────────

describe('loadRomPalettes', () => {
  it('returns 5 palette groups in canonical order', () => {
    const rom = make4MbRom()
    const pal = loadRomPalettes(rom)
    expect(pal.groups.map(g => g.id)).toEqual(
      ['bg', 'fg', 'sprite_sets', 'player', 'sp_ef'],
    )
  })

  it('each pair group exposes 8 variants (one per BG/FG/sprite palette index)', () => {
    const rom = make4MbRom()
    const pal = loadRomPalettes(rom)
    expect(pal.groups.find(g => g.id === 'bg')!.variants.length).toBe(8)
    expect(pal.groups.find(g => g.id === 'fg')!.variants.length).toBe(8)
    expect(pal.groups.find(g => g.id === 'sp_ef')!.variants.length).toBe(8)
  })

  it('player group exposes 4 variants (Mario/Luigi/FireMario/FireLuigi)', () => {
    const rom = make4MbRom()
    const pal = loadRomPalettes(rom)
    const labels = pal.groups.find(g => g.id === 'player')!.variants.map(v => v.label)
    expect(labels).toEqual(['Mario', 'Luigi', 'Fire Mario', 'Fire Luigi'])
  })

  it('returns black backAreaColor when address read fails (tiny ROM)', () => {
    const rom = makeTinyRom()
    const pal = loadRomPalettes(rom)
    expect(pal.backAreaColor).toEqual([0, 0, 0, 255])
  })

  it('decodes the BackArea color from the BGR555 word at $00B0A0', () => {
    const rom = make4MbRom()
    // BGR555 $03E0 = pure green (R=0, G=31, B=0). Bit-replication (31<<3)|(31>>2) = 255.
    writeWord(rom, ADDR_BACK_AREA, 0x03E0)
    const pal = loadRomPalettes(rom)
    expect(pal.backAreaColor).toEqual([0, 255, 0, 255])
  })

  it('uses VARIANT_OFFSETS[v] when reading BG/FG/sprite pair tables', () => {
    const rom = make4MbRom()
    // Plant a unique color into BG variant 4's first row col 2.
    // VARIANT_OFFSETS[4] = $60. Each variant covers 24 bytes (12 colors).
    writeWord(rom, ADDR_BG_PAIR + 0x60, 0x7FFF)  // pure white
    const pal = loadRomPalettes(rom)
    const bg = pal.groups.find(g => g.id === 'bg')!
    expect(bg.variants[4].rows[0][2]).toEqual([255, 255, 255, 255])
  })
})

// ── loadBackAreaColors ───────────────────────────────────────────────────────

describe('loadBackAreaColors', () => {
  it('returns 8 colors', () => {
    expect(loadBackAreaColors(make4MbRom()).length).toBe(8)
  })

  it('returns black for entries with unreadable addresses (tiny ROM)', () => {
    const colors = loadBackAreaColors(makeTinyRom())
    expect(colors.every(c => c[3] === 255 && c[0] === 0 && c[1] === 0 && c[2] === 0)).toBe(true)
  })
})

// ── buildLevelCgram boundary handling ────────────────────────────────────────

describe('buildLevelCgram', () => {
  it('returns 256 colors and 16 rows from a clean ROM', () => {
    const rom = make4MbRom()
    const pal = loadRomPalettes(rom)
    const cgram = buildLevelCgram(pal, 0, 0, 0, 0)
    expect(cgram.colors.length).toBe(256)
    expect(cgram.rows.length).toBe(16)
  })

  it('clamps oversize bgVariant/fgVariant to the last available variant', () => {
    const rom = make4MbRom()
    const pal = loadRomPalettes(rom)
    // bgVariant=99 → clamped to 7; doesn't crash
    const cgram = buildLevelCgram(pal, 99, 99, 99, 99)
    expect(cgram.bgVariantIndex).toBe(99)  // raw param echoed
    expect(cgram.colors.length).toBe(256)
  })

  it('col 0 of every row is transparent', () => {
    const rom = make4MbRom()
    const pal = loadRomPalettes(rom)
    const cgram = buildLevelCgram(pal, 0, 0, 0, 0)
    for (let r = 0; r < 16; r++) expect(cgram.colors[r * 16][3]).toBe(0)
  })

  it('col 1 of rows 0-7 is BG sentinel $7FDD; rows 8-15 is OBJ sentinel $7FFF', () => {
    const rom = make4MbRom()
    const pal = loadRomPalettes(rom)
    const cgram = buildLevelCgram(pal, 0, 0, 0, 0)
    // BGR555 $7FDD: R=29, G=30, B=31 → bit-replicated: 239, 247, 255
    expect(cgram.colors[0 * 16 + 1]).toEqual([239, 247, 255, 255])
    expect(cgram.colors[7 * 16 + 1]).toEqual([239, 247, 255, 255])
    expect(cgram.colors[8 * 16 + 1]).toEqual([255, 255, 255, 255])
    expect(cgram.colors[15 * 16 + 1]).toEqual([255, 255, 255, 255])
  })
})

// ── getPaletteColor ──────────────────────────────────────────────────────────

describe('getPaletteColor', () => {
  it('returns the indexed color', () => {
    const rom = make4MbRom()
    const pal = loadRomPalettes(rom)
    const cgram = buildLevelCgram(pal, 0, 0, 0)
    expect(getPaletteColor(cgram, 0, 0)).toEqual(cgram.colors[0])
    expect(getPaletteColor(cgram, 5, 7)).toEqual(cgram.colors[5 * 16 + 7])
  })

  it('returns the magenta sentinel for out-of-range indices', () => {
    expect(getPaletteColor({ colors: [] }, 99, 99)).toEqual([255, 0, 255, 255])
  })
})

// ── loadLevelPalette ─────────────────────────────────────────────────────────

describe('loadLevelPalette', () => {
  it('produces colors and rows arrays of the expected sizes', () => {
    const rom = make4MbRom()
    const out = loadLevelPalette(rom)
    expect(out.colors.length).toBe(256)
    expect(out.rows.length).toBe(16)
  })
})

// ── loadCustomLevelPalette (Lunar Magic) ─────────────────────────────────────

describe('loadCustomLevelPalette', () => {
  it('returns null for negative or out-of-range indices', () => {
    const rom = make4MbRom()
    expect(loadCustomLevelPalette(rom, -1)).toBeNull()
    expect(loadCustomLevelPalette(rom, CUSTOM_PALETTE_LEVEL_COUNT)).toBeNull()
  })

  it('returns null when ROM cannot read the pointer entry', () => {
    const rom = makeTinyRom()
    expect(loadCustomLevelPalette(rom, 0)).toBeNull()
  })

  it('returns null when pointer is $000000 (uninstalled level)', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR_CUSTOM_PALETTE_TABLE + 0 * 3, [0x00, 0x00, 0x00])
    expect(loadCustomLevelPalette(rom, 0)).toBeNull()
  })

  it('returns null when pointer is $FFFFFF (sentinel)', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR_CUSTOM_PALETTE_TABLE + 0 * 3, [0xFF, 0xFF, 0xFF])
    expect(loadCustomLevelPalette(rom, 0)).toBeNull()
  })

  it('returns null when pointer block is unreadable (out of ROM)', () => {
    const rom = make4MbRom()
    // Pointer at $7E:1234 — WRAM, not ROM. loromToOffset returns null for bank $7E.
    rom.writeAt(ADDR_CUSTOM_PALETTE_TABLE + 0 * 3, [0x34, 0x12, 0x7E])
    expect(loadCustomLevelPalette(rom, 0)).toBeNull()
  })

  it('decodes the back-area + 16-row block at the pointer destination', () => {
    const rom = make4MbRom()
    // Stash the custom palette block at SNES $108000 (LoROM bank $10).
    const blockAddr = 0x108000
    rom.writeAt(ADDR_CUSTOM_PALETTE_TABLE + 0 * 3, [
      blockAddr & 0xFF, (blockAddr >> 8) & 0xFF, (blockAddr >> 16) & 0xFF,
    ])
    // Plant a recognizable back-area color and one foreground color.
    writeWord(rom, blockAddr, 0x7FFF)             // back area = white
    // BGR555: low 5 bits = R. $001F = pure red.
    writeWord(rom, blockAddr + 2 + (5 * 16 + 3) * 2, 0x001F)

    const pal = loadCustomLevelPalette(rom, 0)
    expect(pal).not.toBeNull()
    expect(pal!.backAreaColor).toEqual([255, 255, 255, 255])
    // Col 0 of every row is forced to transparent regardless of ROM data.
    for (let r = 0; r < 16; r++) expect(pal!.rows[r][0]).toEqual([0, 0, 0, 0])
    // Plant landed: row 5 col 3 has red component.
    expect(pal!.rows[5][3]).toEqual([255, 0, 0, 255])
    expect(pal!.colors.length).toBe(16 * 16)
  })

  it('returns null when block buffer cannot be read (pointer in WRAM bank)', () => {
    const rom = make4MbRom()
    // Pointer = $7E0000 (WRAM). loromToOffset returns null for bank $7E.
    rom.writeAt(ADDR_CUSTOM_PALETTE_TABLE + 0 * 3, [0x00, 0x00, 0x7E])
    expect(loadCustomLevelPalette(rom, 0)).toBeNull()
  })
})
