/**
 * Persists a WorkingRom's edit layers under a project's `ops/` directory.
 *
 * One file per layer, named by a zero-padded stack index so directory order
 * IS stack order with no separate manifest to drift from it. Each file holds
 * `{ id, label, ops }`, hand-formatted so every op sits on its own line -
 * that is the reviewable unit, and a diff should show exactly the ops that
 * changed.
 *
 * Fully committed: `old`, `address` and `new` are all cartridge-derived hex
 * words (2-3 bytes each), not raw bytes, and carrying `old` is what makes a
 * layer stack portable - a collaborator who clones the project gets working
 * undo without needing the same machine that made the edit. This is a
 * deliberate exception to "no ROM-derived bytes in git": see docs/testing.md
 * and CLAUDE.md's copyright rule, which this trades off in the owner's
 * favour for a few bytes of hex text, not for cartridge images.
 *
 * Layers `undo` takes back off the stack are not deleted: they move to
 * `ops/redo/`, same format and same naming, so a redo survives closing the
 * project. It nests INSIDE `ops/` so everything op-shaped lives under one
 * directory, and the applied-stack reader is unaffected because it filters to
 * `.json` and a directory is not one.
 *
 * `.hbproj` projects predating this feature have no `ops/` directory; reading
 * one back is simply an empty stack, not an error.
 */
import * as fs from 'fs'
import * as path from 'path'
import { Layer } from './WorkingRom'

export const OPS_DIR = 'ops'
/** The undone-layer area, nested inside `ops/`. */
export const REDO_DIR = 'redo'

function opsDir(projectDirectory: string): string {
  return path.join(projectDirectory, OPS_DIR)
}

function redoDir(projectDirectory: string): string {
  return path.join(opsDir(projectDirectory), REDO_DIR)
}

/** Layer files in one area, in stack order. A subdirectory has no extension. */
function layerFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
}

/** One op per line, valid JSON: `JSON.parse` reads it back unchanged. */
function formatLayerFile(layer: Layer): string {
  const opLines = layer.ops.map(o => `    ${JSON.stringify(o)}`).join(',\n')
  return (
    `{\n` +
    `  "id": ${JSON.stringify(layer.id)},\n` +
    `  "label": ${JSON.stringify(layer.label)},\n` +
    `  "ops": [\n${opLines}\n  ]\n` +
    `}\n`
  )
}

function loadFrom(dir: string): Layer[] {
  return layerFiles(dir).map(f => {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Layer
    return { id: parsed.id, label: parsed.label, ops: parsed.ops }
  })
}

function appendTo(dir: string, layer: Layer): void {
  fs.mkdirSync(dir, { recursive: true })
  const index = layerFiles(dir).length
  const file = path.join(dir, `${String(index).padStart(4, '0')}.json`)
  fs.writeFileSync(file, formatLayerFile(layer), 'utf8')
}

/**
 * Deletes the top file only if it holds `expectedId`, the layer the caller
 * just took off in memory. Anything else on top (a pulled layer) is not the
 * caller's to delete, so this throws and leaves the area untouched.
 */
function popFrom(dir: string, expectedId: string): void {
  const files = layerFiles(dir)
  const last = files[files.length - 1]
  const file = last && path.join(dir, last)
  const onDisk = file ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Layer).id : 'nothing'
  if (!file || onDisk !== expectedId) {
    throw new Error(`top of ${dir} is ${onDisk}, not ${expectedId}`)
  }
  fs.unlinkSync(file)
}

export interface OpsStamp {
  /** Name, size and mtime of every file in both areas. */
  key: string
  /** Latest mtime or ctime of any of them, in ms. */
  newest: number
}

/**
 * Stats only, no reads or parses, which is why get() can take it on every
 * request. A changed key means "re-read and compare", not "changed".
 * `newest` is separate from the key because ctime is on a coarse clock on
 * Linux (a same-tick rewrite leaves it unchanged), so it is compared against
 * WHEN the stamp was taken rather than for equality; it is also what a copy
 * preserving mtime (`cp -p`, archive extraction) cannot set.
 */
export function opsStamp(projectDirectory: string): OpsStamp {
  const parts: string[] = []
  let newest = 0
  for (const dir of [opsDir(projectDirectory), redoDir(projectDirectory)]) {
    for (const f of layerFiles(dir)) {
      const st = fs.statSync(path.join(dir, f))
      parts.push(`${f}:${st.size}:${st.mtimeMs}`)
      newest = Math.max(newest, st.mtimeMs, st.ctimeMs)
    }
    parts.push('/')
  }
  return { key: parts.join('|'), newest }
}

/** Every persisted layer, oldest (bottom of stack) first. */
export function loadLayers(projectDirectory: string): Layer[] {
  return loadFrom(opsDir(projectDirectory))
}

/**
 * Write a new layer as the next entry in the stack.
 *
 * The caller is responsible for having already validated the layer against
 * the working copy (WorkingRom.append throws on a stale `old`); this only
 * persists what was already accepted in memory.
 */
export function appendLayer(projectDirectory: string, layer: Layer): void {
  appendTo(opsDir(projectDirectory), layer)
}

/** Deletes the top (most recently appended) layer file; see popFrom. */
export function popLayer(projectDirectory: string, expectedId: string): void {
  popFrom(opsDir(projectDirectory), expectedId)
}

/** Every undone layer, oldest-undone first; the LAST is what redo re-applies. */
export function loadRedoLayers(projectDirectory: string): Layer[] {
  return loadFrom(redoDir(projectDirectory))
}

/** Records a layer `undo` took off the stack, so redo can put it back. */
export function pushRedoLayer(projectDirectory: string, layer: Layer): void {
  appendTo(redoDir(projectDirectory), layer)
}

/** Deletes the most recently undone layer file; see popFrom. */
export function popRedoLayer(projectDirectory: string, expectedId: string): void {
  popFrom(redoDir(projectDirectory), expectedId)
}

/** Ends the redo future, which a new edit does. Safe when there is none. */
export function clearRedo(projectDirectory: string): void {
  fs.rmSync(redoDir(projectDirectory), { recursive: true, force: true })
}
