/**
 * Synthetic-ROM tests for the overworld entrance derivation.
 *
 * These run in CI (no ROM files involved) and are the mutation oracle for
 * the derivation: the CMP-read tile range, the sequential translevel
 * counter, CODE_05D8A2's >= $25 subtract, the buffer-half submap gate, the
 * warp and event-swapped-warp classification, and the fail-closed probe
 * each have a test that goes red when that rule is changed. See
 * docs/ideas/level-classification.md.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR, LEVEL_COUNT, isOverworldLevel } from '../../../src/rom/SmwRom'
import { loromToOffset } from '../../../src/rom/addressing'
import { OW_ADDR, OW_L1_MAP16_BYTES } from '../../../src/rom/OverworldLoader'
import { OW_EVENT_ADDR } from '../../../src/rom/OverworldEvents'
import {
  deriveOverworldEntrances,
  decodeBufferIndex,
  warpPrecursorTiles,
  STOCK_OVERWORLD_FINGERPRINTS,
  SUBMAP_BUFFER_BASE,
} from '../../../src/rom/OverworldEntrances'
import { OVERWORLD_INDEX_BODY } from '../../../src/rom/SubmapFlagGate'
import {
  plantLmEntryHook,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'

/** The overworld-entry BEQ (bank_05.asm:7224), literal so a wrong constant goes red. */
const OW_ENTRY_BEQ = 0x05d8b1

const BUF_SIZE = 0x80000
const off = (snes: number): number => loromToOffset(snes, BUF_SIZE)!

/** The synthetic ROM fills fingerprinted spans with NOPs, so it names their hashes. */
const derive = (rom: SmwRom): ReturnType<typeof deriveOverworldEntrances> =>
  deriveOverworldEntrances(rom, undefined, SYNTHETIC_FINGERPRINTS)

const STOCK_WARPS = { starWarpTile: 0x5f, pipeWarpTile: 0x5b }

const FILLER = 0x068000
const REAL = 0x078000

interface RomOpts {
  probe?: number
  fillerSlots?: Iterable<number>
  cameras?: boolean
  /** (from, to) pairs written into DATA_04DA1D / DATA_04DA33. */
  swaps?: [number, number][]
}

/**
 * Synthetic LoROM carrying just what the derivation reads: the map-mode
 * byte, the L1 pointer table, the stock code SubmapFlagGate checks, the overworld
 * Layer-1 Map16 stream, and optionally the event tile-swap tables. Every
 * slot gets a distinct real pointer unless listed in `fillerSlots`, so
 * `isMap` is under test control.
 */
function buildRom(tiles: Record<number, number>, opts: RomOpts = {}): SmwRom {
  const buf = Buffer.alloc(BUF_SIZE, 0)
  buf[0x7fd5] = 0x20
  plantStockSubmapCode(new RomFile('synthetic.sfc', buf))
  if (opts.probe !== undefined) buf[off(OW_ENTRY_BEQ)] = opts.probe

  // Half the slots share FILLER so LevelCatalog's mode heuristic finds it.
  const filler = new Set(opts.fillerSlots ?? [])
  for (let i = 0; i < LEVEL_COUNT; i++) {
    const ptr = i >= LEVEL_COUNT / 2 || filler.has(i) ? FILLER : REAL + i * 0x10
    const base = off(ADDR.LEVEL_L1_PTR) + i * 3
    buf[base] = ptr & 0xff
    buf[base + 1] = (ptr >> 8) & 0xff
    buf[base + 2] = (ptr >> 16) & 0xff
  }

  const stream = off(OW_ADDR.L1_TILEDATA)
  for (const [index, tile] of Object.entries(tiles)) buf[stream + Number(index)] = tile

  ;(opts.swaps ?? []).forEach(([from, to], i) => {
    buf[off(OW_EVENT_ADDR.FROM_LIST) + i] = from
    buf[off(OW_EVENT_ADDR.TO_LIST) + i] = to
  })

  if (opts.cameras) {
    // DATA_00A06B / DATA_00A079, 7 signed words each: area 1 at (-16, -16)
    // puts its Map16 window origin at (-1, -1); the rest stay at 0.
    buf.writeInt16LE(-16, off(OW_ADDR.CAMERA_X_TABLE) + 2)
    buf.writeInt16LE(-16, off(OW_ADDR.CAMERA_Y_TABLE) + 2)
  }
  return new SmwRom(new RomFile('synthetic.sfc', buf))
}

