/**
 * The one temp-then-rename file writer for src/project and the tools.
 * No shell imports, same rule as the rest of src/project/.
 */
import * as fs from 'fs'

/**
 * Written to `<file>.<pid>.tmp`, flushed to disk, and renamed over the old
 * file, so a killed process mid-write leaves the previous file intact rather
 * than half of one. The pid keeps two processes writing one file off a shared
 * temp name; `wx` refuses a leftover or planted temp. Rename replaces a hard
 * link at the target instead of writing through it to the file it points at.
 * On any failure the temporary file is removed and the error rethrown.
 */
export function writeFileAtomic(file: string, data: Uint8Array | string): void {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    const fd = fs.openSync(tmp, 'wx')
    try {
      fs.writeSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    renameWithRetry(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Windows refuses a rename over a file another process has open (OneDrive,
 * an antivirus scan, an editor) with EPERM or EBUSY, usually for moments.
 */
export function renameWithRetry(from: string, to: string, attempts = 5): void {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (i >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      // Synchronous back-off: callers expect a finished write when this returns.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * i)
    }
  }
}
