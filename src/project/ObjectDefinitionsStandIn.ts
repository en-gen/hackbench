/**
 * STAND-IN for `src/project/ObjectDefinitions.ts` (#1236). Replaced when #1236 merges: the swap is one
 * import change, because the name, signature and return shape below are the ones #1236's contract fixes
 * (docs/objects-format: one file per definition at `meta/objects/<id>.json`).
 *
 * Reads only; never writes, repairs or deletes. A damaged file is skipped with a plain reason and the
 * others still load. Unknown fields are ignored. A missing folder is "no definitions".
 * No shell imports, same rule as the rest of src/project/.
 */
import * as fs from 'fs'
import * as path from 'path'

export interface ObjectDefinition {
  id: string
  name: string
  /** The level header's foreground (object) tileset. */
  tileset: number
  /** Map16 numbers tagged as edge; a set. */
  edge: number[]
  /** Map16 numbers tagged as fill; a set, disjoint from edge. */
  fill: number[]
}

export interface ObjectDefinitionLimits {
  /** 15 on a stock ROM: tilesets are 0..count-1. */
  tilesetCount: number
  /** The ROM's Map16 tile count, or null when it cannot be read (every file is then skipped). */
  tileCount: number | null
}

export interface ObjectDefinitionsRead {
  definitions: ObjectDefinition[]
  skipped: { file: string; reason: string }[]
}

const NO_TILE_COUNT = "this ROM's Map16 tile count cannot be read"
const MAX_BYTES = 64 * 1024
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** `meta/objects/` of a project; a folder path helper, since ProjectMeta's concerns are single files. */
export function objectsDir(manifestPath: string): string {
  return path.join(path.dirname(manifestPath), 'meta', 'objects')
}

/** The plain reason a parsed file is unusable, or the definition. */
function check(
  raw: unknown,
  fileId: string,
  limits: ObjectDefinitionLimits,
): ObjectDefinition | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return 'it is not a JSON object'
  const o = raw as Record<string, unknown>
  if (o.version !== 1) {
    return typeof o.version === 'number' && o.version > 1
      ? 'it was made by a newer HackBench'
      : 'its version is missing or unknown'
  }
  if (typeof o.id !== 'string' || o.id.length > 64 || !ID_PATTERN.test(o.id))
    return 'its id is missing or not a valid id'
  if (o.id !== fileId) return 'its id differs from its file name'
  if (typeof o.name !== 'string' || o.name.trim() === '') return 'its name is missing or blank'
  if (typeof o.tileset !== 'number' || !Number.isInteger(o.tileset))
    return 'its tileset is not a whole number'
  if (!Array.isArray(o.edge) || !Array.isArray(o.fill)) return 'its edge or fill list is missing'
  const lists = [o.edge, o.fill]
  if (!lists.every(l => l.every(n => typeof n === 'number' && Number.isInteger(n))))
    return 'a tile number is not a whole number'
  if (o.tileset < 0 || o.tileset >= limits.tilesetCount)
    return "its tileset is outside this ROM's tilesets"
  const edge = o.edge as number[]
  const fill = o.fill as number[]
  if (![...edge, ...fill].every(n => n >= 0 && n < limits.tileCount!))
    return "a tile number is outside this ROM's Map16 tiles"
  const fillSet = new Set(fill)
  if (edge.some(n => fillSet.has(n))) return 'a tile is both an edge and a fill'
  return {
    id: o.id,
    name: o.name,
    tileset: o.tileset,
    edge: [...new Set(edge)],
    fill: [...fillSet],
  }
}

/** Every definition under the project's `meta/objects/`, and the files skipped with why. */
export function readObjectDefinitions(
  manifestPath: string,
  limits: ObjectDefinitionLimits,
): ObjectDefinitionsRead {
  const dir = objectsDir(manifestPath)
  const out: ObjectDefinitionsRead = { definitions: [], skipped: [] }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    const skip = (why: string) => out.skipped.push({ file: e.name, reason: why })
    const file = path.join(dir, e.name)
    // Rule 6: with no tile count nothing can be checked, so every file is skipped with that one reason, first.
    if (limits.tileCount === null) {
      skip(NO_TILE_COUNT)
      continue
    }
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        skip('it is larger than 64 KiB')
        continue
      }
      const res = check(JSON.parse(fs.readFileSync(file, 'utf8')), e.name.slice(0, -5), limits)
      if (typeof res === 'string') skip(res)
      else out.definitions.push(res)
    } catch {
      skip('it is not readable JSON')
    }
  }
  return out
}
