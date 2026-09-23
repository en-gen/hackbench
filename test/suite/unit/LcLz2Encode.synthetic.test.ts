/**
 * LC_LZ2 encoder - synthetic byte-vector tests.
 *
 * **No bytes here come from any Super Mario World ROM or derived resource.**
 * Every stream is hand-built from the header encoding documented in
 * src/rom/LcLz2.ts, so these run in CI where test/roms/ is absent by design.
 *
 * The encoder's whole reason for existing is that a from-scratch greedy
 * encoder does not fit the cartridge: measured on the vanilla cart, a correct
 * greedy re-encode of the UNEDITED 50 GFX files came to 117,834 bytes against
 * the cart's own 107,284, worse on 50 of 50 files (throwaway probe, one
 * machine, 5 cartridges). So the contract these tests pin is not "small
 * output" but two things a size measurement cannot check for us:
 *
 *   1. decompress(encode(x)) === x, always.
 *   2. encode(decompress(s), s) === s, byte for byte, when nothing changed.
 *
 * (2) is what makes an edit's cost proportional to the edit: the commands the
 * edit did not touch come back out identical, back-references included.
 */
import { describe, it, expect } from 'vitest'
import { decompress, encode, parseStream } from '../../../src/rom/LcLz2'

const hdr = (cmd: number, len: number): number => ((cmd & 7) << 5) | ((len - 1) & 0x1f)
const hdrExt = (cmd: number, len: number): [number, number] => [
  0xe0 | ((cmd & 7) << 2) | (((len - 1) >> 8) & 3),
  (len - 1) & 0xff,
]
const FF = 0xff
const bytes = (a: number[]): Uint8Array => Uint8Array.from(a)
const arr = (u: Uint8Array): number[] => Array.from(u)

/** One stream per command type, plus an extended-header case. Named so a
 *  failure says which command shape broke rather than "case 3". */
const TEMPLATES: Record<string, number[]> = {
  'literals only': [hdr(0, 4), 1, 2, 3, 4, FF],
  'byte fill': [hdr(1, 10), 0xaa, FF],
  'word fill': [hdr(2, 9), 0x12, 0x34, FF],
  'increasing fill': [hdr(3, 6), 0xf0, FF],
  'back-reference': [hdr(0, 4), 9, 8, 7, 6, hdr(4, 4), 0x00, 0x00, FF],
  'back-reference past the write head reads zero': [hdr(0, 2), 5, 6, hdr(4, 3), 0x00, 0x40, FF],
  'extended literal run': [...hdrExt(0, 40), ...Array.from({ length: 40 }, (_, i) => i), FF],
  'extended byte fill': [...hdrExt(1, 300), 0x5a, FF],
  'every command in one stream': [
    hdr(0, 3),
    1,
    2,
    3,
    hdr(1, 8),
    0x77,
    hdr(2, 7),
    0xab,
    0xcd,
    hdr(3, 5),
    0x10,
    hdr(4, 6),
    0x00,
    0x02,
    ...hdrExt(1, 100),
    0x01,
    FF,
  ],
  'empty stream': [FF],
}

const TEMPLATE_NAMES = Object.keys(TEMPLATES)

describe('parseStream', () => {
  it.each(TEMPLATE_NAMES)('measures %s', name => {
    const src = bytes(TEMPLATES[name]!)
    const s = parseStream(src)
    expect(s.terminated).toBe(true)
    expect(s.byteLength).toBe(src.length)
    expect(s.outputLength).toBe(decompress(src).length)
  })

  it('reports an unterminated stream rather than inventing a terminator', () => {
    // A stream that runs off the end of the buffer is not one we can
    // re-encode: treating the truncation point as a terminator is how a
    // half-read file becomes a confidently-wrong write.
    const s = parseStream(bytes([hdr(0, 8), 1, 2, 3]))
    expect(s.terminated).toBe(false)
  })

  it('parses from an offset, ignoring what precedes it', () => {
    const src = bytes([0xde, 0xad, ...TEMPLATES['byte fill']!])
    const s = parseStream(src, 2)
    expect(s.byteLength).toBe(TEMPLATES['byte fill']!.length)
    expect(s.outputLength).toBe(10)
  })
})

describe('encode round trip', () => {
  const INPUTS: Record<string, Uint8Array> = {
    empty: new Uint8Array(0),
    'one byte': bytes([0x42]),
    'flat run': new Uint8Array(500).fill(0x3c),
    'alternating word': Uint8Array.from({ length: 401 }, (_, i) => (i % 2 ? 0xcd : 0xab)),
    ascending: Uint8Array.from({ length: 700 }, (_, i) => i & 0xff),
    'pseudo random': (() => {
      // Deterministic LCG, so a failure reproduces. Nothing ROM-derived.
      let x = 12345
      return Uint8Array.from({ length: 3072 }, () => {
        x = (x * 1103515245 + 12345) & 0x7fffffff
        return (x >> 16) & 0xff
      })
    })(),
    'longer than one extended run': new Uint8Array(2500).fill(0x01),
  }

  it.each(Object.keys(INPUTS))('decompress(encode(%s)) === the input', name => {
    const input = INPUTS[name]!
    expect(arr(decompress(encode(input)))).toEqual(arr(input))
  })

  it.each(TEMPLATE_NAMES)('decompress(encode(x, %s template)) === x', name => {
    const src = bytes(TEMPLATES[name]!)
    const out = decompress(src)
    expect(arr(decompress(encode(out, src)))).toEqual(arr(out))
  })
})