describe('decodeBufferIndex', () => {
  it('inverts the CODE_05D83E index formula over the whole buffer', () => {
    for (let i = 0; i < OW_L1_MAP16_BYTES; i++) {
      const { layout, tileX, tileY } = decodeBufferIndex(i)
      const rebuilt =
        layout * SUBMAP_BUFFER_BASE +
        ((tileY & 0x10) << 5) +
        ((tileX & 0x10) << 4) +
        ((tileY & 0x0f) << 4) +
        (tileX & 0x0f)
      expect(rebuilt).toBe(i)
    }
  })

  it('splits the buffer into a main-map half and a sub-map half', () => {
    expect(decodeBufferIndex(0x000)).toEqual({ layout: 0, tileX: 0, tileY: 0 })
    expect(decodeBufferIndex(0x3ff)).toEqual({ layout: 0, tileX: 31, tileY: 31 })
    expect(decodeBufferIndex(0x400)).toEqual({ layout: 1, tileX: 0, tileY: 0 })
    expect(decodeBufferIndex(0x7ff)).toEqual({ layout: 1, tileX: 31, tileY: 31 })
  })
})

describe('warpPrecursorTiles', () => {
  it('keeps only the swap pairs whose result is a warp tile', () => {
    const rom = buildRom(
      {},
      {
        swaps: [
          [0x6e, 0x66],
          [0x5a, 0x5f],
          [0x71, 0x5b],
        ],
      },
    )
    expect([...warpPrecursorTiles(rom.rom, STOCK_WARPS).entries()]).toEqual([
      [0x5a, 0x5f],
      [0x71, 0x5b],
    ])
  })

  it('is empty when no swap produces a warp tile', () => {
    const rom = buildRom(
      {},
      {
        swaps: [
          [0x6e, 0x66],
          [0x70, 0x68],
        ],
      },
    )
    expect(warpPrecursorTiles(rom.rom, STOCK_WARPS).size).toBe(0)
  })
})

describe('deriveOverworldEntrances: the translevel walk', () => {
  it('numbers translevels sequentially from 1 in buffer order', () => {
    const rom = buildRom({ 0x123: 0x6e, 0x010: 0x6e, 0x300: 0x6e })
    const result = derive(rom)
    expect(result.overworldReadable).toBe(true)
    expect(result.entrances.map(e => [e.bufferIndex, e.translevel])).toEqual([
      [0x010, 1],
      [0x123, 2],
      [0x300, 3],
    ])
  })

  it("grants a translevel to exactly the fixture's CMP range, $50..$80", () => {
    const rom = buildRom({ 0x00: 0x4f, 0x01: 0x50, 0x02: 0x6e, 0x03: 0x80, 0x04: 0x81, 0x05: 0xff })
    const result = derive(rom)
    expect(result.entrances.map(e => e.bufferIndex)).toEqual([0x01, 0x02, 0x03])
    expect(result.entrances.map(e => e.map16Tile)).toEqual([0x50, 0x6e, 0x80])
  })

  it('reports the exact tile coordinate and the ROM byte that defines it', () => {
    const rom = buildRom({ 0x59b: 0x6e })
    const [entrance] = derive(rom).entrances
    expect(entrance).toMatchObject({
      bufferIndex: 0x59b,
      layout: 1,
      tileX: 27,
      tileY: 9,
      tileDataAddress: OW_ADDR.L1_TILEDATA + 0x59b,
    })
  })
})

