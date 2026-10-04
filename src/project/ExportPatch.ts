/**
 * Turn a WorkingRom's edits into a real patch file, BPS by default (what
 * SMW Central's Hacks section requires) or IPS. BPS strips a copier header
 * from both sides before diffing, so the patch always applies to the
 * unheadered ROM SMW Central expects, regardless of which variant the
 * project's base is; IPS keeps its offsets against the base file as before.
 */
import * as fs from 'fs'
import * as path from 'path'
import { Patch } from '../rom/PatchLayer'
import { encodeIps } from '../rom/Ips'
import { encodeBps } from '../rom/Bps'
import { COPIER_HEADER_SIZE } from '../rom/addressing'
import { WorkingRom } from './WorkingRom'
import { projectNameProblem } from './Project'

export const EXPORT_DIR = 'export'
export type PatchFormat = 'bps' | 'ips'

function diffPatches(base: Uint8Array, edited: Uint8Array): Patch[] {
  const patches: Patch[] = []
  const len = Math.min(base.length, edited.length)
  for (let i = 0; i < len; i++) {
    if (base[i] !== edited[i]) patches.push({ offset: i, value: edited[i] })
  }
  return patches
}

export interface ExportedPatch {
  path: string
  hasCopierHeader: boolean
  opCount: number
  format: PatchFormat
}

/** Writes `<projectDirectory>/export/<name>.bps` (default) or `.ips`, creating the directory if needed. */
export function exportPatch(
  projectDirectory: string,
  name: string,
  working: WorkingRom,
  format: PatchFormat = 'bps',
): ExportedPatch {
  // Runtime checks: `format` and `name` cross RPC / come from a shared manifest.
  if (format !== 'bps' && format !== 'ips')
    throw new Error(`Unknown patch format: ${String(format)}`)
  const problem = projectNameProblem(name, true)
  if (problem) throw new Error(`Cannot export: ${problem}`)
  const dir = path.join(projectDirectory, EXPORT_DIR)
  fs.mkdirSync(dir, { recursive: true })
  // export/ may be a symlink or junction a shared project carries; the real
  // directory must still be inside the project.
  const inside = path.relative(fs.realpathSync(projectDirectory), fs.realpathSync(dir))
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`${EXPORT_DIR}/ resolves outside the project: ${dir}`)
  }
  const filePath = path.join(dir, `${name}.${format}`)
  // A planted link at the target would redirect the write.
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to write through a link: ${filePath}`)
  }

  const strip = format === 'bps' && working.hasCopierHeader ? COPIER_HEADER_SIZE : 0
  const source = working.baseBytes().subarray(strip)
  const target = working.exportableBytes().subarray(strip)
  const patches = diffPatches(source, target)
  const bytes = format === 'ips' ? encodeIps(patches) : encodeBps(source, target)

  // Temp file then rename: rename replaces a hard link at the target instead
  // of writing through it to the file it points at.
  const tmpPath = `${filePath}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmpPath, bytes, { flag: 'wx' })
    fs.renameSync(tmpPath, filePath)
  } finally {
    fs.rmSync(tmpPath, { force: true })
  }
  return {
    path: filePath,
    hasCopierHeader: working.hasCopierHeader,
    // diffPatches only compares up to the shorter length; count a size
    // change too, against the day a working copy can grow past the base.
    opCount: patches.length + Math.abs(source.length - target.length),
    format,
  }
}
