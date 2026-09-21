/**
 * Synthetic-ROM tests for the overworld entrance derivation.
 *
 * These run in CI (no ROM files involved) and are the mutation oracle for
 * the derivation: the $56..$80 tile range, the sequential translevel
 * counter, CODE_05D8A2's >= $25 subtract, the buffer-half submap gate, the
 * warp and event-swapped-warp classification, and the fail-closed probe
 * each have a test that goes red when that rule is changed. See
 * docs/ideas/level-classification.md.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { loromToOffset } from '../../../src/rom/addressing'
import { OW_ADDR, OW_L1_MAP16_BYTES } from '../../../src/rom/OverworldLoader'
import { OW_EVENT_ADDR } from '../../../src/rom/OverworldEvents'
import {
  deriveOverworldEntrances,
  decodeBufferIndex,
  warpPrecursorTiles,
  OW_PATCH_PROBE_ADDR,
  OW_PATCH_PROBE_STOCK_BYTE,
  SUBMAP_BUFFER_BASE,
} from '../../../src/rom/OverworldEntrances'

const BUF_SIZE = 0x80000
const off = (snes: number): number => loromToOffset(snes, BUF_SIZE)!

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
 * byte, the L1 pointer table, the stock $05D8B1 probe byte, the overworld
 * Layer-1 Map16 stream, and optionally the event tile-swap tables. Every
 * slot gets a distinct real pointer unless listed in `fillerSlots`, so
 * `isMap` is under test control.
 */
function buildRom(tiles: Record<number, number>, opts: RomOpts = {}): SmwRom {
  const buf = Buffer.alloc(BUF_SIZE, 0)
  buf[0x7fd5] = 0x20
  buf[off(OW_PATCH_PROBE_ADDR)] = opts.probe ?? OW_PATCH_PROBE_STOCK_BYTE

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
    expect([...warpPrecursorTiles(rom.rom).entries()]).toEqual([
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
    expect(warpPrecursorTiles(rom.rom).size).toBe(0)
  })
})

describe('deriveOverworldEntrances: the translevel walk', () => {
  it('numbers translevels sequentially from 1 in buffer order', () => {
    const rom = buildRom({ 0x123: 0x6e, 0x010: 0x6e, 0x300: 0x6e })
    const result = deriveOverworldEntrances(rom)
    expect(result.overworldReadable).toBe(true)
    expect(result.entrances.map(e => [e.bufferIndex, e.translevel])).toEqual([
      [0x010, 1],
      [0x123, 2],
      [0x300, 3],
    ])
  })

  it('grants a translevel to exactly the tile range $56..$80', () => {
    const rom = buildRom({ 0x00: 0x55, 0x01: 0x56, 0x02: 0x6e, 0x03: 0x80, 0x04: 0x81, 0x05: 0xff })
    const result = deriveOverworldEntrances(rom)
    expect(result.entrances.map(e => e.bufferIndex)).toEqual([0x01, 0x02, 0x03])
    expect(result.entrances.map(e => e.map16Tile)).toEqual([0x56, 0x6e, 0x80])
  })

  it('reports the exact tile coordinate and the ROM byte that defines it', () => {
    const rom = buildRom({ 0x59b: 0x6e })
    const [entrance] = deriveOverworldEntrances(rom).entrances
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
    const result = deriveOverworldEntrances(buildRom(tiles))
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
    const result = deriveOverworldEntrances(rom)
    expect(result.entrances.map(e => e.translevel)).toEqual([1, 2])
    expect(result.entrances.map(e => e.slot)).toEqual([0x101, 0x102])
  })

  it('applies both gates together for sub-map translevels above $25', () => {
    const tiles: Record<number, number> = {}
    for (let i = 0; i < 0x24; i++) tiles[i] = 0x6e // translevels $01..$24
    tiles[0x400] = 0x6e // translevel $25
    tiles[0x401] = 0x6e // translevel $26
    const result = deriveOverworldEntrances(buildRom(tiles))
    const tail = result.entrances.slice(-2)
    expect(tail.map(e => e.translevel)).toEqual([0x25, 0x26])
    expect(tail.map(e => e.slot)).toEqual([0x101, 0x102])
  })

  it('wraps the translevel counter at $FF, as INC.B does, and says so', () => {
    const tiles: Record<number, number> = {}
    for (let i = 0; i < 0x101; i++) tiles[i] = 0x6e
    const result = deriveOverworldEntrances(buildRom(tiles))
    expect(result.entrances).toHaveLength(0x101)
    expect(result.entrances[0xfe]!.translevel).toBe(0xff)
    expect(result.entrances[0xff]!.translevel).toBe(0x00)
    expect(result.notes.some(n => n.includes('wrapped past $FF'))).toBe(true)
  })
})

