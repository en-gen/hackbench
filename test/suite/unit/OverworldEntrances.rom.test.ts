/**
 * ROM-gated acceptance tests for the overworld entrance derivation.
 *
 * Scope: vanilla only. `Super Mario World (USA).magic.sfc` is the same ROM
 * with a copier header and is included purely to prove the derivation is
 * offset-correct; it must produce an identical result. The four ROMs whose
 * overworld was rebuilt by another editor are here only to prove the
 * fail-closed path, never as count oracles.
 *
 * Every number below is a measurement taken from
 * `Super Mario World (USA).vanilla.sfc`, one file, this ROM revision.
 *
 * Skipped entirely (describe.skipIf) when a ROM is absent, per
 * docs/testing.md - CI never sees ROM-derived bytes, and an it.each over an
 * empty array fails a vitest suite outright.
 */
import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { RomFile } from '../../../src/rom/RomFile'
import { readTranslevelBias } from '../../../src/rom/SubmapFlagGate'
import { getAllLevelNames } from '../../../src/rom/SmwLevelNames'
import { loadOverworldEvents } from '../../../src/rom/OverworldEvents'
import {
  deriveOverworldEntrances,
  readWarpTiles,
  warpPrecursorTiles,
} from '../../../src/rom/OverworldEntrances'
import { MAGIC, VANILLA, hasRom, romPath } from '../support/corpus'

const HEADERED = MAGIC
/** Edited corpus ROMs whose CODE_05D83E is not a recognized build. */
const REBUILT_OVERWORLD: [string, string][] = [
  ['Grand Poo World 2 1.1.sfc', 'rebuilt by another editor'],
  ['Invictus 1.0.sfc', 'rebuilt by another editor'],
]

/** Lunar Magic ROMs read through the entry hook and the stored table, with one
 *  entrance each traced by hand: [bufferIndex, translevel, slot]. */
const LM_OVERWORLD: [string, number, [number, number, number]][] = [
  ['GrandPooWorld_V1.2.sfc', 44, [0x36, 0x26, 0x102]],
  ['Seven_Vanilla_Levels.sfc', 18, [0x42a, 0x07, 0x007]],
]

/** Measured on vanilla: the 77 entry maps an overworld launch tile starts. */
const VANILLA_ENTRY_MAPS = [
  0x001, 0x002, 0x003, 0x004, 0x005, 0x006, 0x007, 0x008, 0x009, 0x00a, 0x00b, 0x00c, 0x00d, 0x00e,
  0x00f, 0x010, 0x011, 0x013, 0x014, 0x015, 0x017, 0x018, 0x01a, 0x01b, 0x01c, 0x01d, 0x01f, 0x020,
  0x021, 0x022, 0x023, 0x024, 0x101, 0x102, 0x103, 0x104, 0x105, 0x106, 0x107, 0x109, 0x10a, 0x10b,
  0x10d, 0x10e, 0x10f, 0x110, 0x111, 0x113, 0x114, 0x115, 0x116, 0x117, 0x118, 0x119, 0x11a, 0x11b,
  0x11c, 0x11d, 0x11e, 0x11f, 0x120, 0x121, 0x122, 0x123, 0x125, 0x126, 0x127, 0x128, 0x12a, 0x12b,
  0x12c, 0x12d, 0x130, 0x132, 0x134, 0x135, 0x136,
]

/** Live $5F star-warp tiles: translevel -> [tileX, tileY] on layout 1. */
const VANILLA_STAR_WARPS: [number, number, number][] = [
  [0x4d, 17, 19],
  [0x52, 23, 22],
  [0x53, 18, 24],
  [0x57, 28, 24],
  [0x5b, 18, 29],
  [0x5c, 28, 29],
]

/** $5A tiles, which an event swaps to $5F: translevel -> [slot, layout,
 *  tileX, tileY, isMap]. Two of them do hold real map data, which is what
 *  made them look like entry maps before the swap table was read. */
const VANILLA_PENDING_WARPS: [number, number, number, number, number, boolean][] = [
  [0x12, 0x012, 0, 16, 15, false],
  [0x16, 0x016, 0, 7, 18, true],
  [0x1e, 0x01e, 0, 20, 16, false],
  [0x2c, 0x108, 1, 0, 14, true],
  [0x30, 0x10c, 1, 20, 3, false],
  [0x48, 0x124, 1, 17, 17, false],
  [0x55, 0x131, 1, 23, 24, false],
]

/** Launch tiles naming a slot that holds only the filler pointer:
 *  translevel -> [slot, layout, tileX, tileY, map16Tile]. */
const VANILLA_EMPTY_TARGETS: [number, number, number, number, number, number][] = [
  [0x19, 0x019, 0, 3, 25, 0x56],
  [0x36, 0x112, 1, 18, 7, 0x78],
]

/** Entrances per inferred sub-map, index 0 (main map) through 6. */
const VANILLA_SUBMAP_COUNTS = [36, 6, 9, 7, 13, 10, 11]

