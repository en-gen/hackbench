import * as fs from 'fs'
import * as path from 'path'

/** True when any file under `dir` is named sessions.json (the file that makes .overwatch live). */
export function holdsSessionsFile(dir: string): boolean {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .some(e =>
      e.isDirectory() ? holdsSessionsFile(path.join(dir, e.name)) : e.name === 'sessions.json',
    )
}

/**
 * Cleanup for nestedFoldersGate: removes the plants, then removes each folder
 * the run created (existed[i] false). An empty .overwatch left beside a live
 * .hackbench-state once flipped sessions to it. rmdir, not rm -r, so another
 * process's files in a pre-existing or shared folder can never be deleted.
 */
export function cleanupNested(
  root: string,
  folders: readonly string[],
  existed: readonly boolean[],
  planted: readonly string[],
): void {
  for (const dir of planted) fs.rmSync(path.join(root, dir), { recursive: true, force: true })
  folders.forEach((f, i) => {
    if (existed[i]) return
    try {
      fs.rmdirSync(path.join(root, f))
    } catch {
      // not empty or already gone: not ours to remove
    }
  })
}
