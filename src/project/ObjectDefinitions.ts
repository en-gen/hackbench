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

function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length <= OBJECT_ID_MAX_LENGTH && ID_PATTERN.test(id)
}

/**
 * Names Windows will not make a file of (`con.json` opens the console), in
 * any case. A WRITER rule only: the reader still takes a file with such an
 * id, which cannot exist on Windows anyway.
 */
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Whether the writer may use `id`: the reader's pattern, and not a reserved Windows name. */
export function isWritableId(id: string): boolean {
  return isUsableId(id) && !RESERVED_WINDOWS_NAME.test(id)
}

/**
 * Whether the folder holds exactly `<id>.json`. On a case-insensitive file
 * system `abc12345.json` also opens `ABC12345.json`, which is another file the
 * reader may have skipped; a write or delete must not reach it.
 */
function entryOf(dir: string, id: string): 'exact' | 'other-case' | 'absent' {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 'absent'
  }
  if (names.includes(`${id}.json`)) return 'exact'
  const lower = `${id}.json`.toLowerCase()
  return names.some(n => n.toLowerCase() === lower) ? 'other-case' : 'absent'
}

const OTHER_CASE_REASON =
  'A file with this id exists under different letters (capitals), so it was left alone.'

/** A value from a file, shown in a reason: cut, so a huge one cannot flood the screen. */
function quoted(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 40 ? `${text.slice(0, 40)}...` : text
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
      : `The file's version (${quoted(raw.version)}) is not one this HackBench knows.`
  }
  const { id, name, tileset } = raw
  if (typeof id !== 'string' || !isUsableId(id)) {
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
  | { status: 'ok'; definition: ObjectDefinition; extras: Record<string, unknown> }
  | { status: 'skipped'; reason: string }

function readOne(file: string, stem: string, limits: ObjectLimits): FileRead {
  try {
    if (fs.statSync(file).size > OBJECT_FILE_MAX_BYTES) {
      return { status: 'skipped', reason: 'The file is larger than 64 KB.' }
    }
    const bytes = fs.readFileSync(file)
    // JSON.parse refuses a byte order mark, so the file is skipped either way; this says why.
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return {
        status: 'skipped',
        reason: 'The file was saved with a byte order mark; save it as UTF-8 without one.',
      }
    }
    let raw: unknown
    try {
      raw = JSON.parse(bytes.toString('utf8'))
    } catch {
      return { status: 'skipped', reason: 'The file is not readable JSON.' }
    }
    const v = validate(raw, stem, limits)
    return typeof v === 'string' ? { status: 'skipped', reason: v } : { status: 'ok', ...v }
  } catch (err) {
    return { status: 'skipped', reason: `The file could not be opened: ${errText(err)}` }
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
    if (r.status === 'ok') result.definitions.push(r.definition)
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
  if (!isWritableId(id)) {
    return { status: 'invalid', reason: 'That is not a usable Object id.' }
  }
  // A name that is not text is refused like a blank one, never thrown at the caller.
  const name = typeof draft.name === 'string' ? draft.name.trim() : draft.name
  const v = validate({ ...draft, version: 1, id, name }, id, limits)
  if (typeof v === 'string') return { status: 'invalid', reason: v }

  let extras: Record<string, unknown> = {}
  const where = entryOf(dir, id)
  if (where === 'other-case') return { status: 'invalid', reason: OTHER_CASE_REASON }
  if (where === 'exact') {
    const old = readOne(path.join(dir, `${id}.json`), id, limits)
    if (old.status === 'skipped') {
      return {
        status: 'invalid',
        reason: `The saved file for this Object could not be read (${old.reason}) so it was not replaced. Remove that file from the list of unreadable files, or save under another name.`,
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
  if (!isUsableId(id)) {
    return { status: 'invalid', reason: 'That is not a usable Object id.' }
  }
  if (typeof name !== 'string' || name.trim() === '') {
    return { status: 'invalid', reason: 'An Object needs a name.' }
  }
  const dir = objectsDir(projectDir)
  const where = entryOf(dir, id)
  if (where === 'other-case') return { status: 'invalid', reason: OTHER_CASE_REASON }
  if (where === 'absent') return { status: 'not-found', reason: 'That Object is not saved.' }
  const old = readOne(path.join(dir, `${id}.json`), id, limits)
  if (old.status === 'skipped') {
    return {
      status: 'invalid',
      reason: `The saved file for this Object could not be read (${old.reason}) so it was not renamed.`,
    }
  }
  return write(dir, { ...old.definition, name: name.trim() }, old.extras)
}

/** Removes the one file, readable or not, with no ROM read; nothing else is touched. */
export function deleteObjectDefinition(projectDir: string, id: string): ObjectDeleteResult {
  if (!isUsableId(id)) {
    return { status: 'invalid', reason: 'That is not a usable Object id.' }
  }
  const dir = objectsDir(projectDir)
  const where = entryOf(dir, id)
  if (where === 'other-case') return { status: 'invalid', reason: OTHER_CASE_REASON }
  if (where === 'absent') return { status: 'not-found', reason: 'That Object is not saved.' }
  try {
    fs.rmSync(path.join(dir, `${id}.json`))
    return { status: 'ok' }
  } catch (err) {
    return { status: 'io-error', reason: `The Object could not be deleted: ${errText(err)}` }
  }
}
