import { describe, it, expect } from 'vitest'
import { encodeIps, decodeIps } from '../../../src/rom/Ips'
import { Patch, applyPatches } from '../../../src/rom/PatchLayer'

const rom = (): Uint8Array => Uint8Array.from({ length: 0x400 }, (_, i) => i & 0xff)

describe('IPS round trip', () => {
  it('survives a single byte', () => {
    const p: Patch[] = [{ offset: 0x120, value: 0xab }]
    expect(decodeIps(encodeIps(p))).toEqual(p)
  })

  it('survives scattered bytes', () => {
    const p: Patch[] = [
      { offset: 0x10, value: 1 },
      { offset: 0x200, value: 2 },
      { offset: 0x3ff, value: 3 },
    ]
    expect(decodeIps(encodeIps(p))).toEqual(p)
  })

  it('produces the same ROM as applying the patches directly', () => {
    const p: Patch[] = [
      { offset: 5, value: 0xaa },
      { offset: 6, value: 0xbb },
      { offset: 0x100, value: 0xcc },
    ]
    expect(applyPatches(rom(), decodeIps(encodeIps(p))!)).toEqual(applyPatches(rom(), p))
  })

  it('collapses consecutive bytes into one record but decodes them individually', () => {
    const p: Patch[] = [0, 1, 2, 3].map(n => ({ offset: 0x40 + n, value: 0xf0 + n }))
    const encoded = encodeIps(p)
    // 5 magic + 3 offset + 2 size + 4 data + 3 eof
    expect(encoded.length).toBe(17)
    expect(decodeIps(encoded)).toEqual(p)
  })

  it('sorts by offset, so input order does not change the file', () => {
    const a: Patch[] = [
      { offset: 9, value: 2 },
      { offset: 8, value: 1 },
    ]
    const b: Patch[] = [
      { offset: 8, value: 1 },
      { offset: 9, value: 2 },
    ]
    expect(encodeIps(a)).toEqual(encodeIps(b))
  })

  it('lets a later patch win on a repeated offset, matching flatten', () => {
    const p: Patch[] = [
      { offset: 7, value: 0x11 },
      { offset: 7, value: 0x22 },
    ]
    expect(decodeIps(encodeIps(p))).toEqual([{ offset: 7, value: 0x22 }])
  })

  it('writes a real IPS header and terminator', () => {
    const b = encodeIps([{ offset: 1, value: 1 }])
    expect(Array.from(b.slice(0, 5))).toEqual([0x50, 0x41, 0x54, 0x43, 0x48])
    expect(Array.from(b.slice(-3))).toEqual([0x45, 0x4f, 0x46])
  })
})

describe('IPS limits are refused, not fudged', () => {
  it('rejects an offset past 16 MB', () => {
    expect(() => encodeIps([{ offset: 0x1000000, value: 1 }])).toThrow(RangeError)
  })

  // Those three bytes read as "EOF", so a decoder stops there and the rest of
  // the patch silently vanishes.
  it('rejects a record starting at the offset that spells EOF', () => {
    expect(() => encodeIps([{ offset: 0x454f46, value: 1 }])).toThrow(/EOF marker/)
  })
})

describe('a malformed file decodes to null, never to partial patches', () => {
  it.each([
    ['empty', []],
    ['wrong magic', [0x4e, 0x4f, 0x50, 0x45, 0x21, 0x45, 0x4f, 0x46]],
    ['truncated header', [0x50, 0x41, 0x54, 0x43]],
  ])('%s', (_name, bytes) => {
    expect(decodeIps(Uint8Array.from(bytes))).toBeNull()
  })

  it('a record claiming more data than the file holds', () => {
    // offset 0, size 0x10, but only two data bytes follow
    const bytes = [0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 0, 0x00, 0x10, 1, 2]
    expect(decodeIps(Uint8Array.from(bytes))).toBeNull()
  })

  it('no terminator at all', () => {
    const bytes = [0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 1, 0x00, 0x01, 0xff]
    expect(decodeIps(Uint8Array.from(bytes))).toBeNull()
  })
})

describe('RLE records, which other patchers emit', () => {
  it('expands a run into individual patches', () => {
    // offset $000010, size 0 (RLE), run 4, value $CD
    const bytes = [0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 0x10, 0, 0, 0, 4, 0xcd, 0x45, 0x4f, 0x46]
    expect(decodeIps(Uint8Array.from(bytes))).toEqual(
      [0, 1, 2, 3].map(n => ({ offset: 0x10 + n, value: 0xcd })),
    )
  })

  it('rejects a zero-length run rather than looping forever', () => {
    const bytes = [0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 0x10, 0, 0, 0, 0, 0xcd, 0x45, 0x4f, 0x46]
    expect(decodeIps(Uint8Array.from(bytes))).toBeNull()
  })
})

/** Proof the round-trip assertions above can actually fail. */
describe('the oracle can fail', () => {
  it('an encoder that dropped the last record would break the round trip', () => {
    const p: Patch[] = [
      { offset: 0x10, value: 1 },
      { offset: 0x200, value: 2 },
    ]
    const good = encodeIps(p)
    // Chop the final record out, keeping the terminator.
    const broken = Uint8Array.from([...good.slice(0, good.length - 9), ...good.slice(-3)])
    expect(decodeIps(broken)).not.toEqual(p)
    expect(decodeIps(good)).toEqual(p)
  })
})

describe('IPS decode budget', () => {
  // RLE records of the maximum length, then EOF; offsets are irrelevant to the budget.
  const rleIps = (records: number, lastLength = 0xffff): Uint8Array => {
    const out: number[] = [0x50, 0x41, 0x54, 0x43, 0x48]
    for (let r = 0; r < records; r++) {
      const len = r === records - 1 ? lastLength : 0xffff
      out.push(0, 0, 0, 0, 0, len >> 8, len & 0xff, 0x7f)
    }
    out.push(0x45, 0x4f, 0x46)
    return Uint8Array.from(out)
  }

  it('rejects a patch whose decoded writes exceed the budget, without expanding it', () => {
    const t = Date.now()
    expect(decodeIps(rleIps(1000))).toBeNull() // ~65M writes, far past 2^24
    expect(Date.now() - t).toBeLessThan(500)
  })

  it('accepts a patch landing exactly on the budget and rejects one write more', () => {
    const ips = rleIps(3, 100) // 2 * 65535 + 100 writes
    const total = 2 * 0xffff + 100
    expect(decodeIps(ips, total)!.length).toBe(total)
    expect(decodeIps(ips, total - 1)).toBeNull()
  })

  it('applies the budget to literal records too', () => {
    const ips = encodeIps([
      { offset: 0, value: 1 },
      { offset: 2, value: 2 },
      { offset: 4, value: 3 },
    ])
    expect(decodeIps(ips, 3)).toHaveLength(3)
    expect(decodeIps(ips, 2)).toBeNull()
  })

  it('accepts a real-size patch (~3M writes) under the default budget', () => {
    expect(decodeIps(rleIps(46))).toHaveLength(46 * 0xffff)
  })

  it('counts every byte of a literal record against the budget', () => {
    const ips = Uint8Array.from([
      0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 0, 0, 3, 1, 2, 3, 0x45, 0x4f, 0x46,
    ])
    expect(decodeIps(ips, 3)).toHaveLength(3)
    expect(decodeIps(ips, 2)).toBeNull()
  })

  it('refuses a budget that would disable the limit', () => {
    for (const b of [NaN, -1, 1.5, Infinity])
      expect(() => decodeIps(rleIps(1), b)).toThrow(RangeError)
  })
})
