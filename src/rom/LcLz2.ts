/**
 * LC_LZ2 decompressor — Nintendo's compression format used for all SMW GFX files.
 *
 * Every GFX file in the ROM is stored compressed. Addresses are read from
 * split pointer tables (lo/hi/bank) rather than computed linearly.
 *
 * ── Header byte format ────────────────────────────────────────────────────────
 *
 *   CCCLLLLL
 *   |||||||└─ length - 1  (5 bits → lengths 1-32)
 *   └────────  command    (3 bits → 0-7)
 *
 * Extended header (when CCC == 7):
 *   byte 1 = header H   (111CC LLL  — top 3 bits must be 7)
 *   byte 2 = ext    E
 *   real_cmd = (H >> 2) & 7
 *   real_len = ((H & 3) << 8 | E) + 1    (range 1–1024)
 *
 * ── Commands ─────────────────────────────────────────────────────────────────
 *
 *   0  Direct copy      — copy next `len` input bytes verbatim to output
 *   1  Byte fill        — read 1 byte; write it `len` times
 *   2  Word fill        — read 2 bytes; alternate-write them `len` total bytes
 *   3  Increasing fill  — read 1 byte; write it then increment, `len` times
 *   4  Back-reference   — read 2-byte big-endian index into output; copy `len` bytes
 *   5  (unused in SMW)
 *   6  (unused in SMW)
 *
 * Terminator: 0xFF ends the stream.
 *
 * References:
 *   - SMWCentral / DataCrystal GFX format docs
 *   - YY-CHR source (LC_LZ2 reference implementation)
 */

/**
 * Decompress LC_LZ2-compressed data starting at `srcOffset`.
 * Reads until the 0xFF terminator or end of buffer.
 *
 * @param src        The compressed data buffer (may be larger than needed)
 * @param srcOffset  Byte offset within `src` to start reading (default 0)
 * @returns          Decompressed bytes as a Uint8Array
 */
export function decompress(src: Buffer | Uint8Array, srcOffset = 0): Uint8Array {
  const out: number[] = []
  let i = srcOffset

  while (i < src.length) {
    const header = src[i++]
    if (header === 0xFF) break  // terminator

    let cmd = (header >> 5) & 7
    let len: number

    if (cmd === 7) {
      // Extended header — one extra byte encodes a longer length
      if (i >= src.length) break
      const ext = src[i++]
      cmd = (header >> 2) & 7
      len = ((header & 3) << 8 | ext) + 1
    } else {
      len = (header & 0x1F) + 1
    }

    switch (cmd) {
      case 0: {
        // Direct copy: len bytes from input → output
        for (let n = 0; n < len && i < src.length; n++) {
          out.push(src[i++])
        }
        break
      }
      case 1: {
        // Byte fill: one input byte repeated len times
        if (i >= src.length) break
        const b = src[i++]
        for (let n = 0; n < len; n++) out.push(b)
        break
      }
      case 2: {
        // Word fill: two input bytes alternated across len output bytes
        if (i + 1 >= src.length) break
        const b0 = src[i++]
        const b1 = src[i++]
        for (let n = 0; n < len; n++) out.push(n % 2 === 0 ? b0 : b1)
        break
      }
      case 3: {
        // Increasing fill: one input byte, written then incremented each step
        if (i >= src.length) break
        let b = src[i++]
        for (let n = 0; n < len; n++) out.push(b++ & 0xFF)
        break
      }
      case 4: {
        // Back-reference: 2-byte big-endian index into the output buffer so far
        if (i + 1 >= src.length) break
        const addrHi = src[i++]
        const addrLo = src[i++]
        const addr   = (addrHi << 8) | addrLo
        for (let n = 0; n < len; n++) {
          out.push(addr + n < out.length ? out[addr + n] : 0)
        }
        break
      }
      default:
        // Commands 5 & 6 are unused in SMW — skip gracefully
        break
    }
  }

  return new Uint8Array(out)
}