describe('structure preservation', () => {
  it.each(TEMPLATE_NAMES)('re-encoding %s unchanged reproduces it byte for byte', name => {
    const src = bytes(TEMPLATES[name]!)
    expect(arr(encode(decompress(src), src))).toEqual(arr(src))
  })

  it('keeps every untouched command when one byte changes', () => {
    const src = bytes(TEMPLATES['every command in one stream']!)
    const out = decompress(src)
    const edited = Uint8Array.from(out)
    edited[4] ^= 0xff // inside the byte fill, which can no longer reproduce it

    const re = encode(edited, src)
    expect(arr(decompress(re))).toEqual(arr(edited))
    // One broken command, so the cost is bounded by replacing that command's
    // output, not by re-encoding the file.
    expect(re.length - src.length).toBeLessThanOrEqual(8)
  })

  it('reclaims bytes when an edit makes a literal region uniform', () => {
    // Painting a region flat is the case the spike could not measure without
    // a real encoder: a literal run that becomes uniform re-encodes as a fill.
    const src = bytes([...hdrExt(0, 200), ...Array.from({ length: 200 }, (_, i) => i & 0xff), FF])
    const flat = new Uint8Array(200).fill(0x11)
    const re = encode(flat, src)
    expect(arr(decompress(re))).toEqual(arr(flat))
    expect(re.length).toBeLessThan(src.length)
  })

  it('a changed byte under a back-reference is re-encoded, not silently copied', () => {
    const src = bytes(TEMPLATES['back-reference']!)
    const out = decompress(src)
    const edited = Uint8Array.from(out)
    edited[5] = 0x99 // inside the cmd-4 output; the source bytes still say 8
    const re = encode(edited, src)
    expect(arr(decompress(re))).toEqual(arr(edited))
  })

  it('a changed byte under a back-reference SOURCE re-encodes both halves', () => {
    const src = bytes(TEMPLATES['back-reference']!)
    const out = decompress(src)
    const edited = Uint8Array.from(out)
    edited[1] = 0x99 // the cmd-4 reads this; its own output must not follow
    const re = encode(edited, src)
    expect(arr(decompress(re))).toEqual(arr(edited))
  })

  it('every single-byte edit in a stream round trips', () => {
    // Not a single-case acceptance test: one convenient index proves nothing
    // about the rest, and the command boundaries are exactly where this
    // would break.
    const src = bytes(TEMPLATES['every command in one stream']!)
    const out = decompress(src)
    const broken: number[] = []
    for (let i = 0; i < out.length; i++) {
      const edited = Uint8Array.from(out)
      edited[i] ^= 0x5a
      const re = encode(edited, src)
      if (arr(decompress(re)).join() !== arr(edited).join()) broken.push(i)
    }
    expect(broken).toEqual([])
  })
})

describe('encode refusals', () => {
  it('refuses a template whose output length is not the data length', () => {
    const src = bytes(TEMPLATES['byte fill']!) // 10 bytes out
    expect(() => encode(new Uint8Array(11), src)).toThrow(/length/i)
  })

  it('refuses an unterminated template rather than re-encoding a partial read', () => {
    expect(() => encode(new Uint8Array(8), bytes([hdr(0, 8), 1, 2, 3]))).toThrow(/terminat/i)
  })

  it('refuses data the format cannot address', () => {
    // Command 4's operand is 16 bits, so output past $10000 cannot be
    // back-referenced and the format stops being safe to emit into.
    expect(() => encode(new Uint8Array(0x10001))).toThrow(/65536|0x10000|too large/i)
  })
})

describe('the round-trip oracle goes red on a planted defect', () => {
  it('a corrupted byte anywhere in the encoded stream fails the round trip', () => {
    const data = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff)
    const clean = encode(data)
    // Sweep every position: an oracle that only catches a defect at byte 0
    // is not an oracle.
    const survived: number[] = []
    for (let at = 0; at < clean.length - 1; at++) {
      const bad = Uint8Array.from(clean)
      bad[at] = (bad[at]! + 1) & 0xff
      if (arr(decompress(bad)).join() === arr(data).join()) survived.push(at)
    }
    expect(survived).toEqual([])
  })

  it('a truncated encode fails the round trip', () => {
    const data = new Uint8Array(200).fill(0x20)
    const truncated = encode(data).subarray(0, 2)
    expect(decompress(truncated).length).not.toBe(data.length)
  })
})
