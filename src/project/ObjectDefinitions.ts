/**
 * Object definitions: `meta/objects/<id>.json`, one file per definition.
 * The format and the reader and writer rules are in
 * docs/architecture/object-definitions.md; this file is that page in code.
 *
 * No VS Code or Theia imports, same rule as the rest of src/project/.
 * Nothing here touches the ROM, the working copy or ops/.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { metaFolder } from './ProjectMeta'
import { writeFileAtomic } from './atomicWrite'

export const OBJECTS_FOLDER = 'objects'
export const OBJECT_FILE_MAX_BYTES = 64 * 1024
export const OBJECT_ID_MAX_LENGTH = 64
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface ObjectDefinition {
  version: 1
  id: string
  name: string
  /** The level header's foreground tileset. */
  tileset: number
  /** Sorted, unique Map16 tile numbers. */
  edge: number[]
  /** Sorted, unique, and disjoint from `edge`. */
  fill: number[]
}

/** What the ROM allows; `unavailable` means no tile can be checked, so nothing loads. */
export interface ObjectLimits {
  tilesetCount: number
  tileCount: number
  unavailable?: string
}

export interface SkippedObjectFile {
  file: string
  reason: string
}

export interface ReadObjectsResult {
  definitions: ObjectDefinition[]
  skipped: SkippedObjectFile[]
}

export interface ObjectDraft {
  /** Absent on a first save; the writer makes one. */
  id?: string
  name: string
  tileset: number
  edge: number[]
  fill: number[]
}

export type ObjectWriteResult =
  | { status: 'ok'; definition: ObjectDefinition }
  | { status: 'invalid'; reason: string }
  | { status: 'not-found'; reason: string }
  | { status: 'io-error'; reason: string }

export type ObjectDeleteResult =
  | { status: 'ok' }
  | { status: 'invalid'; reason: string }
  | { status: 'not-found'; reason: string }
  | { status: 'io-error'; reason: string }