const haveVanilla = hasRom(VANILLA)

// describe.skipIf still RUNS the suite body to collect tests, so the ROM
// must not be opened until a test executes. Memoised so the walk runs once.
let cached: ReturnType<typeof deriveOverworldEntrances> | null = null
const vanilla = (): ReturnType<typeof deriveOverworldEntrances> =>
  (cached ??= deriveOverworldEntrances(SmwRom.open(romPath(VANILLA))))

describe.skipIf(!haveVanilla)('deriveOverworldEntrances on vanilla SMW', () => {
  it('reads the overworld and finds 92 translevel tiles', () => {
    expect(vanilla().overworldReadable).toBe(true)
    expect(vanilla().entrances).toHaveLength(92)
    expect(vanilla().entrances.map(e => e.translevel)).toEqual(
      Array.from({ length: 92 }, (_, i) => i + 1),
    )
  })

  it('starts 77 distinct entry maps from 79 launch tiles', () => {
    const launching = vanilla().entrances.filter(e => e.action === 'map')
    expect(launching).toHaveLength(79)
    expect(vanilla().entryMaps).toEqual(VANILLA_ENTRY_MAPS)
    expect(vanilla().entryMaps).toHaveLength(77)
  })

  it('never lets a translevel tile fall outside $56..$80', () => {
    for (const e of vanilla().entrances) {
      expect(e.map16Tile).toBeGreaterThanOrEqual(0x56)
      expect(e.map16Tile).toBeLessThanOrEqual(0x80)
    }
  })

  it('reads $5A -> $5F as the only warp-producing event swap', () => {
    const rom = SmwRom.open(romPath(VANILLA)).rom
    expect([...warpPrecursorTiles(rom, readWarpTiles(rom)!).entries()]).toEqual([[0x5a, 0x5f]])
  })

  it('diverts the six live $5F star-warp tiles', () => {
    const warps = vanilla().entrances.filter(e => e.action === 'starWarp')
    expect(warps.map(e => [e.translevel, e.tileX, e.tileY])).toEqual(VANILLA_STAR_WARPS)
    expect(warps.every(e => e.map16Tile === 0x5f && e.layout === 1)).toBe(true)
    // No $5B pipe tile exists in vanilla's overworld stream.
    expect(vanilla().entrances.some(e => e.action === 'pipeWarp')).toBe(false)
  })

  it('diverts the seven $5A tiles an event swaps into star warps', () => {
    const pending = vanilla().entrances.filter(e => e.action === 'pendingWarp')
    expect(pending.map(e => [e.translevel, e.slot, e.layout, e.tileX, e.tileY, e.isMap])).toEqual(
      VANILLA_PENDING_WARPS,
    )
    expect(pending.every(e => e.map16Tile === 0x5a)).toBe(true)
    // Kept in the index with their positions, excluded from the entry maps.
    for (const e of pending) expect(vanilla().entryMaps).not.toContain(e.slot)
  })

  it('has an event positioned on every $5A tile, which is why the swap fires', () => {
    // The swap is conditional on an event existing AT that buffer offset:
    // CODE_04DA49 reads DATA_04D85D for its own event index and rewrites
    // only the byte there (bank_04.asm:5409-5425). A $5A with no event on
    // it would stay $5A and would reach OWPU_EnterLevel, which is the one
    // case that would make this rule wrong. On this cart there is none.
    const rom = SmwRom.open(romPath(VANILLA)).rom
    const positions = new Set(loadOverworldEvents(rom).events.map(e => e.primaryOffset))
    const pending = vanilla().entrances.filter(e => e.action === 'pendingWarp')
    expect(pending).toHaveLength(7)
    expect(pending.filter(e => positions.has(e.bufferIndex)).map(e => e.bufferIndex)).toEqual(
      pending.map(e => e.bufferIndex),
    )
    // Offset 0 is DATA_04D85D's unused-slot value, so membership in the set
    // has to mean something: no $5A tile sits at buffer 0.
    expect(pending.some(e => e.bufferIndex === 0)).toBe(false)
  })

  it('names the two launch tiles whose slot holds no map data', () => {
    const empty = vanilla().entrances.filter(e => e.action === 'map' && !e.isMap)
    expect(empty.map(e => [e.translevel, e.slot, e.layout, e.tileX, e.tileY, e.map16Tile])).toEqual(
      VANILLA_EMPTY_TARGETS,
    )
    expect(vanilla().entryMaps).not.toContain(0x019)
    expect(vanilla().entryMaps).not.toContain(0x112)
  })

  it('places the main map in buffer half 0 and the sub-maps in half 1', () => {
    const main = vanilla().entrances.filter(e => e.layout === 0)
    expect(main).toHaveLength(36)
    expect(main.every(e => e.slot <= 0x024 && e.submap === 0)).toBe(true)
    const sub = vanilla().entrances.filter(e => e.layout === 1)
    expect(sub).toHaveLength(56)
    expect(sub.every(e => e.slot >= 0x101 && e.slot <= 0x138)).toBe(true)
  })

  it('locates a known map exactly: Valley Fortress is $111 at (25,5)', () => {
    const entrance = vanilla().entrances.find(e => e.slot === 0x111)
    expect(entrance).toMatchObject({
      translevel: 0x35,
      layout: 1,
      tileX: 25,
      tileY: 5,
      submap: 4,
      map16Tile: 0x58,
      action: 'map',
      isMap: true,
      tileDataAddress: 0x0cf7df + 0x559,
    })
  })

  it('assigns every entrance to a camera-derived sub-map', () => {
    const counts = Array.from(
      { length: 7 },
      (_, i) => vanilla().entrances.filter(e => e.submap === i).length,
    )
    expect(counts).toEqual(VANILLA_SUBMAP_COUNTS)
    expect(vanilla().entrances.filter(e => e.submap === null)).toHaveLength(0)
  })

  it('agrees with the ROM level-name table, which corroborates but cannot prove', () => {
    const names = getAllLevelNames(SmwRom.open(romPath(VANILLA)).rom)
    // Only translevel $36 (slot $112) has neither a name nor map data.
    expect(vanilla().entrances.filter(e => names.has(e.translevel))).toHaveLength(91)
    expect(
      vanilla()
        .entrances.filter(e => !names.has(e.translevel))
        .map(e => e.translevel),
    ).toEqual([0x36])
    // Every $5A and $5F tile is named STAR ROAD, which is corroboration for
    // the swap-table reading but not proof of it.
    const warpNames = new Set(
      vanilla()
        .entrances.filter(e => e.action === 'starWarp' || e.action === 'pendingWarp')
        .map(e => names.get(e.translevel)),
    )
    expect([...warpNames]).toEqual(['STAR ROAD'])
    // A decoded name does not prove a slot holds a map: one empty target
    // carries a name, and it duplicates another translevel's name.
    const namedButEmpty = vanilla().entrances.filter(
      e => names.has(e.translevel) && e.action === 'map' && !e.isMap,
    )
    expect(namedButEmpty.map(e => names.get(e.translevel))).toEqual(["#2 MORTON'S PLAINS"])
  })

  it('emits the tile-census note and the swap-pair note', () => {
    expect(vanilla().notes).toHaveLength(2)
    expect(vanilla().notes[0]).toContain('92 overworld tiles carry a translevel')
    expect(vanilla().notes[0]).toContain('6 are warp tiles')
    expect(vanilla().notes[0]).toContain('7 more are swapped into warp tiles')
    expect(vanilla().notes[0]).toContain('Of the 79 that do, 2 name a slot')
    expect(vanilla().notes[1]).toContain('$5A->$5F')
  })
})

