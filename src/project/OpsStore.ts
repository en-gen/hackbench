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
 * `.hbproj` projects predating this feature have no `ops/` directory; reading
 * one back is simply an empty stack, not an error.
 */
import * as fs from 'fs'
import * as path from 'path'
import { Layer } from './WorkingRom'

export const OPS_DIR = 'ops'

function opsDir(projectDirectory: string): string {
  return path.join(projectDirectory, OPS_DIR)
}

function layerFiles(projectDirectory: string): string[] {
  const dir = opsDir(projectDirectory)
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

/** Every persisted layer, oldest (bottom of stack) first. */
export function loadLayers(projectDirectory: string): Layer[] {
  return layerFiles(projectDirectory).map(f => {
    const raw = fs.readFileSync(path.join(opsDir(projectDirectory), f), 'utf8')
    const parsed = JSON.parse(raw) as Layer
    return { id: parsed.id, label: parsed.label, ops: parsed.ops }
  })
}

/**
 * Write a new layer as the next entry in the stack.
 *
 * The caller is responsible for having already validated the layer against
 * the working copy (WorkingRom.append throws on a stale `old`); this only
 * persists what was already accepted in memory.
 */
export function appendLayer(projectDirectory: string, layer: Layer): void {
  const dir = opsDir(projectDirectory)
  fs.mkdirSync(dir, { recursive: true })
  const index = layerFiles(projectDirectory).length
  const file = path.join(dir, `${String(index).padStart(4, '0')}.json`)
  fs.writeFileSync(file, formatLayerFile(layer), 'utf8')
}

/** Deletes the top (most recently appended) layer file, if any. */
export function popLayer(projectDirectory: string): void {
  const files = layerFiles(projectDirectory)
  const last = files[files.length - 1]
  if (last) fs.unlinkSync(path.join(opsDir(projectDirectory), last))
}
