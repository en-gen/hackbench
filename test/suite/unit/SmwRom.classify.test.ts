/**
 * SmwRom - synthetic-ROM tests for classifyLevels, buildLevelExitGraph, and
 * enumerateAllLevels. These exercise the higher-level orchestration logic on
 * top of the pointer/header reads tested in SmwRom.synthetic.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR, type OverworldRoots } from '../../../src/rom/SmwRom'
import { buildMapTree } from '../../../src/rom/MapTree'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import {
  plantOverworldTiles,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'

function make4MbRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('mock.smc', buf)
  // Stock submap-flag code, or the exit graph declines the ROM.
  plantStockSubmapCode(rom)
  plantOverworldTiles(rom)
  return rom
}

/** This file's SmwRom instances always carry the derivable stock roots. */
function rootsOf(smw: SmwRom): OverworldRoots | null {
  return deriveOverworldEntrances(smw, undefined, SYNTHETIC_FINGERPRINTS).roots
}

/** The exit graph under the synthetic ROM's NOP-span fingerprints. */
function graphOf(smw: SmwRom): ReturnType<SmwRom['buildLevelExitGraph']> {
  return smw.buildLevelExitGraph(rootsOf(smw), SYNTHETIC_FINGERPRINTS.entry)
}

/** Stamp a 3-byte L1 pointer for the given level index. */
function setL1Ptr(rom: RomFile, levelIndex: number, snesAddr: number): void {
  rom.writeAt(ADDR.LEVEL_L1_PTR + levelIndex * 3, [
    snesAddr & 0xff,
    (snesAddr >> 8) & 0xff,
    (snesAddr >> 16) & 0xff,
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
    const result = smw.classifyLevels(rootsOf(smw))
    expect(result.overworld).toEqual([])
    expect(result.subarea).toEqual([])
  })

  it('puts a walked main-map slot into overworld', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x42, 0xff]) // valid + has objects
    const smw = new SmwRom(rom)
    const result = smw.classifyLevels(rootsOf(smw))
    expect(result.overworld).toEqual([0x010])
    expect(result.subarea).toEqual([])
  })

  it('puts a slot the walk did not produce into subarea', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x150, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x42, 0xff])
    const smw = new SmwRom(rom)
    const result = smw.classifyLevels(rootsOf(smw))
    expect(result.subarea).toEqual([0x150])
    expect(result.overworld).toEqual([])
  })

  it('skips duplicate-pointer levels (vanilla shares many slots)', () => {
    const rom = make4MbRom()
    // Two indices with the SAME L1 pointer - second should be skipped.
    setL1Ptr(rom, 0x010, 0x068000)
    setL1Ptr(rom, 0x011, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x42, 0xff])
    const smw = new SmwRom(rom)
    const result = smw.classifyLevels(rootsOf(smw))
    expect(result.overworld).toEqual([0x010]) // 0x011 dropped as dup
  })

  it('keeps levels whose header.levelMode is 31 (valid, #130)', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0x1f, 0, 0, 0, 0x42, 0xff]) // mode = 31
    const smw = new SmwRom(rom)
    expect(smw.classifyLevels(rootsOf(smw)).overworld).toEqual([0x010])
  })

  it('skips levels whose first object byte is the immediate $FF terminator', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0xff]) // empty stream
    const smw = new SmwRom(rom)
    expect(smw.classifyLevels(rootsOf(smw)).overworld).toEqual([])
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
  it('reports DATA_05F800 unreadable on an image that ends where it starts', () => {
    // $05F800 is file offset $2F800; the gated code before it is all in range.
    const buf = Buffer.alloc(0x2f800)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('mini.smc', buf)
    plantStockSubmapCode(rom)
    const smw = new SmwRom(rom)
    const result = graphOf(smw)
    expect(result.graph.size).toBe(0)
    expect(result.unavailable).toMatch(/DATA_05F800 is unreadable/)
  })

  it('returns an empty Map when no level has any exit objects', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x00, 0x10, 0x00, 0xff])
    const smw = new SmwRom(rom)
    expect(graphOf(smw).graph.size).toBe(0)
  })

  it('resolves a primary exit from a main-map root (submap flag 0)', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000) // root, $000-$024 -> flag 0
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x50, false), 0xff])
    setL1Ptr(rom, 0x050, 0x06a000)
    setLevelData(rom, 0x06a000, [0, 0, 0, 0, 0, 0x42, 0xff]) // real sub-area
    const smw = new SmwRom(rom)
    expect(graphOf(smw).graph.get(0x010)).toEqual([0x050])
  })

  it('resolves a primary exit from a submap root to a submap destination ($113 -> $1BB shape)', () => {
    // Same shape as the vanilla defect: root is in the submap pointer range
    // ($101-$13B) and must produce a dest in that same high range, not the
    // main-map range the old ExitTableHigh-derived bit produced.
    const rom = make4MbRom()
    setL1Ptr(rom, 0x113, 0x068000) // root, $101-$13B -> flag 1
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0xbb, false), 0xff])
    setL1Ptr(rom, 0x1bb, 0x06a000)
    setLevelData(rom, 0x06a000, [0, 0, 0, 0, 0, 0x42, 0xff])
    const smw = new SmwRom(rom)
    expect(graphOf(smw).graph.get(0x113)).toEqual([0x1bb])
  })

  it('resolves secondary exits via the submap-selected half of DATA_05F800', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x105, 0x068000) // root, flag 1
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x10, true), 0xff])
    setL1Ptr(rom, 0x177, 0x06a000) // correct dest (high half)
    setLevelData(rom, 0x06a000, [0, 0, 0, 0, 0, 0x42, 0xff])
    setL1Ptr(rom, 0x188, 0x06b000) // decoy: what a low-byte-only
    setLevelData(rom, 0x06b000, [0, 0, 0, 0, 0, 0x42, 0xff]) // index would produce
    // High half: index (1<<8)|$10 = $110 -> $77 (dest $177).
    // Low half (bug): index $10 alone -> $88 (dest $188, wrong).
    rom.writeAt(ADDR.SEC_EXIT_DEST + 0x110, [0x77])
    rom.writeAt(ADDR.SEC_EXIT_DEST + 0x10, [0x88])
    const smw = new SmwRom(rom)
    expect(graphOf(smw).graph.get(0x105)).toEqual([0x177])
  })

  it('rejects a destination sharing the filler L1 pointer even if classifyLevels lists it', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x106, 0x068000) // root, flag 1
    setLevelData(rom, 0x068000, [
      0,
      0,
      0,
      0,
      0,
      ...exitObj(0x40, false), // -> $140, filler
      ...exitObj(0x41, false), // -> $141, real
      0xff,
    ])
    // Ten subarea-range slots share one pointer -- classifyLevels keeps only
    // the first ($140) after dedup, exactly like $027 on the Invictus ROM.
    // ($141 is deliberately skipped here -- it gets its own distinct pointer below.)
    for (const idx of [0x140, 0x142, 0x143, 0x144, 0x145, 0x146, 0x147, 0x148, 0x149, 0x14a]) {
      setL1Ptr(rom, idx, 0x06a000)
    }
    setLevelData(rom, 0x06a000, [0, 0, 0, 0, 0, 0x42, 0xff])
    setL1Ptr(rom, 0x141, 0x06b000) // distinct real sub-area
    setLevelData(rom, 0x06b000, [0, 0, 0, 0, 0, 0x42, 0xff])
    const smw = new SmwRom(rom)
    expect(graphOf(smw).graph.get(0x106)).toEqual([0x141])
  })

  // MapTree's walk boundary (`isRoot || !maps.has`) mirrors this exclusion, so this
  // is the test that pins it: no edge may enter an overworld root or a non-real slot.
  it('emits no edge into an overworld root or a non-real slot, even when a room names one', () => {
    const rom = make4MbRom()
    // $001 and $002 are real roots; $0C0 is a real sub area; $0C9 holds no pointer.
    setL1Ptr(rom, 0x001, 0x068000)
    setLevelData(rom, 0x068000, [
      0,
      0,
      0,
      0,
      0,
      ...exitObj(0xc0, false),
      ...exitObj(0x02, false), // -> $002, a real root
      ...exitObj(0xc9, false), // -> $0C9, not real
      0xff,
    ])
    setL1Ptr(rom, 0x002, 0x069000)
    setLevelData(rom, 0x069000, [0, 0, 0, 0, 0, 0x42, 0xff])
    setL1Ptr(rom, 0x0c0, 0x06a000)
    setLevelData(rom, 0x06a000, [0, 0, 0, 0, 0, ...exitObj(0x01, false), 0xff]) // -> $001, a root
    const graph = graphOf(new SmwRom(rom)).graph
    expect(graph.get(0x001)).toEqual([0x0c0])
    expect(graph.has(0x0c0)).toBe(false)
  })

  it('drops exits whose resolved destination is not in the subarea set', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    // Secondary exit -> entrance $20 -> DATA_05F800[$20] = $05 -> dest $005,
    // which is in the main-map overworld range, not a sub-area.
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x20, true), 0xff])
    rom.writeAt(ADDR.SEC_EXIT_DEST + 0x20, [0x05])
    const smw = new SmwRom(rom)
    expect(graphOf(smw).graph.has(0x010)).toBe(false)
  })

  it('drops a self-loop but keeps the root edge that reached it', () => {
    // Root is main-map (flag 0), so its rawByte-$50 exit resolves to $050,
    // not $150 -- the destination's high byte always matches the root's range.
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x50, false), 0xff])
    setL1Ptr(rom, 0x050, 0x06a000)
    setLevelData(rom, 0x06a000, [0, 0, 0, 0, 0, ...exitObj(0x50, false), 0xff]) // -> self
    const smw = new SmwRom(rom)
    const graph = graphOf(smw).graph
    expect(graph.get(0x010)).toEqual([0x050])
    expect(graph.has(0x050)).toBe(false)
  })

  it('terminates and records both edges of a two-node cycle between sub-areas', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x010, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x50, false), 0xff])
    setL1Ptr(rom, 0x050, 0x06a000)
    setLevelData(rom, 0x06a000, [0, 0, 0, 0, 0, ...exitObj(0x60, false), 0xff])
    setL1Ptr(rom, 0x060, 0x06b000)
    setLevelData(rom, 0x06b000, [0, 0, 0, 0, 0, ...exitObj(0x50, false), 0xff]) // back to $050
    const smw = new SmwRom(rom)
    const graph = graphOf(smw).graph
    expect(graph.get(0x050)).toEqual([0x060])
    expect(graph.get(0x060)).toEqual([0x050])
  })

  it('leaves a level with no path from any overworld root unresolved', () => {
    const rom = make4MbRom()
    // $170 has an exit but nothing reaches it from an overworld root, so its
    // submap flag is never known and its own exits cannot be resolved.
    setL1Ptr(rom, 0x170, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x80, false), 0xff])
    setL1Ptr(rom, 0x080, 0x06a000)
    setLevelData(rom, 0x06a000, [0, 0, 0, 0, 0, 0x42, 0xff])
    const smw = new SmwRom(rom)
    expect(graphOf(smw).graph.has(0x170)).toBe(false)
  })
})