describe.skipIf(!haveVanilla || !hasRom(HEADERED))(
  'copier header does not shift the derivation',
  () => {
    it('gives byte-for-byte the same index as the unheadered ROM', () => {
      const plain = deriveOverworldEntrances(SmwRom.open(romPath(VANILLA)))
      const headered = deriveOverworldEntrances(SmwRom.open(romPath(HEADERED)))
      expect(headered.overworldReadable).toBe(true)
      expect(headered.entrances).toEqual(plain.entrances)
      expect(headered.entryMaps).toEqual(plain.entryMaps)
    })
  },
)

for (const [name, gate] of REBUILT_OVERWORLD) {
  describe.skipIf(!hasRom(name))(`fail closed: ${name}`, () => {
    it('reports the derivation unavailable instead of a vanilla-shaped list', () => {
      const result = deriveOverworldEntrances(SmwRom.open(romPath(name)))
      expect(result.overworldReadable).toBe(false)
      expect(result.entryMaps).toEqual([])
      expect(result.entrances).toEqual([])
      expect(result.notes).toHaveLength(1)
      expect(result.notes[0]).toContain(gate)
    })
  })
}

for (const [name, count, traced] of LM_OVERWORLD) {
  describe.skipIf(!hasRom(name))(`stored translevels: ${name}`, () => {
    it('reads the entrances from the stored table', () => {
      const result = deriveOverworldEntrances(SmwRom.open(romPath(name)))
      expect(result.overworldReadable).toBe(true)
      expect(result.entrances).toHaveLength(count)
      const [bufferIndex, translevel, slot] = traced
      expect(result.entrances.find(e => e.bufferIndex === bufferIndex)).toMatchObject({
        translevel,
        slot,
      })
    })
  })
  describe.skipIf(!hasRom(name))(`entry hook: ${name}`, () => {
    it("reads the mapping from Lunar Magic's routine", () => {
      expect(readTranslevelBias(RomFile.load(romPath(name)))).toEqual({
        ok: true,
        threshold: 0x25,
        bias: 0x24,
        submapHigh: 1,
        high: 'translevel',
      })
    })
  })
}