export function objectsDir(projectDir: string): string {
  return metaFolder(projectDir, OBJECTS_FOLDER)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tileList(value: unknown, field: string, limits: ObjectLimits): number[] | string {
  if (!Array.isArray(value)) return `"${field}" is not a list of tile numbers.`
  for (const t of value) {
    if (typeof t !== 'number' || !Number.isInteger(t)) {
      return `"${field}" holds something that is not a whole tile number.`
    }
    if (t < 0 || t >= limits.tileCount) {
      return `Tile number ${t} in "${field}" is not in this ROM's Map16 (0 to ${limits.tileCount - 1}).`
    }
  }
  return [...new Set(value as number[])].sort((a, b) => a - b)
}

/**
 * Checks a parsed definition against the doc's rules 2 to 7. `stem` is the
 * file name without `.json`; the id must equal it. Returns the definition with
 * its lists as sorted sets, or the reason in plain words.
 */
function validate(
  raw: unknown,
  stem: string,
  limits: ObjectLimits,
): { definition: ObjectDefinition; extras: Record<string, unknown> } | string {
  if (!isPlainObject(raw)) return 'The file does not hold one Object definition.'
  if (limits.unavailable) return limits.unavailable
  if (raw.version === undefined) return 'The file has no version.'
  if (raw.version !== 1) {
    return typeof raw.version === 'number' && raw.version > 1
      ? 'This Object was saved by a newer HackBench.'
      : `The file's version (${String(raw.version)}) is not one this HackBench knows.`
  }
  const { id, name, tileset } = raw
  if (typeof id !== 'string' || id.length > OBJECT_ID_MAX_LENGTH || !ID_PATTERN.test(id)) {
    return 'The file has no usable id.'
  }
  if (id !== stem) return `The id "${id}" does not match the file name.`
  if (typeof name !== 'string' || name.trim() === '') return 'The file has no name.'
  if (typeof tileset !== 'number' || !Number.isInteger(tileset)) {
    return 'The file has no whole-number tileset.'
  }
  const edge = tileList(raw.edge, 'edge', limits)
  if (typeof edge === 'string') return edge
  const fill = tileList(raw.fill, 'fill', limits)
  if (typeof fill === 'string') return fill
  const inEdge = new Set(edge)
  const both = fill.find(t => inEdge.has(t))
  if (both !== undefined) return `Tile number ${both} is tagged as both edge and fill.`
  if (tileset < 0 || tileset >= limits.tilesetCount) {
    return `Tileset ${tileset} is not one this ROM has (0 to ${limits.tilesetCount - 1}).`
  }
  const known = new Set(['version', 'id', 'name', 'tileset', 'edge', 'fill'])
  const extras = Object.fromEntries(Object.entries(raw).filter(([k]) => !known.has(k)))
  return { definition: { version: 1, id, name, tileset, edge, fill }, extras }
}

type FileRead =
  | { ok: true; definition: ObjectDefinition; extras: Record<string, unknown> }
  | { ok: false; reason: string }

function readOne(file: string, stem: string, limits: ObjectLimits): FileRead {
  try {
    if (fs.statSync(file).size > OBJECT_FILE_MAX_BYTES) {
      return { ok: false, reason: 'The file is larger than 64 KB.' }
    }
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return { ok: false, reason: 'The file is not readable JSON.' }
    }
    const v = validate(raw, stem, limits)
    return typeof v === 'string' ? { ok: false, reason: v } : { ok: true, ...v }
  } catch (err) {
    return { ok: false, reason: `The file could not be opened: ${errText(err)}` }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Every `*.json` directly in meta/objects/. A bad file is skipped with a
 * reason, never repaired or rewritten; reading writes nothing. A missing
 * folder is no definitions.
 */
export function readObjectDefinitions(projectDir: string, limits: ObjectLimits): ReadObjectsResult {
  const dir = objectsDir(projectDir)
  const result: ReadObjectsResult = { definitions: [], skipped: [] }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result
    result.skipped.push({
      file: OBJECTS_FOLDER,
      reason: `The Objects folder could not be read: ${errText(err)}`,
    })
    return result
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    const r = readOne(path.join(dir, e.name), e.name.slice(0, -'.json'.length), limits)
    if (r.ok) result.definitions.push(r.definition)
    else result.skipped.push({ file: e.name, reason: r.reason })
  }
  result.definitions.sort(
    (a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return result
}

function newId(dir: string): string {
  for (;;) {
    const id = crypto.randomBytes(4).toString('hex')
    if (!fs.existsSync(path.join(dir, `${id}.json`))) return id
  }
}

function write(
  dir: string,
  definition: ObjectDefinition,
  extras: Record<string, unknown>,
): ObjectWriteResult {
  try {
    fs.mkdirSync(dir, { recursive: true })
    // Key order of the doc's example, extras after.
    const ordered = {
      version: definition.version,
      id: definition.id,
      name: definition.name,
      tileset: definition.tileset,
      edge: definition.edge,
      fill: definition.fill,
      ...extras,
    }
    writeFileAtomic(
      path.join(dir, `${definition.id}.json`),
      `${JSON.stringify(ordered, null, 2)}\n`,
    )
    return { status: 'ok', definition }
  } catch (err) {
    return { status: 'io-error', reason: `The Object could not be saved: ${errText(err)}` }
  }
}

/**
 * Saves one definition. With an id it replaces that file, unless the file is
 * there and cannot be read (then it is refused, and the file stays as found);
 * without one it makes a new id. Overlap is refused, never resolved.
 */
export function saveObjectDefinition(
  projectDir: string,
  limits: ObjectLimits,
  draft: ObjectDraft,
): ObjectWriteResult {
  const dir = objectsDir(projectDir)
  const id = draft.id ?? newId(dir)
  if (!ID_PATTERN.test(id) || id.length > OBJECT_ID_MAX_LENGTH) {
    return { status: 'invalid', reason: 'That is not a usable Object id.' }
  }
  const v = validate({ ...draft, version: 1, id, name: draft.name.trim() }, id, limits)
  if (typeof v === 'string') return { status: 'invalid', reason: v }

  let extras: Record<string, unknown> = {}
  const file = path.join(dir, `${id}.json`)
  if (fs.existsSync(file)) {
    const old = readOne(file, id, limits)
    if (!old.ok) {
      return {
        status: 'invalid',
        reason: `The saved file for this Object could not be read (${old.reason}) so it was not replaced. Delete it, or save under another name.`,
      }
    }
    extras = old.extras
  }
  return write(dir, v.definition, extras)
}

/** Rewrites `name` in the same file; the id, tileset and tags stay as stored. */
export function renameObjectDefinition(
  projectDir: string,
  limits: ObjectLimits,
  id: string,
  name: string,
): ObjectWriteResult {
  if (!ID_PATTERN.test(id) || id.length > OBJECT_ID_MAX_LENGTH) {
    return { status: 'invalid', reason: 'That is not a usable Object id.' }
  }
  if (name.trim() === '') return { status: 'invalid', reason: 'An Object needs a name.' }
  const dir = objectsDir(projectDir)
  const file = path.join(dir, `${id}.json`)
  if (!fs.existsSync(file)) return { status: 'not-found', reason: 'That Object is not saved.' }
  const old = readOne(file, id, limits)
  if (!old.ok) {
    return {
      status: 'invalid',
      reason: `The saved file for this Object could not be read (${old.reason}) so it was not renamed.`,
    }
  }
  return write(dir, { ...old.definition, name: name.trim() }, old.extras)
}

/** Removes the one file, readable or not; nothing else is touched. */
export function deleteObjectDefinition(projectDir: string, id: string): ObjectDeleteResult {
  if (!ID_PATTERN.test(id) || id.length > OBJECT_ID_MAX_LENGTH) {
    return { status: 'invalid', reason: 'That is not a usable Object id.' }
  }
  const file = path.join(objectsDir(projectDir), `${id}.json`)
  if (!fs.existsSync(file)) return { status: 'not-found', reason: 'That Object is not saved.' }
  try {
    fs.rmSync(file)
    return { status: 'ok' }
  } catch (err) {
    return { status: 'io-error', reason: `The Object could not be deleted: ${errText(err)}` }
  }
}
