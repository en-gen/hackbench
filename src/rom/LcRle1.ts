/**
 * LC_RLE1 decompressor — used for SMW Layer 2 background tilemaps.
 *
 * Format:
 *   Each command byte: FLLLLLLL
 *     F=0 → copy next (L+1) bytes literally from input
 *     F=1 → repeat next single byte (L+1) times
 *   Terminator: $FF $FF (two consecutive $FF bytes)
 *
 * The decompressed output is a flat byte array of Map16 tile bytes.
 * For L2 background tilemaps the bytes represent tile IDs in row-major order.
 */
export function decompressRle1(data: Buffer | Uint8Array): Uint8Array {
  const out: number[] = []
  let pos = 0

  while (pos < data.length) {
    const cmd = data[pos++]
    if (cmd === undefined) break

    // Terminator: $FF $FF
    if (cmd === 0xFF) {
      const next = data[pos]
      if (next === 0xFF) break
      // Single $FF that isn't the terminator — treat as literal byte (length 0 = 1 byte)
      // This shouldn't normally happen, but be defensive
      out.push(cmd)
      continue
    }

    const flag   = (cmd >> 7) & 1
    const length = (cmd & 0x7F) + 1   // L+1 bytes to emit

    if (flag === 0) {
      // Literal copy: read `length` bytes from input
      for (let i = 0; i < length; i++) {
        const b = data[pos++]
        if (b === undefined) break
        out.push(b)
      }
    } else {
      // Run-length: repeat next byte `length` times
      const b = data[pos++]
      if (b === undefined) break
      for (let i = 0; i < length; i++) out.push(b)
    }
  }

  return new Uint8Array(out)
}
