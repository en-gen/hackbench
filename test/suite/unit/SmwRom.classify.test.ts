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

// A screen-exit ext object: b0=$00, b1 encodes secondary (bit1) -- the dead
// ExitTableHigh bit (bit0) is accepted for realism but ignored by SmwRom --
// b2=$00, followed by one raw extra byte. See LevelParser.ts lines 293-308.
function exitObj(rawByte: number, secondary: boolean): number[] {
  return [0x00, secondary ? 0x02 : 0x01, 0x00, rawByte]
}

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

  it('resolves a primary exit from a main-map root (submap flag 0)', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)                       // root, $000-$024 -> flag 0
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x50, false), 0xFF])
    setL1Ptr(rom, 0x050, 0x06A000)
    setLevelData(rom, 0x06A000, [0, 0, 0, 0, 0, 0x42, 0xFF])   // real sub-area
    const smw = new SmwRom(rom)
    expect(smw.buildLevelExitGraph().get(0x010)).toEqual([0x050])
  })

  it('resolves a primary exit from a submap root to a submap destination ($113 -> $1BB shape)', () => {
    // Same shape as the vanilla defect: root is in the submap pointer range
    // ($101-$13B) and must produce a dest in that same high range, not the
    // main-map range the old ExitTableHigh-derived bit produced.
    const rom = make4MbRom()
    setL1Ptr(rom, 0x113, 0x068000)                       // root, $101-$13B -> flag 1
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0xBB, false), 0xFF])
    setL1Ptr(rom, 0x1BB, 0x06A000)
    setLevelData(rom, 0x06A000, [0, 0, 0, 0, 0, 0x42, 0xFF])
    const smw = new SmwRom(rom)
    expect(smw.buildLevelExitGraph().get(0x113)).toEqual([0x1BB])
  })

  it('resolves secondary exits via the submap-selected half of DATA_05F800', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x105, 0x068000)                       // root, flag 1
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x10, true), 0xFF])
    setL1Ptr(rom, 0x177, 0x06A000)                       // correct dest (high half)
    setLevelData(rom, 0x06A000, [0, 0, 0, 0, 0, 0x42, 0xFF])
    setL1Ptr(rom, 0x188, 0x06B000)                       // decoy: what a low-byte-only
    setLevelData(rom, 0x06B000, [0, 0, 0, 0, 0, 0x42, 0xFF])  // index would produce
    // High half: index (1<<8)|$10 = $110 -> $77 (dest $177).
    // Low half (bug): index $10 alone -> $88 (dest $188, wrong).
    rom.writeAt(ADDR.SEC_EXIT_DEST + 0x110, [0x77])
    rom.writeAt(ADDR.SEC_EXIT_DEST + 0x10,  [0x88])
    const smw = new SmwRom(rom)
    expect(smw.buildLevelExitGraph().get(0x105)).toEqual([0x177])
  })

  it('rejects a destination sharing the filler L1 pointer even if classifyLevels lists it', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x106, 0x068000)                       // root, flag 1
    setLevelData(rom, 0x068000, [
      0, 0, 0, 0, 0,
      ...exitObj(0x40, false),   // -> $140, filler
      ...exitObj(0x41, false),   // -> $141, real
      0xFF,
    ])
    // Ten subarea-range slots share one pointer -- classifyLevels keeps only
    // the first ($140) after dedup, exactly like $027 on the Invictus ROM.
    // ($141 is deliberately skipped here -- it gets its own distinct pointer below.)
    for (const idx of [0x140, 0x142, 0x143, 0x144, 0x145, 0x146, 0x147, 0x148, 0x149, 0x14A]) {
      setL1Ptr(rom, idx, 0x06A000)
    }
    setLevelData(rom, 0x06A000, [0, 0, 0, 0, 0, 0x42, 0xFF])
    setL1Ptr(rom, 0x141, 0x06B000)                       // distinct real sub-area
    setLevelData(rom, 0x06B000, [0, 0, 0, 0, 0, 0x42, 0xFF])
    const smw = new SmwRom(rom)
    expect(smw.buildLevelExitGraph().get(0x106)).toEqual([0x141])
  })

  it('drops exits whose resolved destination is not in the subarea set', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    // Secondary exit -> entrance $20 -> DATA_05F800[$20] = $05 -> dest $005,
    // which is in the main-map overworld range, not a sub-area.
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x20, true), 0xFF])
    rom.writeAt(ADDR.SEC_EXIT_DEST + 0x20, [0x05])
    const smw = new SmwRom(rom)
    expect(smw.buildLevelExitGraph().has(0x010)).toBe(false)
  })

  it('drops a self-loop but keeps the root edge that reached it', () => {
    // Root is main-map (flag 0), so its rawByte-$50 exit resolves to $050,
    // not $150 -- the destination's high byte always matches the root's range.
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x50, false), 0xFF])
    setL1Ptr(rom, 0x050, 0x06A000)
    setLevelData(rom, 0x06A000, [0, 0, 0, 0, 0, ...exitObj(0x50, false), 0xFF])  // -> self
    const smw = new SmwRom(rom)
    const graph = smw.buildLevelExitGraph()
    expect(graph.get(0x010)).toEqual([0x050])
    expect(graph.has(0x050)).toBe(false)
  })

  it('terminates and records both edges of a two-node cycle between sub-areas', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x50, false), 0xFF])
    setL1Ptr(rom, 0x050, 0x06A000)
    setLevelData(rom, 0x06A000, [0, 0, 0, 0, 0, ...exitObj(0x60, false), 0xFF])
    setL1Ptr(rom, 0x060, 0x06B000)
    setLevelData(rom, 0x06B000, [0, 0, 0, 0, 0, ...exitObj(0x50, false), 0xFF])  // back to $050
    const smw = new SmwRom(rom)
    const graph = smw.buildLevelExitGraph()
    expect(graph.get(0x050)).toEqual([0x060])
    expect(graph.get(0x060)).toEqual([0x050])
  })

  it('leaves a level with no path from any overworld root unresolved', () => {
    const rom = make4MbRom()
    // $170 has an exit but nothing reaches it from an overworld root, so its
    // submap flag is never known and its own exits cannot be resolved.
    setL1Ptr(rom, 0x170, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x80, false), 0xFF])
    setL1Ptr(rom, 0x080, 0x06A000)
    setLevelData(rom, 0x06A000, [0, 0, 0, 0, 0, 0x42, 0xFF])
    const smw = new SmwRom(rom)
    expect(smw.buildLevelExitGraph().has(0x170)).toBe(false)
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