describe('deriveOverworldEntrances: what actually starts a map', () => {
  it('classifies $5F as a star warp and $5B as a pipe warp, not maps', () => {
    const rom = buildRom({ 0x00: 0x5b, 0x01: 0x5f, 0x02: 0x6e })
    const result = deriveOverworldEntrances(rom)
    expect(result.entrances.map(e => e.action)).toEqual(['pipeWarp', 'starWarp', 'map'])
    // All three carry a translevel; only the third contributes an entry map.
    expect(result.entrances.map(e => e.translevel)).toEqual([1, 2, 3])
    expect(result.entryMaps).toEqual([0x003])
  })

  it('treats a tile an event swaps into a warp tile as a pending warp', () => {
    const rom = buildRom({ 0x00: 0x5a, 0x01: 0x6e }, { swaps: [[0x5a, 0x5f]] })
    const result = deriveOverworldEntrances(rom)
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
    const result = deriveOverworldEntrances(rom)
    expect(result.entrances.map(e => e.action)).toEqual(['map', 'pendingWarp'])
    expect(result.entryMaps).toEqual([0x001])
  })

  it('leaves a tile alone when its event swap does not produce a warp tile', () => {
    const rom = buildRom({ 0x00: 0x5a }, { swaps: [[0x5a, 0x66]] })
    expect(deriveOverworldEntrances(rom).entrances[0]!.action).toBe('map')
  })

  it('drops entrances whose slot holds the filler L1 pointer', () => {
    const rom = buildRom({ 0x00: 0x6e, 0x01: 0x6e, 0x02: 0x6e }, { fillerSlots: [0x002] })
    const result = deriveOverworldEntrances(rom)
    expect(result.entrances.map(e => e.isMap)).toEqual([true, false, true])
    expect(result.entryMaps).toEqual([0x001, 0x003])
  })

  it('reports each entry map once even when two tiles start the same slot', () => {
    // Two main-map tiles with translevels $01 and $25 collide on slot $001.
    const tiles: Record<number, number> = {}
    for (let i = 0; i < 0x25; i++) tiles[i] = 0x6e
    const result = deriveOverworldEntrances(buildRom(tiles))
    expect(result.entrances.filter(e => e.slot === 0x001)).toHaveLength(2)
    expect(result.entryMaps.filter(m => m === 0x001)).toHaveLength(1)
  })
})

describe('deriveOverworldEntrances: sub-map inference', () => {
  it('reports submap 0 for every main-map entrance', () => {
    const rom = buildRom({ 0x000: 0x6e, 0x3ff: 0x6e })
    expect(deriveOverworldEntrances(rom).entrances.every(e => e.submap === 0)).toBe(true)
  })

  it('places a sub-map tile in the area whose camera window covers it', () => {
    // Area 1's camera is (-16,-16) -> window origin (-1,-1), 16x14 tiles.
    // Areas 2..6 sit at origin (0,0) in this synthetic ROM, so a tile at
    // (0,0) matches area 1 first and a tile at row 15 matches none.
    const rom = buildRom({ 0x400: 0x6e, 0x4f0: 0x6e }, { cameras: true })
    const result = deriveOverworldEntrances(rom)
    expect(result.entrances[0]).toMatchObject({ tileX: 0, tileY: 0, submap: 1 })
    expect(result.entrances[1]).toMatchObject({ tileX: 0, tileY: 15, submap: null })
    expect(result.notes.some(n => n.includes('outside every camera-derived'))).toBe(true)
  })
})

describe('deriveOverworldEntrances: fail closed', () => {
  it('reports the derivation unavailable when $05D8B1 is not the stock $F0', () => {
    const rom = buildRom({ 0x00: 0x6e, 0x01: 0x6e }, { probe: 0x22 })
    const result = deriveOverworldEntrances(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.entryMaps).toEqual([])
    expect(result.entrances).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('another editor')
    expect(result.notes[0]).toContain('unmodified ROM')
  })

  it('treats an unreadable probe byte as a failed probe, not as a read stream', () => {
    // A 64 KB image is a valid LoROM header-wise but has neither bank $05
    // nor bank $0C, so readByte($05D8B1) is null. This test used to claim
    // it covered the tile-stream branch; it never reached it, because the
    // probe compare rejects null first. Asserting the note text is what
    // stops that going unnoticed again.
    const buf = Buffer.alloc(0x10000, 0)
    buf[0x7fd5] = 0x20
    const rom = new SmwRom(new RomFile('tiny.sfc', buf))
    expect(rom.rom.readByte(OW_PATCH_PROBE_ADDR)).toBeNull()
    const result = deriveOverworldEntrances(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.entrances).toEqual([])
    expect(result.entryMaps).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('another editor')
  })

  it('reports the derivation unavailable when the tile stream cannot be read', () => {
    // 256 KB is the window where the two branches separate: bank $05 exists
    // so the probe reads the stock $F0, bank $0C does not, so OWL1TileData
    // is out of range. Anything smaller trips the probe branch instead.
    const buf = Buffer.alloc(0x40000, 0)
    buf[0x7fd5] = 0x20
    buf[off(OW_PATCH_PROBE_ADDR)] = OW_PATCH_PROBE_STOCK_BYTE
    const rom = new SmwRom(new RomFile('truncated.sfc', buf))
    expect(rom.rom.readByte(OW_PATCH_PROBE_ADDR)).toBe(OW_PATCH_PROBE_STOCK_BYTE)
    const result = deriveOverworldEntrances(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.entrances).toEqual([])
    expect(result.entryMaps).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('Layer-1 tile stream')
    expect(result.notes[0]).not.toContain('another editor')
  })
})