describe('deriveOverworldEntrances: CODE_05D8A2 gates', () => {
  it('subtracts $24 only at or above translevel $25', () => {
    // $25 main-map tiles: translevels $01..$25.
    const tiles: Record<number, number> = {}
    for (let i = 0; i < 0x25; i++) tiles[i] = 0x6e
    const result = derive(buildRom(tiles))
    const bySlot = new Map(result.entrances.map(e => [e.translevel, e.slot]))
    expect(bySlot.get(0x01)).toBe(0x001)
    expect(bySlot.get(0x24)).toBe(0x024)
    // Two independent gates: the subtract fires, the submap gate does not.
    expect(bySlot.get(0x25)).toBe(0x001)
    expect(result.notes.some(n => n.includes('main-map entrances have a translevel'))).toBe(true)
  })

  it('takes the high byte from the buffer half, not from the translevel', () => {
    // Translevels $01 and $02 land in the sub-map half. A rule keyed on
    // "translevel >= $25 means sub-map" would return $001/$002 here.
    const rom = buildRom({ 0x400: 0x6e, 0x401: 0x6e })
    const result = derive(rom)
    expect(result.entrances.map(e => e.translevel)).toEqual([1, 2])
    expect(result.entrances.map(e => e.slot)).toEqual([0x101, 0x102])
  })

  it('applies both gates together for sub-map translevels above $25', () => {
    const tiles: Record<number, number> = {}
    for (let i = 0; i < 0x24; i++) tiles[i] = 0x6e // translevels $01..$24
    tiles[0x400] = 0x6e // translevel $25
    tiles[0x401] = 0x6e // translevel $26
    const result = derive(buildRom(tiles))
    const tail = result.entrances.slice(-2)
    expect(tail.map(e => e.translevel)).toEqual([0x25, 0x26])
    expect(tail.map(e => e.slot)).toEqual([0x101, 0x102])
  })

  it('wraps the translevel counter at $FF, as INC.B does, and says so', () => {
    const tiles: Record<number, number> = {}
    for (let i = 0; i < 0x101; i++) tiles[i] = 0x6e
    const result = derive(buildRom(tiles))
    expect(result.entrances).toHaveLength(0x101)
    expect(result.entrances[0xfe]!.translevel).toBe(0xff)
    expect(result.entrances[0xff]!.translevel).toBe(0x00)
    expect(result.notes.some(n => n.includes('wrapped past $FF'))).toBe(true)
  })
})

describe('deriveOverworldEntrances: what actually starts a map', () => {
  it('classifies $5F as a star warp and $5B as a pipe warp, not maps', () => {
    const rom = buildRom({ 0x00: 0x5b, 0x01: 0x5f, 0x02: 0x6e })
    const result = derive(rom)
    expect(result.entrances.map(e => e.action)).toEqual(['pipeWarp', 'starWarp', 'map'])
    // All three carry a translevel; only the third contributes an entry map.
    expect(result.entrances.map(e => e.translevel)).toEqual([1, 2, 3])
    expect(result.entryMaps).toEqual([0x003])
  })

  it('treats a tile an event swaps into a warp tile as a pending warp', () => {
    const rom = buildRom({ 0x00: 0x5a, 0x01: 0x6e }, { swaps: [[0x5a, 0x5f]] })
    const result = derive(rom)
    expect(result.entrances.map(e => e.action)).toEqual(['pendingWarp', 'map'])
    // It keeps its translevel, slot and position; it just yields no entry map.
    expect(result.entrances[0]).toMatchObject({ translevel: 1, slot: 0x001, isMap: true })
    expect(result.entryMaps).toEqual([0x002])
    expect(result.notes.some(n => n.includes('$5A->$5F'))).toBe(true)
  })

  it('reads the precursor tile from the ROM rather than hardcoding $5A', () => {
    // Same tile data, different swap table: now $6E is the pending warp and
    // $5A is an ordinary launch tile.
    const rom = buildRom({ 0x00: 0x5a, 0x01: 0x6e }, { swaps: [[0x6e, 0x5f]] })
    const result = derive(rom)
    expect(result.entrances.map(e => e.action)).toEqual(['map', 'pendingWarp'])
    expect(result.entryMaps).toEqual([0x001])
  })

  it('leaves a tile alone when its event swap does not produce a warp tile', () => {
    const rom = buildRom({ 0x00: 0x5a }, { swaps: [[0x5a, 0x66]] })
    expect(derive(rom).entrances[0]!.action).toBe('map')
  })

  it('drops entrances whose slot holds the filler L1 pointer', () => {
    const rom = buildRom({ 0x00: 0x6e, 0x01: 0x6e, 0x02: 0x6e }, { fillerSlots: [0x002] })
    const result = derive(rom)
    expect(result.entrances.map(e => e.isMap)).toEqual([true, false, true])
    expect(result.entryMaps).toEqual([0x001, 0x003])
  })

  it('reports each entry map once even when two tiles start the same slot', () => {
    // Two main-map tiles with translevels $01 and $25 collide on slot $001.
    const tiles: Record<number, number> = {}
    for (let i = 0; i < 0x25; i++) tiles[i] = 0x6e
    const result = derive(buildRom(tiles))
    expect(result.entrances.filter(e => e.slot === 0x001)).toHaveLength(2)
    expect(result.entryMaps.filter(m => m === 0x001)).toHaveLength(1)
  })
})

