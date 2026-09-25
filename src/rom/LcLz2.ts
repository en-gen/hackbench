/**
 * LC_LZ2 codec - Nintendo's compression format used for all SMW GFX files.
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
 *   byte 1 = header H   (111CC LLL  - top 3 bits must be 7)
 *   byte 2 = ext    E
 *   real_cmd = (H >> 2) & 7
 *   real_len = ((H & 3) << 8 | E) + 1    (range 1–1024)
 *
 * ── Commands ─────────────────────────────────────────────────────────────────
 *
 *   0  Direct copy      - copy next `len` input bytes verbatim to output
 *   1  Byte fill        - read 1 byte; write it `len` times
 *   2  Word fill        - read 2 bytes; alternate-write them `len` total bytes
 *   3  Increasing fill  - read 1 byte; write it then increment, `len` times
 *   4  Back-reference   - read 2-byte big-endian index into output; copy `len` bytes
 *
 * Commands 5, 6 and extended-7's real command all decode as command 4 on
 * hardware: `PLA / BEQ / BMI CODE_00B966` (bank_00.asm:6329-6331) branches on
 * the command's sign bit, set for 4-7 alike, into the shared back-reference
 * handler at bank_00.asm:6383. The encoder still refuses to emit them (see
 * `parseStream` below).
 *
 * Terminator: 0xFF ends the stream; see `decompress` below for what happens
 * when one is missing.
 *
 * References:
 *   - SMWCentral / DataCrystal GFX format docs
 *   - YY-CHR source (LC_LZ2 reference implementation)
 */

/**
 * Decompress LC_LZ2-compressed data starting at `srcOffset`.
 *
 * Throws when the stream ends without the 0xFF terminator, a back-reference
 * reads past what has been decoded so far, or output would exceed
 * `maxOutput`. Each caller turns that into its own refusal shape, most
 * simply via `tryDecompress` below; see `GfxLoader.readGfxFile` for the
 * pattern.
 *
 * A missing terminator is reported against `src.length - srcOffset`, the
 * window the caller actually handed in, not some notion of "the ROM's
 * stream": `GfxLoader` and `AnimationLoader` each read a fixed-size slice
 * starting at the compressed data, so a stream longer than that slice looks
 * identical to a genuinely truncated one, and the message should not blame
 * the ROM for a window it did not choose.
 *
 * @param src        The compressed data buffer (may be larger than needed)
 * @param srcOffset  Byte offset within `src` to start reading (default 0)
 * @param maxOutput  Output byte cap. Defaults to one 64 KB bank (`MAX_OUTPUT`,
 *                   declared with the encoder below), a safety bound rather
 *                   than a vanilla value.
 * @returns          Decompressed bytes as a Uint8Array
 */
