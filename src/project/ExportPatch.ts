/**
 * Turn a WorkingRom's edits into a real .ips patch file.
 *
 * Diffs the base cartridge against the EXPORTABLE working copy (edit layers
 * only - a preview layer mid-drag must never ship, same rule as
 * src/rom/PatchLayer.ts's `exportable`), byte by byte, and hands the result
 * to encodeIps. Offsets are FILE offsets from the start of the base file
 * (copier header included when the cart has one, same convention RomFile
 * itself writes at), so the patch applies to the SAME file variant
 * (headered or not) the project's base cartridge is.
 */
import * as fs from 'fs'
import * as path from 'path'
import { Patch } from '../rom/PatchLayer'
import { encodeIps } from '../rom/Ips'
import { WorkingRom } from './WorkingRom'

export const EXPORT_DIR = 'export'

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
}

/** Writes `<projectDirectory>/export/<name>.ips`, creating the directory if needed. */
export function exportPatch(
  projectDirectory: string,
  name: string,
  working: WorkingRom,
): ExportedPatch {
  const patches = diffPatches(working.baseBytes(), working.exportableBytes())
  const ips = encodeIps(patches)

  const dir = path.join(projectDirectory, EXPORT_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${name}.ips`)
  fs.writeFileSync(filePath, ips)

  return { path: filePath, hasCopierHeader: working.hasCopierHeader, opCount: patches.length }
}
