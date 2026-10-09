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
import { Layer, Op } from './WorkingRom'
import type { GfxCharEdit } from '../rom/GfxLayer'

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

/**
 * One op per line, valid JSON: `JSON.parse` reads it back unchanged. A gfx
 * layer holds one pixel per line instead, and only the pixels the user
 * changed, so it carries no artwork the user did not draw.
 */
function formatLayerFile(layer: Layer): string {
  const head = `{\n  "id": ${JSON.stringify(layer.id)},\n  "label": ${JSON.stringify(layer.label)},\n`
  if (layer.kind === 'unreadable')
    throw new Error(`${layer.id} was never read, so it cannot be written`)
  if (layer.kind === 'gfx') {
    const chars = layer.chars
      .map(c => {
        const lines = c.pixels.map(p => `        ${JSON.stringify(pixel(p))}`).join(',\n')
        return `    {\n      "file": ${c.file},\n      "tile": ${c.tile},\n      "pixels": [\n${lines}\n      ]\n    }`
      })
      .join(',\n')
    return head + `  "kind": "gfx",\n  "chars": [\n${chars}\n  ]\n}\n`
  }
  const opLines = layer.ops.map(o => `    ${JSON.stringify(o)}`).join(',\n')
  return head + `  "ops": [\n${opLines}\n  ]\n` + `}\n`
}

function pixel(p: { x: number; y: number; value: number }): {
  x: number
  y: number
  value: number
} {
  return { x: p.x, y: p.y, value: p.value }
}

const isInt = (v: unknown): boolean => Number.isInteger(v)

/**
 * With `lenient`, a file that is not JSON, or a gfx layer this build cannot
 * read, comes back as an `unreadable` layer rather than throwing. That is
 * for `ops/redo/` only, where it refuses when redone and the project still
 * opens.
 */
function loadFrom(dir: string, lenient = false): Layer[] {
  return layerFiles(dir).map(f => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>
    } catch (err) {
      if (!lenient) throw err
      const reason = `${path.join(dir, f)} is not valid JSON: ${(err as Error).message}`
      return { id: f, label: f, kind: 'unreadable', reason }
    }
    const refuse = (reason: string, id = f, label = f): Layer => {
      if (lenient) return { id, label, kind: 'unreadable', reason }
      throw new Error(reason)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return refuse(`${path.join(dir, f)} is not a layer object`)
    }
    const id = parsed.id as string
    const label = parsed.label as string
    if (parsed.kind !== 'gfx') {
      if (!Array.isArray(parsed.ops))
        return refuse(`${path.join(dir, f)} has no ops list`, id, label)
      return { id, label, ops: parsed.ops as Op[] }
    }
    // Refused whole rather than half-read: a pixel that parses to something
    // else would paint a character the user never drew. The first form held
    // one character at the top level; it reads as a one-element `chars`.
    const raw = Array.isArray(parsed.chars)
      ? (parsed.chars as unknown[])
      : [{ file: parsed.file, tile: parsed.tile, pixels: parsed.pixels }]
    if (raw.length === 0 || !raw.every(isGfxCharEdit))
      return refuse(`${path.join(dir, f)} is not a gfx layer this build understands`, id, label)
    return {
      id,
      label,
      kind: 'gfx',
      chars: (raw as GfxCharEdit[]).map(c => ({
        file: c.file,
        tile: c.tile,
        pixels: c.pixels.map(pixel),
      })),
    }
  })
}

const okPixel = (p: unknown): boolean => {
  const q = p as { x: number; y: number; value: number }
  return typeof q === 'object' && q !== null && isInt(q.x) && isInt(q.y) && isInt(q.value)
}

/**
 * Whether `c` is a character edit a layer file may hold. The one rule behind
 * both reading a layer back and accepting one to write (WorkingRomRegistry.setGfx),
 * so nothing can be written that the next open refuses.
 */
export function isGfxCharEdit(c: unknown): boolean {
  const q = c as { file: number; tile: number; pixels: unknown[] }
  return (
    typeof q === 'object' &&
    q !== null &&
    isInt(q.file) &&
    isInt(q.tile) &&
    Array.isArray(q.pixels) &&
    q.pixels.length > 0 && // a character that changes nothing is not an edit
    q.pixels.every(okPixel)
  )
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
  commitLayer(stageLayer(projectDirectory, layer))
}

/** A layer written under a temp name, not yet part of the stack. */
export interface StagedLayer {
  tmp: string
  final: string
}

/**
 * Writes the next layer as `NNNN.json.tmp`. layerFiles keeps only an exact
 * `.json` suffix, so a staged file (or one a crash leaves behind) is invisible
 * to load and to opsStamp until commitLayer renames it; a later stage at the
 * same index overwrites it.
 */
export function stageLayer(projectDirectory: string, layer: Layer): StagedLayer {
  const dir = opsDir(projectDirectory)
  fs.mkdirSync(dir, { recursive: true })
  const final = path.join(dir, `${String(layerFiles(dir).length).padStart(4, '0')}.json`)
  const tmp = `${final}.tmp`
  fs.writeFileSync(tmp, formatLayerFile(layer), 'utf8')
  return { tmp, final }
}

/** Puts a staged layer on the stack. */
export function commitLayer(staged: StagedLayer): void {
  fs.renameSync(staged.tmp, staged.final)
}

/** Removes a staged layer that will not be committed. */
export function discardStaged(staged: StagedLayer): void {
  fs.unlinkSync(staged.tmp)
}

/** Deletes the top (most recently appended) layer file; see popFrom. */
export function popLayer(projectDirectory: string, expectedId: string): void {
  popFrom(opsDir(projectDirectory), expectedId)
}

/** Every undone layer, oldest-undone first; the LAST is what redo re-applies. */
export function loadRedoLayers(projectDirectory: string): Layer[] {
  return loadFrom(redoDir(projectDirectory), true)
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