export function decompress(
  src: Buffer | Uint8Array,
  srcOffset = 0,
  initialBuffer?: Uint8Array,
  meter?: { consumed: number; terminated: boolean },
  maxOutput: number = MAX_OUTPUT,
): Uint8Array {
  // initialBuffer: optional pre-filled output buffer. The decompressor writes starting at
  // position 0, overwriting the beginning while higher offsets remain intact. Backreferences
  // can read from pre-existing data at ANY position (the game decompresses into pre-filled RAM).
  const out: number[] = initialBuffer ? Array.from(initialBuffer) : []
  let i = srcOffset
  let wp = 0 // write position (always starts at 0)
  const window = src.length - srcOffset

  function writeByte(b: number): void {
    if (wp < out.length) out[wp] = b
    else while (out.length <= wp) out.push(wp === out.length ? b : 0) // extend if needed
    wp++
  }

  function fail(reason: string): never {
    throw new Error(`LC_LZ2: ${reason}`)
  }

  const noTerminator = (): never => fail(`stream did not terminate within ${window} bytes`)

  while (i < src.length) {
    const header = src[i++]
    if (header === 0xff) {
      if (meter) {
        meter.consumed = i - srcOffset // terminator included
        meter.terminated = true
      }
      return new Uint8Array(out)
    }

    let cmd = (header >> 5) & 7
    let len: number

    if (cmd === 7) {
      // Extended header - one extra byte encodes a longer length
      if (i >= src.length) noTerminator()
      const ext = src[i++]
      cmd = (header >> 2) & 7
      len = (((header & 3) << 8) | ext) + 1
    } else {
      len = (header & 0x1f) + 1
    }
    if (wp + len > maxOutput) fail(`output exceeds the ${maxOutput}-byte cap`)

    switch (cmd) {
      case 0: {
        // Direct copy: len bytes from input → output
        if (i + len > src.length) noTerminator()
        for (let n = 0; n < len; n++) writeByte(src[i++])
        break
      }
      case 1: {
        // Byte fill: one input byte repeated len times
        if (i >= src.length) noTerminator()
        const b = src[i++]
        for (let n = 0; n < len; n++) writeByte(b)
        break
      }
      case 2: {
        // Word fill: two input bytes alternated across len output bytes
        if (i + 1 >= src.length) noTerminator()
        const b0 = src[i++]
        const b1 = src[i++]
        for (let n = 0; n < len; n++) writeByte(n % 2 === 0 ? b0 : b1)
        break
      }
      case 3: {
        // Increasing fill: one input byte, written then incremented each step
        if (i >= src.length) noTerminator()
        let b = src[i++]
        for (let n = 0; n < len; n++) writeByte(b++ & 0xff)
        break
      }
      default: {
        // Back-reference (commands 4-7 alike): 2-byte big-endian index into
        // the output buffer. Checked per byte, not once up front, because a
        // self-referential run (addr inside this same command's span) is a
        // hardware-valid RLE idiom: out.length grows as the loop writes.
        if (i + 1 >= src.length) noTerminator()
        const addrHi = src[i++]
        const addrLo = src[i++]
        const addr = (addrHi << 8) | addrLo
        for (let n = 0; n < len; n++) {
          if (addr + n >= out.length) {
            fail(
              `back-reference reads offset ${addr + n}, past the ${out.length} bytes decoded so far`,
            )
          }
          writeByte(out[addr + n])
        }
        break
      }
    }
  }

  return noTerminator()
}

export type DecompressResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string }

export interface DecompressOptions {
  srcOffset?: number
  initialBuffer?: Uint8Array
  meter?: { consumed: number; terminated: boolean }
  maxOutput?: number
}

/**
 * `decompress`, with its throw folded into a result so a caller can return
 * or fold it into its own refusal shape without a try/catch of its own.
 */