describe('deriveOverworldEntrances: sub-map inference', () => {
  it('reports submap 0 for every main-map entrance', () => {
    const rom = buildRom({ 0x000: 0x6e, 0x3ff: 0x6e })
    expect(derive(rom).entrances.every(e => e.submap === 0)).toBe(true)
  })

  it('places a sub-map tile in the area whose camera window covers it', () => {
    // Area 1's camera is (-16,-16) -> window origin (-1,-1), 16x14 tiles.
    // Areas 2..6 sit at origin (0,0) in this synthetic ROM, so a tile at
    // (0,0) matches area 1 first and a tile at row 15 matches none.
    const rom = buildRom({ 0x400: 0x6e, 0x4f0: 0x6e }, { cameras: true })
    const result = derive(rom)
    expect(result.entrances[0]).toMatchObject({ tileX: 0, tileY: 0, submap: 1 })
    expect(result.entrances[1]).toMatchObject({ tileX: 0, tileY: 15, submap: null })
    expect(result.notes.some(n => n.includes('outside every camera-derived'))).toBe(true)
  })
})

describe('deriveOverworldEntrances: constants read from ROM, not hardcoded', () => {
  it('follows the translevel range and warp tiles when a ROM changes them', () => {
    // New range $20-$40, disjoint from stock $56-$80: none of these three
    // tiles would even carry a translevel under the stock constants.
    const rom = buildRom({ 0x00: 0x25, 0x01: 0x26, 0x02: 0x30 })
    rom.rom.writeAt(0x04d832, [0xb7, 0x04, 0xc9, 0x20, 0x90, 0x11, 0xc9, 0x41, 0xb0, 0x0d])
    rom.rom.writeAt(0x04915b, [0x9c, 0x9e, 0x1b, 0xad, 0xc1, 0x13, 0xc9, 0x25, 0xd0, 0x18])
    rom.rom.writeAt(0x04917d, [0xad, 0xc1, 0x13, 0xc9, 0x82, 0xf0, 0x04, 0xc9, 0x26, 0xd0, 0x11])
    const result = derive(rom)
    expect(result.overworldReadable).toBe(true)
    expect(result.entrances.map(e => e.action)).toEqual(['starWarp', 'pipeWarp', 'map'])
  })

  it('applies the planted bias subtract, not the stock $25/$24 pair', () => {
    const tiles: Record<number, number> = {}
    for (let i = 0; i < 0x10; i++) tiles[i] = 0x6e // translevels 1..16
    const rom = buildRom(tiles)
    // Bias now fires at translevel >= $08, subtracting $07.
    rom.rom.writeAt(0x05d8a2, [0xc9, 0x08, 0x90, 0x03, 0x38, 0xe9, 0x07])
    const bySlot = new Map(derive(rom).entrances.map(e => [e.translevel, e.slot]))
    expect(bySlot.get(0x07)).toBe(0x007)
    expect(bySlot.get(0x08)).toBe(0x001) // stock $25/$24 would leave this un-subtracted
  })

  it('starts numbering at the LDY #start operand, not at a typed-in 1', () => {
    const rom = buildRom({ 0x00: 0x6e, 0x01: 0x6e })
    rom.rom.writeAt(0x04d81e, [0x05])
    expect(derive(rom).entrances.map(e => e.translevel)).toEqual([5, 6])
  })

  it.each([
    ['the translevel-range compare', 0x04d832, 0xea],
    ['the BCC after it', 0x04d836, 0xb0],
    ['the JSR into CODE_04D7F2', 0x04dc65, 0x00],
    ['a JML inside the walk prologue', 0x04d800, 0x5c],
    ['STA [_A],Y where the walk stores the translevel', 0x04d83d, 0x0a],
    ['INC _1 in place of INC _0', 0x04d848, 0x01],
    ['a loop bound past the $800 buffer', 0x04d84c, 0x09],
    ['a loop bound of 0', 0x04d84c, 0x00],
  ])('reports no roots when %s is not stock', (_what, at, byte) => {
    const rom = buildRom({ 0x00: 0x6e })
    rom.rom.writeAt(at, [byte])
    const result = derive(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.entrances).toEqual([])
    expect(result.roots).toBeNull()
  })

  it('refuses a tile-range compare the call does not reach, even when one exists', () => {
    // A stock-shaped walk copied to $04E000; the one the JSR reaches is broken.
    const rom = buildRom({ 0x00: 0x6e })
    rom.rom.writeAt(0x04e000, [...rom.rom.readAt(0x04d7f2, 43 + 31 + 19)!])
    rom.rom.writeAt(0x04d832, [0xea])
    expect(derive(rom).roots).toBeNull()
    // Point the JSR at the copy and the same bytes are now reached.
    rom.rom.writeAt(0x04dc65, [0x00, 0xe0])
    expect(derive(rom).roots).not.toBeNull()
  })

  it.each([
    ['the BCC swapped for BCS', 0x05d8a4, 0xb0],
    ['the BCC displacement', 0x05d8a5, 0x02],
    ['the SEC', 0x05d8a6, 0xea],
    ['the SBC opcode', 0x05d8a7, 0xea],
    ['a JML inside CODE_05D83E', 0x05d842, 0x5c],
    ['LDA abs in place of LDA #submapHigh', 0x05d8b3, 0xad],
    ['STA abs in place of STA _F', 0x05d8b5, 0x8d],
  ])('reports no roots when the bias path has %s', (_what, at, byte) => {
    const rom = buildRom({ 0x00: 0x6e })
    rom.rom.writeAt(at, [byte])
    const result = derive(rom)
    expect(result.roots).toBeNull()
    expect(result.notes[0]).toMatch(/\$05D8A2|\$05D83E/)
  })

  it.each([
    ['the star-tile compare', 0x04915b, 0xea],
    ['the BNE into OWPU_ABXY', 0x049156, 0xf0],
    ['the pipe-tile compare', 0x04917d, 0xea],
    ['the star branch, pointed off the pipe compare', 0x049164, 0x17],
    ['the debug skip, closed to fall into the warp', 0x049137, 0x00],
    ['a BEQ in place of the debug BRA', 0x049136, 0xf0],
    ['the L/R block', 0x049141, 0xea],
  ])('keeps the roots but classifies nothing when %s is not stock', (_what, at, byte) => {
    const rom = buildRom({ 0x00: 0x6e, 0x400: 0x6e })
    rom.rom.writeAt(at, [byte])
    const result = derive(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.entrances).toEqual([])
    expect(result.roots).toEqual({ main: new Set([0x001]), sub: new Set([0x102]) })
  })
})

