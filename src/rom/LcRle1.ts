/**
 * LC_RLE1 decompressor - SMW Layer 2 preset background tilemaps.
 *
 * Faithful port of CODE_058126 (bank_05.asm lines 159-240). Each byte in the
 * output is a Map16 low-byte tile ID; the input is a stream of commands:
 *
 *   cmd byte = FLLLLLLL
 *     F=0 (bit 7 clear) → LITERAL: emit (L + 1) bytes read verbatim from input
 *     F=1 (bit 7 set)   → RLE:     emit (L & 0x7F) + 1 copies of the next byte
 *   terminator: two consecutive $FF bytes at a command position
 *
 * The terminator check in ASM (CODE_058188) peeks two bytes without consuming
 * them. If only the first is $FF but the second isn't, execution jumps back
 * to CODE_058136 which re-reads the $FF at the same position and dispatches
 * it normally - which makes it an RLE command (length 128, bit 7 set). We
 * reproduce this by checking terminator before consuming the command byte.
 */
export function decompressRle1(data: Buffer | Uint8Array): Uint8Array {
  const out: number[] = []
  let pos = 0

  while (pos < data.length) {
    // Peek terminator (FF FF) before consuming cmd
    if (data[pos] === 0xff && data[pos + 1] === 0xff) break
    const cmd = data[pos++]
    if (cmd === undefined) break

    const length = (cmd & 0x7f) + 1

    if ((cmd & 0x80) === 0) {
      // LITERAL: copy `length` bytes from input
      for (let i = 0; i < length; i++) {
        const b = data[pos++]
        if (b === undefined) break
        out.push(b)
      }
    } else {
      // RLE: repeat next byte `length` times
      const b = data[pos++]
      if (b === undefined) break
      for (let i = 0; i < length; i++) out.push(b)
    }
  }

  return new Uint8Array(out)
}
