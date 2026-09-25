/**
 * User metadata that never becomes ROM bytes: `meta/<concern>.json`,
 * one file per concern, so the manifest stays project identity only.
 *
 * No VS Code or Theia imports, same rule as the rest of src/project/.
 */
import * as fs from 'fs'
import * as path from 'path'
import { openProject } from './Project'

export type MetaConcern = 'aliases' | 'groups'

export const META_DIR = 'meta'

function metaPath(manifestPath: string, concern: MetaConcern): string {
  return path.join(path.dirname(manifestPath), META_DIR, `${concern}.json`)
}

/** Round-trips through openProject so a rejected manifest is refused before any read or write. */
export function readMeta(manifestPath: string, concern: MetaConcern): unknown | undefined {
  openProject(manifestPath)
  const file = metaPath(manifestPath, concern)
  if (!fs.existsSync(file)) return undefined

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`Meta file is not readable JSON: ${file}`, { cause: err })
  }
}

/**
 * Overwrites the concern's file unconditionally, with no merge against what
 * is already there. A caller that needs to preserve existing content reads
 * first (readMeta throws on a bad file rather than this silently replacing
 * it) and writes the merged result back.
 */
export function writeMeta(manifestPath: string, concern: MetaConcern, value: unknown): void {
  openProject(manifestPath)
  const file = metaPath(manifestPath, concern)
  fs.mkdirSync(path.dirname(file), { recursive: true })

  // Pid in the name so two processes writing the same concern do not race
  // on one temp file.
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}
