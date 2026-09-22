/**
 * The painted pixels a project holds, on disk.
 *
 * What is stored is the EDIT, not the bytes: one
 * `{ kind: 'gfxPixel', file, tile, x, y, value }` per brush stroke, and
 * nothing cartridge-derived. src/rom/EditStack.ts states the reasoning; the
 * arithmetic here is that the alternative, the byte-level arena rewrite,
 * would be roughly 107 KB of Nintendo's own graphics per save in a file the
 * repo's own content gate refuses to commit.
 *
 * Separate from `ops/`, which holds WorkingRom layers, because these are not
 * layers: they are replayed into a GfxTable and the layer is DERIVED from
 * the result. One file rather than one per op, because a stroke is not a
 * reviewable unit the way a colour change is.
 */
import * as fs from 'fs'
import * as path from 'path'
import { GfxPixelOp } from '../rom/GfxTable'

export const GFX_DIR = 'gfx'
export const GFX_OPS_FILE = 'pixels.json'

interface GfxOpDocument {
  /** Bumped when the on-disk shape changes, so an old file is rejected loudly. */
  version: 1
  ops: GfxPixelOp[]
}

function opsPath(projectDirectory: string): string {
  return path.join(projectDirectory, GFX_DIR, GFX_OPS_FILE)
}

function isPixelOp(v: unknown): v is GfxPixelOp {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (o.kind !== 'gfxPixel') return false
  return ['file', 'tile', 'x', 'y', 'value'].every(k => Number.isInteger(o[k]))
}

/** Whether this project has any painted pixels at all, without reading or
 *  parsing them: the cheap check that keeps project open from decoding 50
 *  GFX files for a session that never looks at graphics. */
export function hasGfxOps(projectDirectory: string): boolean {
  return fs.existsSync(opsPath(projectDirectory))
}

/**
 * Every pixel op the project has, in order.
 *
 * A file that is missing is an empty history, which is what a project
 * predating this feature has. A file that is present but unreadable throws:
 * silently dropping half of someone's artwork and opening anyway is the
 * failure mode parseDocument in EditStack.ts refuses for the same reason.
 */
export function loadGfxOps(projectDirectory: string): GfxPixelOp[] {
  const file = opsPath(projectDirectory)
  if (!fs.existsSync(file)) return []
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  const doc = raw as Partial<GfxOpDocument>
  if (doc?.version !== 1 || !Array.isArray(doc.ops) || !doc.ops.every(isPixelOp)) {
    throw new Error(`${file} is not a pixel-op document this build understands`)
  }
  return doc.ops
}

/** One op per line, valid JSON: a diff shows exactly the strokes that changed. */
export function saveGfxOps(projectDirectory: string, ops: readonly GfxPixelOp[]): void {
  const dir = path.join(projectDirectory, GFX_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const lines = ops.map(o => `    ${JSON.stringify(o)}`).join(',\n')
  fs.writeFileSync(
    opsPath(projectDirectory),
    `{\n  "version": 1,\n  "ops": [\n${lines}\n  ]\n}\n`,
    'utf8',
  )
}
