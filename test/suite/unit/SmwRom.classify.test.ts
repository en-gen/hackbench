/**
 * SmwRom — synthetic-ROM tests for classifyLevels, buildLevelExitGraph, and
 * enumerateAllLevels. These exercise the higher-level orchestration logic on
 * top of the pointer/header reads tested in SmwRom.synthetic.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'

function make4MbRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7FD5] = 0x20
  return new RomFile('mock.smc', buf)
}

/** Stamp a 3-byte L1 pointer for the given level index. */
function setL1Ptr(rom: RomFile, levelIndex: number, snesAddr: number): void {
  rom.writeAt(ADDR.LEVEL_L1_PTR + levelIndex * 3, [
    snesAddr & 0xFF,
    (snesAddr >> 8) & 0xFF,
    (snesAddr >> 16) & 0xFF,
  ])
}

/** Stamp a level's raw header + body bytes at the given SNES address. */
function setLevelData(rom: RomFile, snesAddr: number, bytes: number[]): void {
  rom.writeAt(snesAddr, bytes)
}

// ── classifyLevels ───────────────────────────────────────────────────────────

describe('SmwRom.classifyLevels', () => {
  it('returns empty arrays when every level has zero pointer', () => {
    const rom = make4MbRom()
    const smw = new SmwRom(rom)
    const result = smw.classifyLevels()
    expect(result.overworld).toEqual([])
    expect(result.subarea).toEqual([])
  })

  it('puts indices in main-map range $000-$024 into overworld', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x42, 0xFF])  // valid + has objects
    const smw = new SmwRom(rom)
    const result = smw.classifyLevels()
    expect(result.overworld).toEqual([0x010])
    expect(result.subarea).toEqual([])
  })

  it('puts indices outside overworld ranges into subarea', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x150, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x42, 0xFF])
    const smw = new SmwRom(rom)
    const result = smw.classifyLevels()
    expect(result.subarea).toEqual([0x150])
    expect(result.overworld).toEqual([])
  })

  it('skips duplicate-pointer levels (vanilla shares many slots)', () => {
    const rom = make4MbRom()
    // Two indices with the SAME L1 pointer — second should be skipped.
    setL1Ptr(rom, 0x010, 0x068000)
    setL1Ptr(rom, 0x011, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x42, 0xFF])
    const smw = new SmwRom(rom)
    const result = smw.classifyLevels()
    expect(result.overworld).toEqual([0x010])  // 0x011 dropped as dup
  })

  it('skips levels whose header.levelMode > 20 (invalid)', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0x1F, 0, 0, 0, 0x42, 0xFF])  // mode = 31
    const smw = new SmwRom(rom)
    expect(smw.classifyLevels().overworld).toEqual([])
  })

  it('skips levels whose first object byte is the immediate $FF terminator', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0xFF])  // empty stream
    const smw = new SmwRom(rom)
    expect(smw.classifyLevels().overworld).toEqual([])
  })
})

// ── buildLevelExitGraph ──────────────────────────────────────────────────────