// ── the submap-flag gate (#486) ──────────────────────────────────────────────

// Literal, not imported from SubmapFlagGate, so a wrong constant goes red.
// Each is the first byte a hack changes in a run the gate checks.
const GATED = [
  { what: 'the JSL into CODE_05D796', at: 0x0096f7, byte: 0x06, shown: '$0096F4' },
  { what: 'the JMP to CODE_05D83E', at: 0x05d7b0, byte: 0x5c, shown: '$05D7B0' },
  { what: 'the overworld-entry BEQ', at: 0x05d8b1, byte: 0x22, shown: '$05D8A2' },
  { what: 'the screen-exit BEQ', at: 0x05d7ce, byte: 0x22, shown: '$05D7CB' },
  { what: 'the screen-exit BEQ displacement', at: 0x05d7cf, byte: 0x03, shown: '$05D7CB' },
  { what: 'the screen-exit LDA #imm', at: 0x05d7d0, byte: 0xad, shown: '$05D7CB' },
  { what: 'the screen-exit STA _F', at: 0x05d7d2, byte: 0x8d, shown: '$05D7CB' },
  { what: 'a screen-exit high byte of 2', at: 0x05d7d1, byte: 0x02, shown: '$05D7D1' },
  { what: 'the DATA_05F800 read', at: 0x05d7e2, byte: 0xbb, shown: '$05D7E2' },
]