describe('deriveOverworldEntrances: read where the code says, not where vanilla keeps it', () => {
  it('walks the stream CODE_04DC09 copies, not the stock $0CF7DF', () => {
    // LDX #$8000 and MVN source bank $0D: the stream now sits at $0D8000.
    const rom = buildRom({ 0x00: 0x6e })
    rom.rom.writeAt(0x04dc5b, [0x00, 0x80])
    rom.rom.writeAt(0x04dc62, [0x0d])
    rom.rom.writeAt(0x0d8000, [0x6e, 0x6e, 0x6e])
    const result = derive(rom)
    expect(result.entrances.map(e => e.tileDataAddress)).toEqual([0x0d8000, 0x0d8001, 0x0d8002])
  })

  it('walks only as far as CPY #bound says', () => {
    const rom = buildRom({ 0x00: 0x6e, 0x400: 0x6e })
    rom.rom.writeAt(0x04d84c, [0x04])
    expect(derive(rom).entrances.map(e => e.bufferIndex)).toEqual([0x00])
  })

  it('takes the submap high byte from LDA #imm, not a typed-in $100', () => {
    const rom = buildRom({ 0x400: 0x6e })
    rom.rom.writeAt(0x05d8b4, [0x00])
    expect(derive(rom).entrances.map(e => e.slot)).toEqual([0x001])
  })

  it.each([
    ['$02', 0x02],
    ['$FF', 0xff],
  ])('refuses submap high byte %s, which names no slot', (_hex, high) => {
    const rom = buildRom({ 0x400: 0x6e })
    rom.rom.writeAt(0x05d8b4, [high])
    const result = derive(rom)
    expect(result.roots).toBeNull()
    expect(result.notes[0]).toContain('$05D8B4')
  })

  it('follows CODE_04DC09 and the walk into another bank', () => {
    const rom = buildRom({ 0x00: 0x6e })
    rom.rom.writeAt(0x06dc57, [...rom.rom.readAt(0x04dc57, 19)!])
    rom.rom.writeAt(0x06d7f2, [...rom.rom.readAt(0x04d7f2, 43 + 31 + 19)!])
    rom.rom.writeAt(0x04dc57, [0xea]) // the bank-4 call no longer matches
    rom.rom.writeAt(0x04d832, [0xea]) // nor does the bank-4 walk
    expect(derive(rom).entrances.map(e => e.translevel)).toEqual([1])
  })

  it('refuses NOP-filled spans under the stock fingerprints', () => {
    for (const o of [OVERWORLD_INDEX_BODY, OVERWORLD_INDEX_BODY.fingerprints]) {
      expect(Object.isFrozen(o)).toBe(true)
    }
    const rom = buildRom({ 0x00: 0x6e })
    const entry = deriveOverworldEntrances(rom)
    expect(entry.roots).toBeNull()
    expect(entry.notes[0]).toContain('$05D83E')
    const walk = deriveOverworldEntrances(rom, undefined, {
      entry: SYNTHETIC_FINGERPRINTS.entry,
      walk: STOCK_OVERWORLD_FINGERPRINTS.walk,
    })
    expect(walk.roots).toBeNull()
    expect(walk.notes[0]).toContain('CODE_04D7F2')
  })
})