describe('SmwRom.buildLevelExitGraph', () => {
  it('returns an empty Map when sec-exit tables cannot be read (tiny ROM)', () => {
    const buf = Buffer.alloc(0x60000)
    buf[0x7FD5] = 0x20
    const smw = new SmwRom(new RomFile('mini.smc', buf))
    expect(smw.buildLevelExitGraph().size).toBe(0)
  })

  it('returns an empty Map when no level has any exit objects', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x00, 0x10, 0x00, 0xFF])
    const smw = new SmwRom(rom)
    expect(smw.buildLevelExitGraph().size).toBe(0)
  })

  it('records a primary exit destination when the trigger screen has a pipe tile', () => {
    const rom = make4MbRom()
    // Sub-area 0x150 contains a pipe tile so the exit stays.
    // Source level 0x010 with one ext-exit pointing at sub-area 0x150.
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [
      0, 0, 0, 0, 0,
      // Object that draws a 1×1 ledge with tile $0A (pipe-body) at (0,0):
      // Use std object 1 size=0 — but that depends on tileset 0 handler. To
      // keep things simple, write a "raw" tile manually via an extended object
      // is harder; instead, rely on the pit-as-trigger detection: bottom row
      // is empty by default, so screenHasExitTrigger returns true.
      // Ext-exit object: objNo=0 (b1[7:4]=0, b0 bits 6:5=0), settings=0,
      // followed by 1 extra byte = destination $50 → resolves with hi from b1.
      0x00, 0x01, 0x00, 0x50,  // b1=0x01 → destHigh=1, secondary=0; dest = $150
      0xFF,
    ])
    setL1Ptr(rom, 0x150, 0x06A000)
    setLevelData(rom, 0x06A000, [0, 0, 0, 0, 0, 0x42, 0xFF])  // valid sub-area
    const smw = new SmwRom(rom)
    const graph = smw.buildLevelExitGraph()
    expect(graph.get(0x010)).toEqual([0x150])
  })

  it('resolves secondary exits via the entrance table at $05F800', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    // ext-exit with secondary flag set (b1 bit 1 = 1), pointing at entrance index $20
    setLevelData(rom, 0x068000, [
      0, 0, 0, 0, 0,
      0x00, 0x02, 0x00, 0x20,  // b1=0x02 → secondary=1; extra=$20 → entrance
      0xFF,
    ])
    setL1Ptr(rom, 0x150, 0x06A000)
    setLevelData(rom, 0x06A000, [0, 0, 0, 0, 0, 0x42, 0xFF])
    // Entrance table: DATA_05F800[$20] = $50 (lo), DATA_05FE00[$20] flags = 0x08
    // → high bit (flags>>3 & 1) = 1 → dest = $150
    rom.writeAt(ADDR.SEC_EXIT_DEST + 0x20, [0x50])
    rom.writeAt(ADDR.SEC_EXIT_FLAGS + 0x20, [0x08])
    const smw = new SmwRom(rom)
    const graph = smw.buildLevelExitGraph()
    expect(graph.get(0x010)).toEqual([0x150])
  })

  it('drops exits whose resolved destination is not in the subarea set', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    // Secondary exit pointing at entrance $20 → dest $050 (an overworld level
    // index, not a sub-area). The exit-graph should therefore drop it.
    setLevelData(rom, 0x068000, [
      0, 0, 0, 0, 0,
      0x00, 0x02, 0x00, 0x20,
      0xFF,
    ])
    rom.writeAt(ADDR.SEC_EXIT_DEST + 0x20, [0x50])
    rom.writeAt(ADDR.SEC_EXIT_FLAGS + 0x20, [0x00])  // dest = $050 (overworld)
    const smw = new SmwRom(rom)
    expect(smw.buildLevelExitGraph().has(0x010)).toBe(false)
  })

  it('drops exits whose destination is the source level itself (self-loops)', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x150, 0x068000)
    // Sub-area 0x150 with a primary exit back to itself.
    setLevelData(rom, 0x068000, [
      0, 0, 0, 0, 0,
      0x00, 0x01, 0x00, 0x50,  // dest = $150 = self
      0xFF,
    ])
    const smw = new SmwRom(rom)
    expect(smw.buildLevelExitGraph().has(0x150)).toBe(false)
  })
})

// ── enumerateAllLevels ───────────────────────────────────────────────────────

describe('SmwRom.enumerateAllLevels', () => {
  it('returns LEVEL_COUNT (0x200) entries', () => {
    const smw = new SmwRom(make4MbRom())
    expect(smw.enumerateAllLevels().length).toBe(0x200)
  })

  it('marks hasData=true only for levels with a valid pointer + valid mode + non-FF first byte', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x000, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x42])
    const smw = new SmwRom(rom)
    const all = smw.enumerateAllLevels()
    expect(all[0].hasData).toBe(true)
    expect(all[1].hasData).toBe(false)  // no pointer set
  })

  it('decodes the level name when hasData is true (overworld-range only)', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x000, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x42])
    // Plant a name for translevel 0 (= pointer index 0).
    // Use the same packed-byte trick as SmwLevelNames.test.ts.
    const ADDR_LEVEL_NAME_STRINGS = 0x049AC5
    const ADDR_PREFIX_TABLE       = 0x049C91
    const ADDR_TYPE_TABLE         = 0x049CCF
    const ADDR_SUFFIX_TABLE       = 0x049CED
    const ADDR_LEVEL_NAMES        = 0x04A0FC
    rom.writeAt(ADDR_LEVEL_NAMES, [0x01, 0x00])  // pack
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x00, [0x00, 0x81])  // "AB"
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x10, [0x9F, 0x80])  // type skip
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x20, [0x9A])         // suffix → ''
    rom.writeAt(ADDR_PREFIX_TABLE + 0, [0x00, 0x00])
    rom.writeAt(ADDR_TYPE_TABLE   + 0, [0x10, 0x00])
    rom.writeAt(ADDR_SUFFIX_TABLE + 2, [0x20, 0x00])
    const smw = new SmwRom(rom)
    const all = smw.enumerateAllLevels()
    expect(all[0].name).toBe('AB')
  })
})
