/**
 * SmwLevelNames - synthetic-ROM tests for the level-name decoder.
 *
 * The full decoder threads three lookup tables (prefix/type/suffix) of
 * variable-length packed substrings, each terminated by a high-bit-set byte.
 * These tests pin down the boundary cases (bit-7 skip rules, $9F = "no type"
 * sentinel, suffix-budget clipping, out-of-range translevel) which carry the
 * actual business logic. They skip the trivial-padding cases (every entry in
 * the tileToChar switch).
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { decodeLevelName, getAllLevelNames, levelNameForSlot } from '../../../src/rom/SmwLevelNames'
import type { OverworldEntrance, OverworldEntranceIndex } from '../../../src/rom/OverworldEntrances'

const ADDR_LEVEL_NAME_STRINGS = 0x049ac5
const ADDR_PREFIX_TABLE = 0x049c91
const ADDR_TYPE_TABLE = 0x049ccf
const ADDR_SUFFIX_TABLE = 0x049ced
const ADDR_LEVEL_NAMES = 0x04a0fc

function make4MbRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  return new RomFile('mock.smc', buf)
}

const writeWord = (rom: RomFile, addr: number, value: number): void => {
  rom.writeAt(addr, [value & 0xff, (value >> 8) & 0xff])
}

/** Encode a string as packed substring tile-index bytes; last byte gets bit 7 set. */
function packLetters(letters: string): number[] {
  const bytes = letters.split('').map(ch => {
    const code = ch.charCodeAt(0)
    if (ch >= 'A' && ch <= 'Z') return code - 0x41 // tile $00–$19
    if (ch === ' ') return 0x1f // tile $1F
    throw new Error(`unsupported letter: ${ch}`)
  })
  bytes[bytes.length - 1] |= 0x80
  return bytes
}

// ── decodeLevelName guards ───────────────────────────────────────────────────

describe('decodeLevelName - guard paths', () => {
  it('returns null for negative or 8-bit-out-of-range translevel', () => {
    const rom = make4MbRom()
    expect(decodeLevelName(rom, -1)).toBeNull()
    expect(decodeLevelName(rom, 256)).toBeNull()
  })

  it('decodes past the stock 96-entry table: the index is 8-bit with no further bound', () => {
    const rom = make4MbRom()
    writeWord(rom, ADDR_LEVEL_NAMES + 200 * 2, 0x0001)
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x00, packLetters('AB'))
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x10, [0x9f, 0x80])
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x20, [0x9a])
    writeWord(rom, ADDR_PREFIX_TABLE + 0, 0x00)
    writeWord(rom, ADDR_TYPE_TABLE + 0, 0x10)
    writeWord(rom, ADDR_SUFFIX_TABLE + 2, 0x20)
    expect(decodeLevelName(rom, 200)).toBe('AB')
  })

  it('returns null when the LevelNames entry is $0000 (empty)', () => {
    const rom = make4MbRom()
    writeWord(rom, ADDR_LEVEL_NAMES + 5 * 2, 0x0000)
    expect(decodeLevelName(rom, 5)).toBeNull()
  })

  it('returns null when the LevelNames entry is $FFFF (sentinel)', () => {
    const rom = make4MbRom()
    writeWord(rom, ADDR_LEVEL_NAMES + 5 * 2, 0xffff)
    expect(decodeLevelName(rom, 5)).toBeNull()
  })
})

// ── decodeLevelName happy paths ──────────────────────────────────────────────