describe('deriveOverworldEntrances: roots', () => {
  const tiles = (main: number, sub: number): Record<number, number> => {
    const out: Record<number, number> = {}
    for (let i = 0; i < main; i++) out[i] = 0x6e
    for (let i = 0; i < sub; i++) out[0x400 + i] = 0x6e
    return out
  }

  it('reads each range from the slots its own buffer half produced', () => {
    // Translevels 1-5 main, 6-8 sub: none reaches the stock $25 threshold.
    const result = deriveOverworldEntrances(
      buildRom(tiles(5, 3)),
      undefined,
      SYNTHETIC_FINGERPRINTS,
    )
    expect(result.roots).toEqual({
      main: new Set([1, 2, 3, 4, 5]),
      sub: new Set([0x106, 0x107, 0x108]),
    })
  })

  it("takes Lunar Magic's high byte from the translevel, with the routine's own bias", () => {
    // Threshold $04, bias $01: main 1,2 -> $001,$002; sub 3 stays $003, sub 4,5 -> $103,$104.
    const rom = buildRom(tiles(2, 3))
    plantLmEntryHook(rom.rom, { threshold: 0x04, bias: 0x01 })
    const result = derive(rom)
    expect(result.entrances.map(e => [e.translevel, e.layout, e.slot])).toEqual([
      [1, 0, 0x001],
      [2, 0, 0x002],
      [3, 1, 0x003],
      [4, 1, 0x103],
      [5, 1, 0x104],
    ])
    expect(result.roots).toEqual({ main: new Set([1, 2]), sub: new Set([3, 0x103, 0x104]) })
  })

  it('notes main-map entrances biased onto lower slots only for the stock high byte', () => {
    const biasNote = (rom: SmwRom): boolean =>
      derive(rom).notes.some(n => n.includes('main-map entrances have a translevel'))
    const stock = buildRom(tiles(5, 0))
    stock.rom.writeAt(0x05d8a2, [0xc9, 0x04])
    const hooked = buildRom(tiles(5, 0))
    plantLmEntryHook(hooked.rom, { threshold: 0x04, bias: 0x01 })
    expect([biasNote(stock), biasNote(hooked)]).toEqual([true, false])
  })

  it('applies the bias the ROM holds, not the stock $25/$24', () => {
    // Threshold $04, bias $03: sub translevels 3,4,5,6 -> $103,$101,$102,$103.
    const rom = buildRom(tiles(2, 4))
    rom.rom.writeAt(0x05d8a2, [0xc9, 0x04, 0x90, 0x03, 0x38, 0xe9, 0x03])
    expect(derive(rom).roots).toEqual({
      main: new Set([1, 2]),
      sub: new Set([0x101, 0x102, 0x103]),
    })
  })

  it('roots sub-map tiles numbered below the bias threshold', () => {
    // No main-map tiles: 20 sub translevels 1-20 -> $101-$114, none biased.
    const roots = deriveOverworldEntrances(
      buildRom(tiles(0, 20)),
      undefined,
      SYNTHETIC_FINGERPRINTS,
    ).roots
    expect(roots!.main.size).toBe(0)
    for (let s = 0x101; s <= 0x114; s++) expect(isOverworldLevel(s, roots)).toBe(true)
    expect(isOverworldLevel(0x000, roots)).toBe(false)
  })

  it('keeps main-map translevels out of the submap range, and leaves it empty without sub tiles', () => {
    const roots = deriveOverworldEntrances(
      buildRom(tiles(50, 0)),
      undefined,
      SYNTHETIC_FINGERPRINTS,
    ).roots
    expect(Math.max(...roots!.main)).toBe(0x024)
    for (let s = 0x100; s < 0x200; s++) expect(isOverworldLevel(s, roots)).toBe(false)
  })

  it('roots only the walked slots: slot $000 and a gap in the numbering are not roots', () => {
    // Threshold $03, bias $FE: translevels 1-4 land on $001, $002, $005, $006.
    const rom = buildRom(tiles(4, 0))
    rom.rom.writeAt(0x05d8a2, [0xc9, 0x03, 0x90, 0x03, 0x38, 0xe9, 0xfe])
    const roots = derive(rom).roots
    expect(roots!.main).toEqual(new Set([1, 2, 5, 6]))
    for (const s of [0x000, 0x003, 0x004]) expect(isOverworldLevel(s, roots)).toBe(false)
  })

  it('reports roots null, never the stock range, when the overworld is unreadable', () => {
    const rom = buildRom({ 0x00: 0x6e }, { probe: 0x22 })
    const result = derive(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.roots).toBeNull()
  })
})

