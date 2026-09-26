/**
 * BPS encode/decode: the format SMW Central requires in place of IPS.
 */
import { describe, it, expect } from 'vitest'
import * as zlib from 'zlib'
import { encodeBps, applyBps } from '../../../src/rom/Bps'

/** Deterministic, distinct per seed, so a failure reproduces without randomness. */
function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff)
}

function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

function readLe32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

/** BPS's own variable-width number, for CONSTRUCTING hand-built fixtures only; the format itself is pinned separately below, against literal bytes. */
function varint(value: number): number[] {
  const out: number[] = []
  let n = value
  for (;;) {
    const x = n % 128
    n = Math.floor(n / 128)
    if (n === 0) {
      out.push(0x80 | x)
      return out
    }
    out.push(x)
    n -= 1
  }
}

/**
 * Assembles a full patch from a hand-written body (magic through the last
 * action byte). Omitting `target` leaves its CRC field as a placeholder, for
 * a fixture meant to be refused before the target is ever checked.
 */
function buildPatch(body: number[], source: Uint8Array, target?: Uint8Array): Uint8Array {
  const sourceCrc = zlib.crc32(Buffer.from(source))
  const targetCrc = target ? zlib.crc32(Buffer.from(target)) : 0
  const withCrcs = [...body, ...le32(sourceCrc), ...le32(targetCrc)]
  const patchCrc = zlib.crc32(Buffer.from(withCrcs))
  return Uint8Array.from([...withCrcs, ...le32(patchCrc)])
}

/** Recomputes the trailing patch CRC32 in place, so a hand-corrupted fixture is refused by the check under test, not by this one firing first. */
function repairPatchCrc(patch: Uint8Array): void {
  const trailerStart = patch.length - 12
  const crc = zlib.crc32(Buffer.from(patch.subarray(0, trailerStart + 8)))
  patch.set(le32(crc), trailerStart + 8)
}

const MAGIC = [0x42, 0x50, 0x53, 0x31]

describe('BPS round trip', () => {
  it.each([
    ['differing data', () => bytes(0x400, 1), () => bytes(0x400, 2)],
    ['identical input', () => bytes(0x200, 3), () => bytes(0x200, 3)],
    ['a target larger than the source', () => bytes(0x100, 4), () => bytes(0x300, 5)],
    ['a target smaller than the source', () => bytes(0x300, 6), () => bytes(0x100, 7)],
    ['an empty diff', () => new Uint8Array(0), () => new Uint8Array(0)],
  ] as const)('survives %s', (_name, makeSource, makeTarget) => {
    const source = makeSource()
    const target = makeTarget()
    const result = applyBps(source, encodeBps(source, target))
    expect(result.ok).toBe(true)
    expect(result.ok && Array.from(result.bytes)).toEqual(Array.from(target))
  })
})

describe('the exact BPS bytes for a tiny diff', () => {
  it('matches the format spec byte for byte', () => {
    const source = Uint8Array.from([1, 2, 3])
    const target = Uint8Array.from([1, 2, 9])

    // "BPS1", source size 3, target size 3, metadata size 0 (each a
    // one-byte varint, since all are under 128: value | 0x80).
    // Then one SourceRead of 2 bytes ((2-1)<<2|0 = 4 -> 0x84) and one
    // TargetRead of 1 literal byte ((1-1)<<2|1 = 1 -> 0x81, then 0x09).
    const body = [...MAGIC, 0x83, 0x83, 0x80, 0x84, 0x81, 0x09]
    const withCrcs = [
      ...body,
      ...le32(zlib.crc32(Buffer.from(source))),
      ...le32(zlib.crc32(Buffer.from(target))),
    ]
    const expected = Uint8Array.from([...withCrcs, ...le32(zlib.crc32(Buffer.from(withCrcs)))])

    expect(encodeBps(source, target)).toEqual(expected)
  })
})

describe('CRC32 is the standard zlib/PNG polynomial', () => {
  it('matches a published known-answer vector, not merely self-consistency', () => {
    const source = Uint8Array.from([1, 2, 3])
    const patch = encodeBps(source, source) // identical, so both CRCs cover the same bytes
    const trailerStart = patch.length - 12
    expect(readLe32(patch, trailerStart)).toBe(0x55bc801d) // crc32([1,2,3])
    expect(readLe32(patch, trailerStart + 4)).toBe(0x55bc801d)
  })
})

/**
 * Hand-derived from the spec's number algorithm, not from encodeBps: every
 * other test in this file uses numbers under 128, where the "septet after
 * the first is offset by one" rule never engages, so dropping it would still
 * pass every one of them. These pin the three byte-length boundaries plus a
 * ROM-scale value, checking both the encoder's bytes and the decoder's parse.
 */
