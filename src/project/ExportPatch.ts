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
  const problem = projectNameProblem(name)
  if (problem) throw new Error(problem)
  const dir = path.join(projectDirectory, EXPORT_DIR)
  const filePath = path.join(dir, `${name}.${format}`)
  if (path.dirname(path.resolve(filePath)) !== path.resolve(dir)) {
    throw new Error(`Export path escapes ${EXPORT_DIR}/: ${filePath}`)
  }
  fs.mkdirSync(dir, { recursive: true })

  const strip = format === 'bps' && working.hasCopierHeader ? COPIER_HEADER_SIZE : 0
  const source = working.baseBytes().subarray(strip)
  const target = working.exportableBytes().subarray(strip)
  const patches = diffPatches(source, target)
  const bytes = format === 'ips' ? encodeIps(patches) : encodeBps(source, target)

  fs.writeFileSync(filePath, bytes)
  return {
    path: filePath,
    hasCopierHeader: working.hasCopierHeader,
    // diffPatches only compares up to the shorter length; count a size
    // change too, against the day a working copy can grow past the base.
    opCount: patches.length + Math.abs(source.length - target.length),
    format,
  }
}
