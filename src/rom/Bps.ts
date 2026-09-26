/**
 * BPS: the patch format SMW Central's Hacks section requires instead of IPS,
 * since its source/target CRC32s refuse a patch applied to the wrong ROM
 * instead of corrupting it. Format spec: https://www.romhacking.net/documents/746/
 */
import * as zlib from 'zlib'

const MAGIC = [0x42, 0x50, 0x53, 0x31] // "BPS1"
const CRC_TRAILER_SIZE = 12 // three 4-byte CRC32 fields
const MAX_ROM_SIZE = 0x1000000 // 16 MiB: the largest SNES LoROM/HiROM address space

const crc32 = (bytes: Uint8Array): number => zlib.crc32(bytes) >>> 0

function le32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value >>> 0, 0)
  return buf
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return Buffer.from(bytes.buffer, bytes.byteOffset + offset, 4).readUInt32LE(0)
}

/** BPS variable-width number: base-128 septets, high bit marks the last one, each non-final septet offset by one so every value has one canonical encoding. */
function pushNumber(out: number[], value: number): void {
  let n = value
  for (;;) {
    const x = n % 128
    n = Math.floor(n / 128)
    if (n === 0) {
      out.push(0x80 | x)
      return
    }
    out.push(x)
    n -= 1
  }
}

/** Refusal reasons all flow through here so one catch site returns them. */
class BpsRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/** A read cursor bounded to `end`, so a malformed patch fails closed instead of reading into the CRC trailer or off the end of the array. */
class Cursor {
  i = 4 // past the magic, which the caller already checked

  constructor(
    private readonly bytes: Uint8Array,
    private readonly end: number,
  ) {}

  byte(): number {
    if (this.i >= this.end) throw new BpsRefusal('patch is truncated: ran out of data mid-stream')
    return this.bytes[this.i++]
  }

  number(): number {
    let result = 0
    let shift = 1
    for (;;) {
      const x = this.byte()
      result += (x & 0x7f) * shift
      if (x & 0x80) return result
      shift *= 128
      result += shift
    }
  }

  /** BPS encodes a signed offset as the magnitude shifted left one bit, with the sign in bit 0. */
  signedNumber(): number {
    const n = this.number()
    const magnitude = Math.floor(n / 2)
    return n & 1 ? -magnitude : magnitude
  }
}

/** Encode a full diff of `source` against `target` as a BPS patch. */
export function encodeBps(source: Uint8Array, target: Uint8Array, metadata = ''): Uint8Array {
  const out: number[] = [...MAGIC]
  pushNumber(out, source.length)
  pushNumber(out, target.length)
  const metaBytes = Buffer.from(metadata, 'utf8')
  pushNumber(out, metaBytes.length)
  for (const b of metaBytes) out.push(b)

  let offset = 0
  while (offset < target.length) {
    let sourceRun = 0
    while (
      offset + sourceRun < target.length &&
      offset + sourceRun < source.length &&
      source[offset + sourceRun] === target[offset + sourceRun]
    ) {
      sourceRun++
    }

    if (sourceRun > 0) {
      pushNumber(out, ((sourceRun - 1) << 2) | 0) // SourceRead
      offset += sourceRun
      continue
    }

    let literalRun = 0
    while (offset + literalRun < target.length) {
      const at = offset + literalRun
      if (at < source.length && source[at] === target[at]) break
      literalRun++
    }
    pushNumber(out, ((literalRun - 1) << 2) | 1) // TargetRead
    for (let n = 0; n < literalRun; n++) out.push(target[offset + n])
    offset += literalRun
  }

  out.push(...le32(crc32(source)), ...le32(crc32(target)))
  out.push(...le32(crc32(Uint8Array.from(out))))
  return Uint8Array.from(out)
}

export type BpsApplyResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string }

/**
 * Apply a BPS patch to `source`, refusing rather than returning corrupt bytes
 * when the magic number, either checksum, a size, or the byte stream itself
 * doesn't check out.
 */