describe('deriveOverworldEntrances: fail closed', () => {
  it('reports the derivation unavailable when $05D8B1 is not the stock $F0', () => {
    const rom = buildRom({ 0x00: 0x6e, 0x01: 0x6e }, { probe: 0x22 })
    const result = derive(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.entryMaps).toEqual([])
    expect(result.entrances).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('another editor')
    expect(result.notes[0]).toContain('unmodified ROM')
  })

  it.each([
    ['the JSL into CODE_05D796', 0x0096f7, 0x06],
    ['the JMP to CODE_05D83E', 0x05d7b0, 0x5c],
  ])('reports the derivation unavailable when %s is replaced', (_what, at, byte) => {
    const rom = buildRom({ 0x00: 0x6e })
    rom.rom.writeAt(at, [byte])
    expect(derive(rom).overworldReadable).toBe(false)
  })

  it('treats an unreadable probe byte as a failed probe, not as a read stream', () => {
    // A 64 KB image is a valid LoROM header-wise but has neither bank $05
    // nor bank $0C, so readByte($05D8B1) is null. This test used to claim
    // it covered the tile-stream branch; it never reached it, because the
    // probe compare rejects null first. Asserting the note text is what
    // stops that going unnoticed again.
    const buf = Buffer.alloc(0x10000, 0)
    buf[0x7fd5] = 0x20
    // The stock JSL at $0096F4 is in bank $00, so the check reaches bank $05.
    buf.set([0x22, 0x96, 0xd7, 0x05], 0x16f4)
    const rom = new SmwRom(new RomFile('tiny.sfc', buf))
    expect(rom.rom.readByte(OW_ENTRY_BEQ)).toBeNull()
    const result = derive(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.entrances).toEqual([])
    expect(result.entryMaps).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('another editor')
    expect(result.notes[0]).toContain('nothing readable')
  })

  it('reports the derivation unavailable when the tile stream cannot be read', () => {
    // 256 KB is the window where the two branches separate: bank $05 exists
    // so the probe reads the stock $F0, bank $0C does not, so OWL1TileData
    // is out of range. Anything smaller trips the probe branch instead.
    const buf = Buffer.alloc(0x40000, 0)
    buf[0x7fd5] = 0x20
    plantStockSubmapCode(new RomFile('truncated.sfc', buf))
    const rom = new SmwRom(new RomFile('truncated.sfc', buf))
    expect(rom.rom.readByte(OW_ENTRY_BEQ)).toBe(0xf0)
    const result = derive(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.entrances).toEqual([])
    expect(result.entryMaps).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('Layer-1 tile stream')
    expect(result.notes[0]).not.toContain('another editor')
  })
})