export function tryDecompress(
  src: Buffer | Uint8Array,
  options?: DecompressOptions,
): DecompressResult {
  try {
    return {
      ok: true,
      bytes: decompress(
        src,
        options?.srcOffset,
        options?.initialBuffer,
        options?.meter,
        options?.maxOutput,
      ),
    }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

// ── Encoder ─────────────────────────────────────────────────────────────────
//
// STRUCTURE-PRESERVING RE-ENCODE, not a from-scratch compressor, and the
// difference is load-bearing. A correct greedy encoder (byte/word/increasing
// fill plus literal runs) re-encodes the UNEDITED vanilla cart's 50 GFX files
// to 117,834 bytes against the cart's own 107,284: 9.8% worse, worse on 50 of
// 50 files, overflowing the 108,039-byte arena by 9,795 bytes before a pixel
// is painted. Evidence scope: throwaway probe, 5 cartridges, one machine. The
// gap is command 4, which carries 12.0% of vanilla's decompressed bytes and
// which a run-encoder never produces.
//
// So `encode` walks the ORIGINAL command stream and keeps every command that
// still reproduces its own output byte for byte, back-references included.
// Only the commands an edit actually broke are replaced, and the replacement
// is a greedy re-encode of just that span. Unedited input therefore comes
// back byte-identical, and an edit costs bytes in proportion to itself.

/** Extended-header ceiling: 10 bits of length, so 1..1024. */
export const MAX_RUN = 1024
/** Short-header ceiling: 5 bits of length, so 1..32. */
export const MAX_SHORT_RUN = 32
/** Command 4's operand is a 16-bit output index, so nothing past this is
 *  addressable and emitting into it would be a stream the game cannot read.
 *  Also `decompress`'s default output cap: one WRAM bank, the most any
 *  decompression destination can hold. */
export const MAX_OUTPUT = 0x10000

/** One command as the decompressor reads it, with where it sits and what it
 *  produced. Commands 5 and 6 are never produced. */
export interface LcLz2Command {
  cmd: number
  len: number
  /** Offset of the header byte in the source buffer. */
  at: number
  /** Offset of the first operand byte. */
  opAt: number
  /** Bytes occupied, header included. */
  size: number
  /** Where this command's output begins in the decompressed buffer. */
  outStart: number
}

export interface LcLz2Stream {
  commands: LcLz2Command[]
  /** Bytes from `srcOffset` through the terminator, inclusive. */
  byteLength: number
  outputLength: number
  /** False when the buffer ran out, or the stream used a command SMW's
   *  decompressor ignores: either way it cannot be faithfully re-encoded. */
  terminated: boolean
}

function operandBytes(cmd: number, len: number): number {
  switch (cmd) {
    case 0:
      return len
    case 1:
    case 3:
      return 1
    default:
      return 2
  }
}

/**
 * Measure a compressed stream without decompressing it: where each command
 * sits, how long the whole thing is, and how much it produces.
 *
 * `byteLength` is what the arena needs to know a file's on-cart footprint,
 * and the command list is what `encode` re-walks.
 */
export function parseStream(src: Buffer | Uint8Array, srcOffset = 0): LcLz2Stream {
  const commands: LcLz2Command[] = []
  let i = srcOffset
  let wp = 0

  while (i < src.length) {
    const at = i
    const header = src[i++]!
    if (header === 0xff) {
      return { commands, byteLength: i - srcOffset, outputLength: wp, terminated: true }
    }

    let cmd = (header >> 5) & 7
    let len: number
    if (cmd === 7) {
      if (i >= src.length) break
      const ext = src[i++]!
      cmd = (header >> 2) & 7
      len = (((header & 3) << 8) | ext) + 1
    } else {
      len = (header & 0x1f) + 1
    }
    // Commands 5 and 6 are NOT inert (see `decompress` above, which reads
    // them as command 4 to match hardware). This encoder still refuses to
    // EMIT them: no test fixture exercises the write direction and none of
    // the 6-ROM corpus contains one (measured: zero commands >= 5 across
    // all six). Refusing an untested shape is the safe direction: the editor
    // declines to save the file rather than re-encoding it against semantics
    // it has never exercised.
    if (cmd >= 5) break

    const opAt = i
    i += operandBytes(cmd, len)
    if (i > src.length) break
    commands.push({ cmd, len, at, opAt, size: i - at, outStart: wp })
    wp += len
  }

  return { commands, byteLength: i - srcOffset, outputLength: wp, terminated: false }
}

/**
 * Compress `data`, reusing `template`'s command structure where it still
 * holds.
 *
 * Hard invariant, and the one every test leans on:
 * `decompress(encode(x))` equals `x`. With a template that matches, the
 * stronger `encode(decompress(s), s)` equals `s` also holds.
 *
 * Refuses a template that is unterminated or produces a different length,
 * rather than re-encoding against a structure that does not describe this
 * data: a partial read silently re-encoded is the confidently-wrong write
 * this whole approach exists to avoid.
 */
export function encode(data: Uint8Array, template?: Buffer | Uint8Array): Uint8Array {
  if (data.length > MAX_OUTPUT) {
    throw new Error(
      `cannot encode ${data.length} bytes: LC_LZ2 addresses output with 16 bits, ` +
        'so 65536 (0x10000) is the ceiling',
    )
  }

  const out: number[] = []
  if (template) {
    const parsed = parseStream(template)
    if (!parsed.terminated) {
      throw new Error('template stream is not terminated; refusing to re-encode a partial read')
    }
    if (parsed.outputLength !== data.length) {
      throw new Error(
        `template decompresses to ${parsed.outputLength} bytes but the data is ` +
          `${data.length}: length must match`,
      )
    }
    reencode(out, data, template, parsed.commands)
  } else {
    emitRange(out, data, 0, data.length)
  }
  out.push(0xff)
  return Uint8Array.from(out)
}

/**
 * Would this command, run against `data` as the output buffer, write exactly
 * the bytes `data` already holds there?
 */
function reproduces(c: LcLz2Command, data: Uint8Array, template: Buffer | Uint8Array): boolean {
  const wp = c.outStart
  switch (c.cmd) {
    case 0:
      for (let n = 0; n < c.len; n++) if (data[wp + n] !== template[c.opAt + n]) return false
      return true
    case 1: {
      const b = template[c.opAt]!
      for (let n = 0; n < c.len; n++) if (data[wp + n] !== b) return false
      return true
    }
    case 2: {
      const b0 = template[c.opAt]!
      const b1 = template[c.opAt + 1]!
      for (let n = 0; n < c.len; n++) if (data[wp + n] !== (n % 2 === 0 ? b0 : b1)) return false
      return true
    }
    case 3: {
      const b = template[c.opAt]!
      for (let n = 0; n < c.len; n++) if (data[wp + n] !== ((b + n) & 0xff)) return false
      return true
    }
    default: {
      const addr = (template[c.opAt]! << 8) | template[c.opAt + 1]!
      // An out-of-range source can never reproduce real data: decompress
      // refuses such a command, so any span built from one always re-encodes.
      if (addr >= wp) return false
      for (let n = 0; n < c.len; n++) {
        if (data[wp + n] !== data[addr + n]) return false
      }
      return true
    }
  }
}

/** Kept commands are copied verbatim; broken ones are coalesced into spans
 *  and greedily re-encoded together, so a run of them pays one header set. */
function reencode(
  out: number[],
  data: Uint8Array,
  template: Buffer | Uint8Array,
  commands: readonly LcLz2Command[],
): void {
  let brokenFrom = -1
  const flush = (end: number): void => {
    if (brokenFrom < 0) return
    emitRange(out, data, brokenFrom, end)
    brokenFrom = -1
  }

  for (const c of commands) {
    if (!reproduces(c, data, template)) {
      if (brokenFrom < 0) brokenFrom = c.outStart
      continue
    }
    flush(c.outStart)
    for (let k = 0; k < c.size; k++) out.push(template[c.at + k]!)
  }
  flush(data.length)
}

interface Run {
  cmd: number
  len: number
  operands: number[]
}

/**
 * The most economical fill starting at `p`, or null when literals win.
 *
 * `saving` is what the fill costs against the same bytes as literal payload.
 * It must clear 1, not 0: interrupting a literal run costs an extra header
 * byte on the far side, so a saving of 1 nets nothing.
 */
function bestRun(data: Uint8Array, p: number, end: number): Run | null {
  const limit = Math.min(end - p, MAX_RUN)
  const b0 = data[p]!

  let byteLen = 1
  while (byteLen < limit && data[p + byteLen] === b0) byteLen++

  let incLen = 1
  while (incLen < limit && data[p + incLen] === ((b0 + incLen) & 0xff)) incLen++

  let wordLen = 0
  if (limit >= 2) {
    const b1 = data[p + 1]!
    wordLen = 1
    while (wordLen < limit && data[p + wordLen] === (wordLen % 2 === 0 ? b0 : b1)) wordLen++
  }

  const candidates: Run[] = [
    { cmd: 1, len: byteLen, operands: [b0] },
    { cmd: 3, len: incLen, operands: [b0] },
    { cmd: 2, len: wordLen, operands: [b0, data[p + 1] ?? 0] },
  ]
  let best: Run | null = null
  let bestSaving = 1
  for (const r of candidates) {
    if (r.len < 2) continue
    const saving = r.len - (headerSize(r.len) + r.operands.length)
    if (saving > bestSaving) {
      best = r
      bestSaving = saving
    }
  }
  return best
}

function headerSize(len: number): number {
  return len <= MAX_SHORT_RUN ? 1 : 2
}

function emitHeader(out: number[], cmd: number, len: number): void {
  if (len <= MAX_SHORT_RUN) {
    out.push(((cmd & 7) << 5) | (len - 1))
    return
  }
  // Extended form: 111 in the top bits, command in 4-2, the length's high
  // bits in 1-0. Command never reaches 7 here, so this cannot emit $FF.
  out.push(0xe0 | ((cmd & 7) << 2) | (((len - 1) >> 8) & 3))
  out.push((len - 1) & 0xff)
}

/** Greedy encode of one span: fills where they pay, literals otherwise. */
function emitRange(out: number[], data: Uint8Array, start: number, end: number): void {
  let p = start
  let litFrom = -1

  const flushLiterals = (): void => {
    if (litFrom < 0) return
    for (let n = litFrom; n < p;) {
      const take = Math.min(p - n, MAX_RUN)
      emitHeader(out, 0, take)
      for (let k = 0; k < take; k++) out.push(data[n + k]!)
      n += take
    }
    litFrom = -1
  }

  while (p < end) {
    const run = bestRun(data, p, end)
    if (!run) {
      if (litFrom < 0) litFrom = p
      p++
      continue
    }
    flushLiterals()
    emitHeader(out, run.cmd, run.len)
    for (const b of run.operands) out.push(b)
    p += run.len
  }
  flushLiterals()
}
