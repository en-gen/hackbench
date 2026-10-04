/**
 * The one way to read a caller-supplied ROM path (#466).
 *
 * A path from an RPC client may be a directory or a device that never ends;
 * `readFileSync` on it blocks the backend event loop. So: open, require a
 * regular file, check the size, then read exactly that many bytes.
 *
 * No Theia or VS Code imports.
 */
import * as fs from 'fs'
import { COPIER_HEADER_SIZE } from '../rom/addressing'

/**
 * 8 MiB: the largest cart an ExLoROM map addresses (banks $80-$FF, 32 KiB
 * each), plus the optional 512-byte copier header. Bigger is not a SNES ROM
 * this tool can map. Evidence: LoROM address-space arithmetic, not a corpus.
 */
export const MAX_ROM_FILE_BYTES = 8 * 1024 * 1024 + COPIER_HEADER_SIZE

export function readRomBounded(romPath: string): Uint8Array {
  const fd = fs.openSync(romPath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`Not a regular file: ${romPath}`)
    if (stat.size > MAX_ROM_FILE_BYTES) {
      throw new Error(
        `File is too large to be a SNES ROM (${stat.size} bytes, limit ${MAX_ROM_FILE_BYTES}): ${romPath}`,
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
