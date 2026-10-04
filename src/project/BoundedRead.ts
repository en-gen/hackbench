/**
 * The one way to read a path a caller supplied (#466).
 *
 * A path from an RPC client may be a directory or a device that never ends;
 * `readFileSync` on it blocks the backend event loop. So: open (non-blocking
 * where the platform has it, so a FIFO cannot hang the open), require a
 * regular file, check the size, then read exactly that many bytes.
 *
 * No Theia or VS Code imports.
 */
import * as fs from 'fs'
import { COPIER_HEADER_SIZE } from '../rom/addressing'

/**
 * 8 MiB plus the optional copier header: room for an ExHiROM-sized dump. The
 * largest file in the 6-ROM-plus-hack corpus is 6,291,456 bytes (101 hacks,
 * 735 ROMs, one machine); a bigger file is not a ROM this tool can map.
 */
export const MAX_ROM_FILE_BYTES = 8 * 1024 * 1024 + COPIER_HEADER_SIZE

/** A manifest is a few hundred bytes of JSON; 1 MiB is generous. */
export const MAX_MANIFEST_BYTES = 1024 * 1024

/** `O_NONBLOCK` is undefined on Windows. */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)

export function readBounded(filePath: string, maxBytes: number, what: string): Uint8Array {
  const fd = fs.openSync(filePath, OPEN_FLAGS)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`)
    if (stat.size > maxBytes) {
      throw new Error(
        `File is too large to be ${what} (${stat.size} bytes, limit ${maxBytes}): ${filePath}`,
      )
    }
    const buf = Buffer.alloc(stat.size)
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got)
      if (n === 0) break
      got += n
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, got)
  } finally {
    fs.closeSync(fd)
  }
}

export const readRomBounded = (p: string): Uint8Array =>
  readBounded(p, MAX_ROM_FILE_BYTES, 'a SNES ROM')

export const readManifestBounded = (p: string): string =>
  Buffer.from(readBounded(p, MAX_MANIFEST_BYTES, 'a project file')).toString('utf8')