describe('decodeLevelName - packed substring decode', () => {
  it('builds a name from prefix + type + suffix substrings', () => {
    const rom = make4MbRom()
    // Place packed strings at predictable offsets:
    //   prefixOffset  $00 → "ABC"
    //   typeOffset    $10 → "DEF"
    //   suffixOffset  $20 → "G"
    const prefixOff = 0x00,
      typeOff = 0x10,
      suffixOff = 0x20
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + prefixOff, packLetters('ABC'))
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + typeOff, packLetters('DEF'))
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + suffixOff, packLetters('G'))

    // Tables: each entry is a word offset into LevelNameStrings.
    // For translevel 0: byte0=0, byte1=0 → all three table indices are 0.
    writeWord(rom, ADDR_PREFIX_TABLE + 0, prefixOff)
    writeWord(rom, ADDR_TYPE_TABLE + 0, typeOff)
    writeWord(rom, ADDR_SUFFIX_TABLE + 0, suffixOff)
    writeWord(rom, ADDR_LEVEL_NAMES + 0, 0x0000) // would be skipped - use index 1
    // Use translevel 1: byte0 = $01 → suffix index = (1 & $0F) << 1 = 2,
    //                   type index = (1 & $F0) >> 3 = 0, prefix index = (0 & $7F)*2 = 0.
    writeWord(rom, ADDR_LEVEL_NAMES + 1 * 2, 0x0001)
    writeWord(rom, ADDR_SUFFIX_TABLE + 2, suffixOff)
    const name = decodeLevelName(rom, 1)
    expect(name).toBe('ABCDEFG') // prefix + type + suffix concatenation; no auto-spacing
  })

  it('skips the prefix substring when the first byte has bit 7 already set', () => {
    const rom = make4MbRom()
    const prefixOff = 0x00,
      typeOff = 0x10,
      suffixOff = 0x20
    // Prefix substring is a SINGLE byte with bit 7 set - counts as terminator-only.
    // The decoder branch checks `firstByte & 0x80`; if set, skips entirely.
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + prefixOff, [0x80]) // skip-marker
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + typeOff, packLetters('TYPE'))
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + suffixOff, packLetters('S'))

    writeWord(rom, ADDR_PREFIX_TABLE + 0, prefixOff)
    writeWord(rom, ADDR_TYPE_TABLE + 0, typeOff)
    writeWord(rom, ADDR_SUFFIX_TABLE + 2, suffixOff)
    writeWord(rom, ADDR_LEVEL_NAMES + 1 * 2, 0x0001)

    const name = decodeLevelName(rom, 1)
    expect(name).toBe('TYPES') // prefix skipped → just type + suffix
  })

  it('skips the type substring when its first raw byte is $9F (space sentinel)', () => {
    const rom = make4MbRom()
    const prefixOff = 0x00,
      typeOff = 0x10,
      suffixOff = 0x20
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + prefixOff, packLetters('PRE'))
    // Type starts with raw byte $9F - decoder skips it entirely.
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + typeOff, [0x9f, 0x80]) // $9F first, then EOS
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + suffixOff, packLetters('S'))

    writeWord(rom, ADDR_PREFIX_TABLE + 0, prefixOff)
    writeWord(rom, ADDR_TYPE_TABLE + 0, typeOff)
    writeWord(rom, ADDR_SUFFIX_TABLE + 2, suffixOff)
    writeWord(rom, ADDR_LEVEL_NAMES + 1 * 2, 0x0001)

    const name = decodeLevelName(rom, 1)
    expect(name).toBe('PRES') // type omitted → prefix + suffix
  })

  it('omits the suffix when adding it would overflow the 19-tile display budget', () => {
    const rom = make4MbRom()
    const prefixOff = 0x00,
      typeOff = 0x10,
      suffixOff = 0x60
    // Long prefix + type that already reaches 19 tiles.
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + prefixOff, packLetters('AAAAAAAAA ')) // 10 tiles
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + typeOff, packLetters('BBBBBBBBB')) // 9 tiles → 19 total
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + suffixOff, packLetters('XYZ'))

    writeWord(rom, ADDR_PREFIX_TABLE + 0, prefixOff)
    writeWord(rom, ADDR_TYPE_TABLE + 0, typeOff)
    writeWord(rom, ADDR_SUFFIX_TABLE + 2, suffixOff)
    writeWord(rom, ADDR_LEVEL_NAMES + 1 * 2, 0x0001)

    const name = decodeLevelName(rom, 1)
    // Prefix(10) + type(9) = 19 tiles already; suffix would overflow → dropped
    expect(name).toBe('AAAAAAAAA BBBBBBBBB')
    expect(name).not.toContain('X')
  })
})

