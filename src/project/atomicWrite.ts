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
 * The parent directory must already exist; callers make it (`fs.mkdirSync`).
 */
export function writeFileAtomic(file: string, data: Uint8Array | string): void {
  const tmp = `${file}.${process.pid}.tmp`
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  // Opened before the cleanup `try`: a refused open created nothing, so the
  // catch below must not delete what is at `tmp` (a sibling writer's live temp).
  const fd = fs.openSync(tmp, 'wx')
  try {
    try {
      // writeSync may take fewer bytes than asked; renaming a short file would truncate the target.
      let done = 0
      while (done < bytes.length) {
        const n = fs.writeSync(fd, bytes, done, bytes.length - done)
        if (n <= 0)
          throw new Error(`Short write to ${file}: ${done} of ${bytes.length} bytes written`)
        done += n
      }
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
