/**
 * Object definitions derived at runtime from a map own stored pieces (#1237, D127: no literal tile
 * tables). Used by the corpus tests and, bundled, by the Playwright spec, which writes the result into
 * the test project meta/objects/ in the saved format (#1236). Reads the ROM file directly: a test seam,
 * not a product path.
 */
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { SWITCH_FLAGS_UNCLEARED } from '../../../src/rom/ObjectExpander'
import { buildOutline } from '../../../src/rom/objects/Outline'
import { readObjectInputs, slopeClassOf } from '../../../src/rom/objects/ObjectInputs'
import { recognizeObjects } from '../../../src/rom/objects/Recognize'

export interface SavedDefinition {
  version: 1
  id: string
  name: string
  tileset: number
  edge: number[]
  fill: number[]
}

const SCREEN_W = 16
/** The ground runs along row 24 and below: the platforms of $103 are the pieces above it. */
const GROUND_ROW = 24
const EMPTY = 0x25

/** The stored pieces of one map: each piece object number, anchor and the tiles it wrote. */
function piecesOf(map: SmwRom, slot: number) {
  const inputs = readObjectInputs(map, slot, SWITCH_FLAGS_UNCLEARED)
  if (!inputs.ok) throw new Error(inputs.reason)
  const table = map.getVerticalTable()
  if (!table.ok) throw new Error(table.reason)
  const { objects } = parseLevelObjects(map.getLevelRawData(slot)!, table.table)
  return { inputs, objects }
}

/**
 * The ledge definition of the four stacked platforms on $103 screen 0: edge tiles from its $13 pieces,
 * fill tiles from its $14 pieces, above the ground (#1237 acceptance 8).
 */
export function platformDefinition(romFile: string): SavedDefinition {
  const map = new SmwRom(RomFile.load(romFile))
  const { inputs, objects } = piecesOf(map, 0x103)
  const tilesOf = (n: number) => [...new Set(inputs.footprint.filter(f => {
    const o = objects[f.owner]!
    return o.type === 'standard' && o.objectNumber === n && o.x < SCREEN_W && o.y < GROUND_ROW
  }).map(f => f.tile))] // prettier-ignore
  const edge = tilesOf(0x13)
  const fill = tilesOf(0x14).filter(t => !edge.includes(t))
  return { version: 1, id: 'ledge', name: 'Ledge', tileset: inputs.tileset, edge, fill }
}

/**
 * A vanilla map with a ground Object whose outline has both a slope run and a straight side: a stored
 * piece that wrote slope tiles (by the game own slope tables) and other tiles, taken as a definition
 * whose edge tiles are the slope tiles and whose fill tiles are the rest. The first map found.
 */
export function slopeCase(
  romFile: string,
): { slot: number; definition: SavedDefinition } | undefined {
  // prettier-ignore
  const rom = RomFile.load(romFile)
  const map = new SmwRom(rom)
  for (let slot = 0x105; slot < 0x120; slot++) {
    let found
    try {
      found = piecesOf(map, slot)
    } catch {
      continue
    }
    const { inputs } = found
    const slopeOf = slopeClassOf(rom, inputs.tileset)
    const byPiece = new Map<number, Set<number>>()
    for (const f of inputs.footprint) {
      const s = byPiece.get(f.owner) ?? new Set<number>()
      s.add(f.tile)
      byPiece.set(f.owner, s)
    }
    for (const [, tiles] of byPiece) {
      const edge = [...tiles].filter(t => slopeOf(t) !== null)
      const fill = [...tiles].filter(t => slopeOf(t) === null && t !== EMPTY)
      if (edge.length === 0 || fill.length === 0) continue
      const definition: SavedDefinition = { version: 1, id: 'slope-ground', name: 'Sloped ground', tileset: inputs.tileset, edge, fill } // prettier-ignore
      for (const o of recognizeObjects(inputs, [definition])) {
        const segs = buildOutline(o.cells, slopeOf).segments
        if (segs.some(s => s.kind === 'slope') && segs.some(s => s.kind === 'straight'))
          return { slot, definition }
      }
    }
  }
  return undefined
}
