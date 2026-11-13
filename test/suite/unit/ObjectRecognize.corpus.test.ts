/**
 * Finding Objects on real maps (#1237 acceptance 8 and 9, and the refusal of maps with per-map tiles).
 * Gated on the corpus with describe.skipIf: with no ROM these register as skipped, never as absent.
 * The definitions are derived at runtime from each map's own stored pieces, never typed (D127).
 */
import { beforeAll, describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { buildL1Inputs } from '../../../src/rom/model/L1Model'
import { SWITCH_FLAGS_UNCLEARED } from '../../../src/rom/ObjectExpander'
import {
  objectsRefusal,
  PER_LEVEL_MAP16,
  readObjectInputs,
  slopeClassOf,
} from '../../../src/rom/objects/ObjectInputs'
import { recognizeObjects, type FinderDefinition } from '../../../src/rom/objects/Recognize'
import { hasRom, romPath, VANILLA, INVICTUS } from '../support/corpus'

const rom = () => new SmwRom(RomFile.load(romPath(VANILLA)))
const SCREEN_W = 16
/** The ground runs along row 24 and below: the platforms are the pieces above it. */
const GROUND_ROW = 24

/** Tiles the stored pieces of one object number wrote on screen 0 of a map, above the ground: the definition's raw material. */
function tilesOfPieces(
  map: SmwRom,
  slot: number,
  objectNumber: number,
  inputs: { footprint: { owner: number; tile: number }[] },
): number[] {
  // prettier-ignore
  const raw = map.getLevelRawData(slot)!
  const table = map.getVerticalTable()
  if (!table.ok) throw new Error(table.reason)
  const { objects } = parseLevelObjects(raw, table.table)
  const tiles = new Set<number>()
  for (const f of inputs.footprint) {
    const o = objects[f.owner]!
    if (
      o.type === 'standard' &&
      o.objectNumber === objectNumber &&
      o.x < SCREEN_W &&
      o.y < GROUND_ROW
    )
      tiles.add(f.tile)
  }
  return [...tiles]
}

describe.skipIf(!hasRom(VANILLA))('Objects on $103 screen 0 (acceptance 8)', () => {
  // Set up in beforeAll: a skipped describe body still runs, and there is no ROM to read then.
  let map: SmwRom
  let inputs: Extract<ReturnType<typeof readObjectInputs>, { ok: true }>
  let edge: number[]
  let fill: number[]
  let definition: FinderDefinition
  beforeAll(() => {
    map = rom()
    const read = readObjectInputs(map, 0x103, SWITCH_FLAGS_UNCLEARED)
    if (!read.ok) throw new Error(read.reason)
    inputs = read
    edge = tilesOfPieces(map, 0x103, 0x13, inputs)
    fill = tilesOfPieces(map, 0x103, 0x14, inputs).filter(t => !edge.includes(t))
    definition = { id: 'ledge', name: 'Ledge', tileset: inputs.tileset, edge, fill }
  })

  it('the definition came out of the map, with edge and fill tiles both present', () => {
    expect(edge.length).toBeGreaterThan(0)
    expect(fill.length).toBeGreaterThan(0)
  })

  it('finds the four stacked platforms, each its three stored pieces, none merged', () => {
    const found = recognizeObjects(inputs, [definition])
    const onScreen0 = found.filter(f => f.cells.every(c => c.col < SCREEN_W))
    expect(onScreen0).toHaveLength(4)
    // Each of the twelve edge and interior pieces lands in exactly one Object, three to an Object.
    const raw = map.getLevelRawData(0x103)!
    const table = map.getVerticalTable()
    if (!table.ok) throw new Error(table.reason)
    const { objects } = parseLevelObjects(raw, table.table)
    const platformPieces = objects
      .map((o, i) => ({ o, i }))
      .filter(
        ({ o }) =>
          o.type === 'standard' &&
          (o.objectNumber === 0x13 || o.objectNumber === 0x14) &&
          o.x < SCREEN_W &&
          o.y < GROUND_ROW,
      ) // prettier-ignore
      .map(({ i }) => i)
    expect(platformPieces).toHaveLength(12)
    const own = (piece: number) => {
      const cells: [number, number][] = []
      inputs.owners.forEach((row, r) => row.forEach((o, c) => o === piece && cells.push([r, c])))
      return cells
    }
    const home = platformPieces.map(p => {
      const cells = own(p)
      expect(cells.length).toBeGreaterThan(0)
      const homes = onScreen0.filter(f => cells.every(([r, c]) => f.cells.some(x => x.row === r && x.col === c && x.visible))) // prettier-ignore
      expect(homes, `piece ${p}`).toHaveLength(1)
      return onScreen0.indexOf(homes[0]!)
    })
    for (let k = 0; k < 4; k++) expect(home.filter(h => h === k)).toHaveLength(3)
  })

  it('planted: with the stored-piece split dropped the platforms merge and the count of four is lost', () => {
    const found = recognizeObjects(inputs, [definition], { splitPieces: false })
    expect(found.filter(f => f.cells.every(c => c.col < SCREEN_W))).not.toHaveLength(4)
  })

  it('a covered part is found: some Object has cells another Object draws over', () => {
    const found = recognizeObjects(inputs, [definition]).filter(f => f.cells.every(c => c.col < SCREEN_W)) // prettier-ignore
    expect(found.some(f => f.cells.some(c => !c.visible))).toBe(true)
  })

  it('reads the same visible grid the map view draws', () => {
    const built = buildL1Inputs(map, 0x103, SWITCH_FLAGS_UNCLEARED)
    if (!built.ok) throw new Error(built.reason)
    expect(inputs.grid).toEqual(built.inputs.grid)
  })
})

describe.skipIf(!hasRom(VANILLA))('Objects on the largest vanilla map (acceptance 9)', () => {
  it('finds Objects on $105 (20 screens) from a definition derived from its own pieces, quickly', () => {
    const map = rom()
    const inputs = readObjectInputs(map, 0x105, SWITCH_FLAGS_UNCLEARED)
    if (!inputs.ok) throw new Error(inputs.reason)
    // The most written tile is the fill; its neighbors in the grid that are not it are the edge.
    const counts = new Map<number, number>()
    for (const f of inputs.footprint) counts.set(f.tile, (counts.get(f.tile) ?? 0) + 1)
    const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t)
    const definition: FinderDefinition = { id: 'x', name: 'X', tileset: inputs.tileset, edge: ranked.slice(1, 8), fill: ranked.slice(0, 1) } // prettier-ignore
    expect(inputs.grid[0]!.length).toBeGreaterThanOrEqual(20 * SCREEN_W)
    const t0 = performance.now()
    const found = recognizeObjects(inputs, [definition])
    const ms = performance.now() - t0
    console.info(`recognizeObjects on $105: ${found.length} Objects, ${ms.toFixed(1)} ms (one run, one machine)`) // prettier-ignore
    expect(found.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(500)
  })
})

describe.skipIf(!hasRom(VANILLA))('slope classes come from the game own tables', () => {
  it('some tiles of the grass tileset are slopes, rising both ways, and a plain block is not', () => {
    const slopeOf = slopeClassOf(RomFile.load(romPath(VANILLA)), 0)
    const classes = Array.from({ length: 512 }, (_, t) => slopeOf(t)).filter(c => c !== null) as number[] // prettier-ignore
    expect(classes.some(c => c > 0)).toBe(true)
    expect(classes.some(c => c < 0)).toBe(true)
    expect(slopeOf(0x25)).toBeNull()
  })
})

describe.skipIf(!hasRom(VANILLA))('a stock ROM can have Objects found', () => {
  it('objectsRefusal is null on the vanilla ROM', () => {
    expect(objectsRefusal(RomFile.load(romPath(VANILLA)))).toBeNull()
  })
})

describe.skipIf(!hasRom(INVICTUS))('a hack with per-map tiles refuses in plain words', () => {
  it('Invictus', () => {
    expect(objectsRefusal(RomFile.load(romPath(INVICTUS)))).toBe(PER_LEVEL_MAP16)
    const r = readObjectInputs(new SmwRom(RomFile.load(romPath(INVICTUS))), 0x105, SWITCH_FLAGS_UNCLEARED) // prettier-ignore
    expect(r).toEqual({ ok: false, reason: PER_LEVEL_MAP16 })
  })
})