export function applyBps(source: Uint8Array, patch: Uint8Array): BpsApplyResult {
  if (patch.length < MAGIC.length + CRC_TRAILER_SIZE) {
    return { ok: false, reason: 'patch is truncated: shorter than a minimal BPS file' }
  }
  if (!MAGIC.every((b, i) => patch[i] === b)) {
    return { ok: false, reason: 'not a BPS patch: missing the "BPS1" magic number' }
  }

  const trailerStart = patch.length - CRC_TRAILER_SIZE
  const patchCrcStored = readUint32LE(patch, trailerStart + 8)
  const patchCrcActual = crc32(patch.subarray(0, trailerStart + 8))
  if (patchCrcStored !== patchCrcActual) {
    return { ok: false, reason: 'patch is corrupt: patch checksum does not match its contents' }
  }

  const cursor = new Cursor(patch, trailerStart)
  let target: Uint8Array
  try {
    const sourceSize = cursor.number()
    const targetSize = cursor.number()
    const metadataSize = cursor.number()
    cursor.i += metadataSize
    if (cursor.i > trailerStart) {
      throw new BpsRefusal('patch is truncated: metadata runs past the action stream')
    }
    if (targetSize > MAX_ROM_SIZE) {
      return { ok: false, reason: `target size ${targetSize} exceeds the 16 MiB SNES ROM limit` }
    }
    if (sourceSize !== source.length) {
      return {
        ok: false,
        reason: `source is ${source.length} bytes but the patch expects ${sourceSize}`,
      }
    }
    const sourceCrcStored = readUint32LE(patch, trailerStart)
    if (sourceCrcStored !== crc32(source)) {
      return { ok: false, reason: 'source does not match this patch: checksum mismatch' }
    }

    target = new Uint8Array(targetSize)
    let outOffset = 0
    let sourceRel = 0
    let targetRel = 0
    while (cursor.i < trailerStart) {
      const header = cursor.number()
      const length = (header >> 2) + 1
      const mode = header & 3
      if (outOffset + length > targetSize) {
        throw new BpsRefusal('patch is malformed: an action reads past the end of the target')
      }

      switch (mode) {
        case 0: // SourceRead
          if (outOffset + length > source.length) {
            throw new BpsRefusal('patch is malformed: a SourceRead reaches past the source')
          }
          for (let n = 0; n < length; n++) target[outOffset + n] = source[outOffset + n]
          break
        case 1: // TargetRead
          for (let n = 0; n < length; n++) target[outOffset + n] = cursor.byte()
          break
        case 2: // SourceCopy
          sourceRel += cursor.signedNumber()
          if (sourceRel < 0 || sourceRel + length > source.length) {
            throw new BpsRefusal('patch is malformed: a SourceCopy reaches outside the source')
          }
          for (let n = 0; n < length; n++) target[outOffset + n] = source[sourceRel + n]
          sourceRel += length
          break
        case 3: // TargetCopy: byte by byte, since a run can copy from output it just wrote.
          targetRel += cursor.signedNumber()
          if (targetRel < 0 || targetRel >= outOffset) {
            throw new BpsRefusal('patch is malformed: a TargetCopy reads output not yet written')
          }
          for (let n = 0; n < length; n++) target[outOffset + n] = target[targetRel++]
          break
      }
      outOffset += length
    }
    if (outOffset !== targetSize) {
      throw new BpsRefusal(
        `patch is truncated: its actions produced ${outOffset} bytes, not the ${targetSize} declared`,
      )
    }
  } catch (err) {
    if (err instanceof BpsRefusal) return { ok: false, reason: err.reason }
    throw err
  }

  const targetCrcStored = readUint32LE(patch, trailerStart + 4)
  if (targetCrcStored !== crc32(target)) {
    return { ok: false, reason: 'result does not match this patch: target checksum mismatch' }
  }
  return { ok: true, bytes: target }
}