const NUMBER_VECTORS = [
  [0, [0x80]],
  [127, [0xff]],
  [128, [0x00, 0x80]],
  [16511, [0x7f, 0xff]], // largest 2-byte value
  [16512, [0x00, 0x00, 0x80]], // smallest 3-byte value
  [0x80000, [0x00, 0x7f, 0x9e]],
] as const

describe('the variable-width number encoding at each byte-length boundary', () => {
  it.each(NUMBER_VECTORS)('encodes a %i-byte source size as %j', (n, expectedBytes) => {
    const source = new Uint8Array(n)
    const patch = encodeBps(source, Uint8Array.from(source)) // identical -> cheap SourceRead
    expect(Array.from(patch.slice(4, 4 + expectedBytes.length))).toEqual([...expectedBytes])
  })

  it.each(NUMBER_VECTORS)('encodes a %i-byte target size as %j', (n, expectedBytes) => {
    const source = new Uint8Array(0)
    const target = new Uint8Array(n)
    const patch = encodeBps(source, target)
    expect(Array.from(patch.slice(5, 5 + expectedBytes.length))).toEqual([...expectedBytes])
  })

  it('round-trips a patch whose source AND target are both 0x80000 bytes', () => {
    const source = bytes(0x80000, 40)
    const target = bytes(0x80000, 41)
    const patch = encodeBps(source, target)
    expect(Array.from(patch.slice(4, 7))).toEqual([0x00, 0x7f, 0x9e])
    expect(Array.from(patch.slice(7, 10))).toEqual([0x00, 0x7f, 0x9e])

    const result = applyBps(source, patch)
    expect(result.ok).toBe(true)
    expect(result.ok && Array.from(result.bytes)).toEqual(Array.from(target))
  })
})

describe('SourceCopy and TargetCopy, hand-built (Flips-style patches lean on these)', () => {
  it('decodes forward/negative SourceCopy, a self-overlapping TargetCopy run, a non-overlapping negative TargetCopy, and metadata', () => {
    const source = Uint8Array.from([10, 20, 30, 40, 50])
    // Expected, action by action: [30,40] (SourceCopy, sourceRel 0->2), [10]
    // (SourceCopy, sourceRel 4->0), [99] (TargetRead), [99,99,99] (TargetCopy,
    // targetRel 0->3, self-overlapping RLE off the 99 just written), [7]
    // (TargetRead), [30,40] (TargetCopy, targetRel 6->0, plain back-reference).
    // SourceCopy/TargetCopy offsets are deltas on a PERSISTENT pointer that
    // starts at 0 and carries across actions of that mode - not deltas off
    // the current output position.
    const target = Uint8Array.from([30, 40, 10, 99, 99, 99, 99, 7, 30, 40])

    const body = [
      ...MAGIC,
      0x85,
      0x8a,
      0x82, // source size 5, target size 10, metadata size 2
      0x68,
      0x69, // metadata "hi"
      0x86,
      0x84, // SourceCopy len 2, offset +2 (sourceRel 0 -> 2)
      0x82,
      0x89, // SourceCopy len 1, offset -4 (sourceRel 4 -> 0)
      0x81,
      0x63, // TargetRead len 1, literal 99
      0x8b,
      0x86, // TargetCopy len 3, offset +3 (targetRel 0 -> 3)
      0x81,
      0x07, // TargetRead len 1, literal 7
      0x87,
      0x8d, // TargetCopy len 2, offset -6 (targetRel 6 -> 0)
    ]
    const patch = buildPatch(body, source, target)

    const result = applyBps(source, patch)
    expect(result.ok).toBe(true)
    expect(result.ok && Array.from(result.bytes)).toEqual(Array.from(target))
  })
})

describe('out-of-bounds reads are refused, not silently read as zero', () => {
  it('refuses a SourceRead that reaches past the end of the source', () => {
    const source = Uint8Array.from([1, 2])
    // source size 2, target size 3, metadata 0, SourceRead len 3: fits the
    // target (3 bytes) but not the source, which is only 2 bytes long.
    const body = [...MAGIC, 0x82, 0x83, 0x80, 0x88]
    const result = applyBps(source, buildPatch(body, source))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/SourceRead/)
  })

  it('refuses a SourceCopy whose offset lands outside the source', () => {
    const source = Uint8Array.from([1, 2])
    // source size 2, target size 1, metadata 0, SourceCopy len 1 offset +5.
    const body = [...MAGIC, 0x82, 0x81, 0x80, 0x82, 0x8a]
    const result = applyBps(source, buildPatch(body, source))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/SourceCopy/)
  })

  it('refuses a TargetCopy that reads output not yet written', () => {
    const source = Uint8Array.from([9])
    // source size 1, target size 2, metadata 0: TargetRead len 1 (literal 5),
    // then TargetCopy len 1 offset +1 - the targetRel pointer starts at 0, so
    // this lands on index 1, the byte about to be written, never one already
    // written.
    const body = [...MAGIC, 0x81, 0x82, 0x80, 0x81, 0x05, 0x83, 0x82]
    const result = applyBps(source, buildPatch(body, source))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/TargetCopy/)
  })
})