/** Root $105 with a primary exit to $177 under the stock rule. */
function gatedRom(plant?: { at: number; byte: number }): SmwRom {
  const rom = make4MbRom()
  setL1Ptr(rom, 0x105, 0x068000)
  setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, ...exitObj(0x77, false), 0xff])
  setL1Ptr(rom, 0x177, 0x06a000)
  setLevelData(rom, 0x06a000, [0, 0, 0, 0, 0, 0x42, 0xff])
  if (plant) rom.writeAt(plant.at, [plant.byte])
  return new SmwRom(rom)
}

describe('exit graph submap-flag gate', () => {
  it('builds the stock graph, and the Maps tree nests it', () => {
    const smw = gatedRom()
    const result = graphOf(smw)
    expect(result.unavailable).toBeNull()
    expect(result.graph.get(0x105)).toEqual([0x177])
    const tree = buildMapTree(gatedRom(), SYNTHETIC_FINGERPRINTS)
    expect(tree.overworld.find(n => n.index === 0x105)?.children.map(c => c.index)).toEqual([0x177])
    expect(tree.notes.join(' ')).not.toMatch(/hierarchy unavailable/i)
  })

  it("takes a submap exit's high byte from the screen-exit LDA #imm", () => {
    // High byte 0: $105's exit byte $77 names main-map $077, not $177.
    const smw = gatedRom({ at: 0x05d7d1, byte: 0x00 })
    setL1Ptr(smw.rom, 0x077, 0x06c000)
    setLevelData(smw.rom, 0x06c000, [0, 0, 0, 0, 0, 0x42, 0xff])
    const result = graphOf(smw)
    expect(result.unavailable).toBeNull()
    expect(result.graph.get(0x105)).toEqual([0x077])
  })

  it('refuses when submap entrances load high byte 0 but screen exits load 1', () => {
    const result = graphOf(gatedRom({ at: 0x05d8b4, byte: 0x00 }))
    expect(result.graph.size).toBe(0)
    expect(result.unavailable).toContain('$05D8B4')
  })

  it('accepts the JSL through the FastROM mirror, bank $85', () => {
    const smw = gatedRom({ at: 0x0096f7, byte: 0x85 })
    const result = graphOf(smw)
    expect(result.unavailable).toBeNull()
    expect(result.graph.get(0x105)).toEqual([0x177])
  })

  it.each(GATED)('refuses when $what is replaced', ({ at, byte, shown }) => {
    const smw = gatedRom({ at, byte })
    const result = graphOf(smw)
    expect(result.graph.size).toBe(0)
    expect(result.unavailable).toContain(shown)
  })

  it('refuses when a gated run is unreadable', () => {
    // 64 KB holds bank $00, so the JSL matches and bank $05 is out of range.
    const buf = Buffer.alloc(0x10000)
    buf[0x7fd5] = 0x20
    buf.set([0x22, 0x96, 0xd7, 0x05], 0x16f4)
    const smw = new SmwRom(new RomFile('tiny.smc', buf))
    const result = graphOf(smw)
    expect(result.graph.size).toBe(0)
    expect(result.unavailable).toMatch(/nothing readable/)
  })

  it('lists every map with no stock hierarchy, and says why', () => {
    const tree = buildMapTree(gatedRom({ at: 0x05d7ce, byte: 0x22 }), SYNTHETIC_FINGERPRINTS)
    expect(tree.overworld.map(n => n.index)).toEqual([0x105])
    expect(tree.overworld[0]!.children).toEqual([])
    // Coverage still holds: the sub area is listed, just not grouped.
    expect(tree.unassigned.map(n => n.index)).toEqual([0x177])
    expect(tree.mapCount).toBe(2)
    const notes = tree.notes.join(' ')
    expect(notes).toMatch(/hierarchy unavailable/i)
    expect(notes).toContain('$05D7CB')
    // The orphan note blames the graph's design; here the graph was declined.
    expect(notes).not.toMatch(/by design/)
  })

  it('declines the graph when the overworld roots are null', () => {
    const result = gatedRom().buildLevelExitGraph(null, SYNTHETIC_FINGERPRINTS.entry)
    expect(result.graph.size).toBe(0)
    expect(result.unavailable).toMatch(/roots could not be read/)
  })

  it('names no root at all when the walk is unreadable, not the stock range', () => {
    const tree = buildMapTree(gatedRom({ at: 0x04d832, byte: 0xea }), SYNTHETIC_FINGERPRINTS)
    expect(tree.overworld).toEqual([])
    expect(tree.unassigned.map(n => n.index)).toEqual([0x105, 0x177])
    expect(tree.notes.join(' ')).toMatch(/roots could not be read/)
  })

  it('keeps the roots and the hierarchy when only the warp-tile read fails', () => {
    const tree = buildMapTree(gatedRom({ at: 0x04915b, byte: 0xea }), SYNTHETIC_FINGERPRINTS)
    expect(tree.overworld.find(n => n.index === 0x105)?.children.map(c => c.index)).toEqual([0x177])
    expect(tree.counts.entrances).toBeNull()
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
    expect(all[1].hasData).toBe(false) // no pointer set
  })

  it('decodes the level name when hasData is true (overworld-range only)', () => {
    const rom = make4MbRom()
    // plantOverworldTiles's first main tile is translevel 1, at slot $001
    // (the counter starts at 1, so slot $000 is never an overworld slot).
    setL1Ptr(rom, 0x001, 0x068000)
    setLevelData(rom, 0x068000, [0, 0, 0, 0, 0, 0x42])
    const ADDR_LEVEL_NAME_STRINGS = 0x049ac5
    const ADDR_PREFIX_TABLE = 0x049c91
    const ADDR_TYPE_TABLE = 0x049ccf
    const ADDR_SUFFIX_TABLE = 0x049ced
    const ADDR_LEVEL_NAMES = 0x04a0fc
    rom.writeAt(ADDR_LEVEL_NAMES + 1 * 2, [0x01, 0x00]) // pack, translevel 1
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x00, [0x00, 0x81]) // "AB"
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x10, [0x9f, 0x80]) // type skip
    rom.writeAt(ADDR_LEVEL_NAME_STRINGS + 0x20, [0x9a]) // suffix -> ''
    rom.writeAt(ADDR_PREFIX_TABLE + 0, [0x00, 0x00])
    rom.writeAt(ADDR_TYPE_TABLE + 0, [0x10, 0x00])
    rom.writeAt(ADDR_SUFFIX_TABLE + 2, [0x20, 0x00])
    const smw = new SmwRom(rom)
    // make4MbRom's overworld span is NOP-filled (CLAUDE.md: no ROM bytes
    // committed), so the walk needs the synthetic fingerprint to read as stock.
    const entrances = deriveOverworldEntrances(smw, undefined, {
      entry: SYNTHETIC_FINGERPRINTS.entry,
      walk: SYNTHETIC_FINGERPRINTS.walk,
    })
    const all = smw.enumerateAllLevels(entrances)
    expect(all[1].name).toBe('AB')
  })
})

// ── levelHasObjects level-mode range (#130) ──────────────────────────────────

describe('SmwRom.levelHasObjects level mode', () => {
  // Every mode $00-$1F is a valid index into the six 32-entry mode tables
  // (SMWDisX bank_05.asm:478-521); the header read masks with $1F (:539).
  it.each(Array.from({ length: 0x20 }, (_, mode) => mode))(
    'accepts level mode %s (decimal)',
    mode => {
      const rom = make4MbRom()
      setL1Ptr(rom, 0x000, 0x068000)
      // Header byte 1 carries bg color in bits 7-5 and the mode in bits 4-0.
      setLevelData(rom, 0x068000, [0, 0xe0 | mode, 0, 0, 0, 0x42])
      expect(new SmwRom(rom).levelHasObjects(0)).toBe(true)
    },
  )

  it('still rejects an immediate object terminator in any mode', () => {
    const rom = make4MbRom()
    setL1Ptr(rom, 0x000, 0x068000)
    setLevelData(rom, 0x068000, [0, 0x1f, 0, 0, 0, 0xff])
    expect(new SmwRom(rom).levelHasObjects(0)).toBe(false)
  })
})
