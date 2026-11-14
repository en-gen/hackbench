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
import { describeObjects, type ObjectDto } from '../../../src/rom/objects/Describe'

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
      const found = recognizeObjects(inputs, [definition])
      const hasStraight = found.some(o =>
        buildOutline(o.cells, slopeOf).segments.some(sg => sg.kind === 'straight'),
      )
      if (hasStraight && slopeRoom(describeObjects(found, slopeOf))) return { slot, definition }
    }
  }
  return undefined
}

const TILE = 16
function distTo(points: readonly number[], x: number, y: number): number {
  let best = Infinity
  for (let i = 0; i + 3 < points.length; i += 2) {
    const [ax, ay, bx, by] = [points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!]
    const [dx, dy] = [bx - ax, by - ay]
    const l2 = dx * dx + dy * dy
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2))
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
  }
  return best
}
const hasCell = (o: ObjectDto, x: number, y: number) =>
  o.runs.some(r => Math.floor(y / TILE) === r.row && Math.floor(x / TILE) >= r.col && Math.floor(x / TILE) < r.col + r.len) // prettier-ignore

/**
 * Whether some slope segment has room around it for the spec's probe: a point 4 px inside the Object (in the
 * edge band), one 12 px inside (the Object body, past the band) and one 12 px outside, in no Object and past the
 * band. A map whose sloped Objects are only a tile or two across has none; the spec needs one.
 */
function slopeRoom(objects: readonly ObjectDto[]): boolean {
  for (const o of objects)
    for (const seg of o.segments.filter(sg => sg.kind === 'slope'))
      for (let i = 0; i + 3 < seg.points.length; i += 2) {
        const [ax, ay, bx, by] = [
          seg.points[i]!,
          seg.points[i + 1]!,
          seg.points[i + 2]!,
          seg.points[i + 3]!,
        ]
        const [mx, my] = [(ax + bx) / 2, (ay + by) / 2]
        const [nx, ny] = ax === bx ? [1, 0] : [0, 1]
        for (const sgn of [1, -1]) {
          const edge = [mx - sgn * nx * 4, my - sgn * ny * 4] as const
          const deep = [mx - sgn * nx * 12, my - sgn * ny * 12] as const
          const far = [mx + sgn * nx * 12, my + sgn * ny * 12] as const
          const outline = (p: readonly [number, number] | readonly number[]) =>
            Math.min(...o.segments.map(q => distTo(q.points, p[0]!, p[1]!)))
          const others = Math.min(
            ...o.segments.filter(q => q !== seg).map(q => distTo(q.points, edge[0], edge[1])),
          )
          if (
            hasCell(o, edge[0], edge[1]) &&
            hasCell(o, deep[0], deep[1]) &&
            !objects.some(q => hasCell(q, far[0], far[1])) &&
            outline(deep) > 9 &&
            outline(far) > 9 &&
            distTo(seg.points, edge[0], edge[1]) < others
          )
            return true
        }
      }
  return false
}