describe('a huge declared size is refused, not allocated', () => {
  it('refuses a target size over the 16 MiB SNES ROM limit', () => {
    const source = new Uint8Array(0)
    const body = [...MAGIC, ...varint(0), ...varint(0x1000000 + 1), ...varint(0)]
    const result = applyBps(source, buildPatch(body, source))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/16 MiB/)
  })
})

describe('truncation and size mismatches are refused independently of each other', () => {
  it('refuses when a single action would overrun the declared target size', () => {
    const source = Uint8Array.from([1])
    // target size 1, but a TargetRead of length 2 is asked to start at 0.
    const body = [...MAGIC, 0x81, 0x81, 0x80, 0x85]
    const result = applyBps(source, buildPatch(body, source))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/reads past the end of the target/)
  })

  it('refuses when the actions produce fewer bytes than the declared target size', () => {
    const source = Uint8Array.from([1])
    // target size 3, but the only action (SourceRead len 1) produces 1 byte.
    const body = [...MAGIC, 0x81, 0x83, 0x80, 0x80]
    const result = applyBps(source, buildPatch(body, source))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/produced 1 bytes, not the 3 declared/)
  })

  it('refuses when the source length itself differs, not just its content', () => {
    const source = bytes(0x40, 50)
    const wrongLengthSource = bytes(0x41, 50) // one byte longer
    const patch = encodeBps(source, bytes(0x40, 51))
    const result = applyBps(wrongLengthSource, patch)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/source is \d+ bytes but the patch expects \d+/)
  })

  it('refuses a patch cut short mid-action, rebuilding a correctly-aligned trailer so truncation itself is what is caught', () => {
    const source = bytes(0x40, 60)
    const target = bytes(0x80, 61) // larger target forces a real multi-byte action stream
    const full = encodeBps(source, target)
    const trailerStart = full.length - 12
    // Drop the last 10 bytes of the ACTION stream, then append a fresh,
    // correctly-placed trailer - slicing the full file's own trailer would
    // instead misalign it onto leftover action bytes and trip the source
    // checksum check instead of the truncation this test targets.
    const shortBody = Array.from(full.subarray(0, trailerStart - 10))
    const cut = buildPatch(shortBody, source)

    const result = applyBps(source, cut)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/truncated/)
  })
})

describe('other refusals, each with a reason', () => {
  it('refuses a source with one byte changed, naming the checksum mismatch', () => {
    const source = bytes(0x80, 10)
    const target = bytes(0x80, 11)
    const patch = encodeBps(source, target)

    const wrongSource = Uint8Array.from(source)
    wrongSource[0x40] ^= 0xff

    const result = applyBps(wrongSource, patch)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/checksum/i)
  })

  it('refuses a bad magic number', () => {
    const source = bytes(0x40, 12)
    const target = bytes(0x40, 13)
    const patch = Uint8Array.from(encodeBps(source, target))
    patch[0] = 0x00 // was 'B'

    const result = applyBps(source, patch)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/magic/i)
  })
})

/**
 * Proof each refusal is reachable, not vacuous: corrupt exactly the field a
 * check exists for, repairing the patch checksum so that check does not
 * fire first and mask the one under test.
 */
describe('each refusal can be planted independently', () => {
  it('a flipped target byte is caught by the target checksum, not the patch checksum', () => {
    const source = bytes(0x60, 20)
    const target = bytes(0x60, 21)
    const patch = Uint8Array.from(encodeBps(source, target))
    const trailerStart = patch.length - 12
    patch[trailerStart + 4] ^= 0xff // the stored target CRC, not the bytes it covers
    repairPatchCrc(patch)

    const result = applyBps(source, patch)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/target checksum/i)
  })

  it('a corrupted patch checksum alone is caught before the source is even read', () => {
    const source = bytes(0x40, 22)
    const target = bytes(0x40, 23)
    const patch = Uint8Array.from(encodeBps(source, target))
    patch[patch.length - 1] ^= 0xff // the patch CRC's own bytes, nothing it covers

    const result = applyBps(source, patch)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/patch is corrupt/i)
  })
})