// ── getAllLevelNames ─────────────────────────────────────────────────────────

describe('getAllLevelNames', () => {
  it('returns an empty Map when the LevelNames table is all zeros', () => {
    const rom = make4MbRom()
    expect(getAllLevelNames(rom).size).toBe(0)
  })

  it('omits entries that decode to null/empty', () => {
    const rom = make4MbRom()
    // Plant level $0000 → empty entry; level $0001 → valid name made of distinct
    // prefix/type/suffix substrings.
    writeWord(rom, ADDR_LEVEL_NAMES + 1 * 2, 0x0001)
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x00, packLetters('AB')) // prefix
    // Type substring: first byte $9F → type-skip sentinel.
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x10, [0x9f, 0x80]) // type skip-marker
    // Suffix: single byte with bit 7 set + tile index that maps to '' in
    // tileToChar (e.g. $1A is in the unmapped range).
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x20, [0x9a])
    writeWord(rom, ADDR_PREFIX_TABLE + 0, 0x00)
    writeWord(rom, ADDR_TYPE_TABLE + 0, 0x10)
    writeWord(rom, ADDR_SUFFIX_TABLE + 2, 0x20)
    const names = getAllLevelNames(rom)
    expect(names.has(1)).toBe(true)
    expect(names.has(0)).toBe(false)
  })
})

// ── levelNameForSlot: pure branching over a given entrance list ─────────────

describe('levelNameForSlot', () => {
  const entrance = (translevel: number, slot: number): OverworldEntrance => ({
    slot,
    translevel,
    bufferIndex: 0,
    tileDataAddress: 0,
    layout: 0,
    tileX: 0,
    tileY: 0,
    submap: 0,
    map16Tile: 0,
    action: 'map',
    isMap: true,
  })
  const readable = (entrances: OverworldEntrance[]): OverworldEntranceIndex => ({
    entrances,
    entryMaps: [],
    overworldReadable: true,
    notes: [],
    roots: null,
  })

  /** Plants a two-letter name at `translevel`, in its own prefix-table slot
   *  so two calls can name the same slot differently. Type/suffix are shared
   *  skip-markers, reused across calls on the same rom. */
  function plantName(rom: RomFile, translevel: number, tableSlot: number, letters: string): void {
    const off = 0x100 + tableSlot * 0x10
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + off, packLetters(letters))
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x10, [0x9f, 0x80])
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x20, [0x9a])
    writeWord(rom, ADDR_PREFIX_TABLE + tableSlot * 2, off)
    writeWord(rom, ADDR_TYPE_TABLE + 0, 0x10)
    writeWord(rom, ADDR_SUFFIX_TABLE + 0, 0x20)
    writeWord(rom, ADDR_LEVEL_NAMES + translevel * 2, (0x80 | tableSlot) << 8)
  }

  it('returns the one name that reaches the slot; no entrance gives null', () => {
    const rom = make4MbRom()
    plantName(rom, 1, 0, 'AB')
    const idx = readable([entrance(1, 0x001)])
    expect(levelNameForSlot(rom, idx, 0x001)).toEqual({ name: 'AB' })
    expect(levelNameForSlot(rom, idx, 0x002).name).toBeNull()
  })

  it('returns the shared name when several translevels reaching a slot agree', () => {
    const rom = make4MbRom()
    plantName(rom, 1, 0, 'AB')
    plantName(rom, 2, 0, 'AB')
    const idx = readable([entrance(1, 0x001), entrance(2, 0x001)])
    expect(levelNameForSlot(rom, idx, 0x001).name).toBe('AB')
  })

  it('refuses, naming the translevels, when they decode to different names', () => {
    const rom = make4MbRom()
    plantName(rom, 1, 0, 'AB')
    plantName(rom, 2, 1, 'CD')
    const idx = readable([entrance(1, 0x001), entrance(2, 0x001)])
    const result = levelNameForSlot(rom, idx, 0x001)
    expect(result.name).toBeNull()
    expect(result.reason).toContain('$1')
    expect(result.reason).toContain('$2')
  })
})
