/** The pure parts of hack-fetch (#543): each refusal is pinned so a loosened check goes red. */
import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'zlib'
import {
  applyPatch,
  candidates,
  curlArgs,
  flagValue,
  indexRecord,
  looksLikeHtml,
  patchBasename,
  pickPatch,
  processArchive,
  readIndex,
  storeInsideRepo,
  unsafeEntry,
  validListing,
  zipEntries,
  zipRead,
  type ListingItem,
} from '../../../tools/scripts/hackFetch'

const item = (id: number, over: Partial<ListingItem> = {}): ListingItem => ({
  id,
  name: `Hack ${id}`,
  authors: [{ name: 'a' }],
  rating: 4,
  rating_count: 2,
  downloads: id,
  download_url: `https://dl.example/${id}.zip`,
  obsoleted_by: null,
  fields: { version: '1.0', type: 'Standard', difficulty: 'Casual' },
  ...over,
})

/** A zip built by hand: one stored entry and one deflated entry. */
function makeZip(files: [string, Uint8Array, 0 | 8][]): Uint8Array {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, data, method] of files) {
    const body = method === 8 ? deflateRawSync(data) : Buffer.from(data)
    const nm = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nm.length, 26)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nm.length, 28)
    cd.writeUInt32LE(offset, 42)
    parts.push(local, nm, body)
    central.push(cd, nm)
    offset += 30 + nm.length + body.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...parts, dir, end]))
}
const bytes = (s: string) => new TextEncoder().encode(s)

describe('hack-fetch (synthetic)', () => {
  it('lists only hacks missing from the store, most downloaded first, never obsoleted ones', () => {
    const got = candidates([item(1), item(5), item(3, { obsoleted_by: 9 }), item(4)], new Set([1]))
    expect(got.map(c => c.id)).toEqual([5, 4])
  })
  it('treats an HTML answer as a stop and a zip or JSON as fine', () => {
    expect(looksLikeHtml(bytes('  <!DOCTYPE html><html>'))).toBe(true)
    expect(looksLikeHtml(bytes('<html>'))).toBe(true)
    expect(looksLikeHtml(bytes('PK\u0003\u0004'))).toBe(false)
    expect(looksLikeHtml(bytes('{"data":[]}'))).toBe(false)
  })
  it('flags archive entries that could escape the extraction directory', () => {
    for (const p of ['../x.bps', 'a/../../x', '/etc/x', 'C:/x', String.raw`a\..\x`])
      expect(unsafeEntry(p)).toBe(true)
    for (const p of ['x.bps', 'dir/x.bps', 'a..b/x']) expect(unsafeEntry(p)).toBe(false)
  })
  it('picks exactly one patch and records why otherwise', () => {
    expect(pickPatch(['readme.txt', 'Hack.BPS'])).toEqual({
      ok: true,
      file: 'Hack.BPS',
      format: 'bps',
    })
    expect(pickPatch(['a.ips'])).toEqual({ ok: true, file: 'a.ips', format: 'ips' })
    expect(pickPatch(['readme.txt', 'game.smc'])).toEqual({
      ok: false,
      reason: 'no .bps or .ips in the archive',
    })
    expect(pickPatch(['a.bps', 'b.ips'])).toMatchObject({ ok: false })
  })
  it('writes the index record in the shape of the existing entries, and null paths for a failure', () => {
    const base = {
      item: item(7),
      patchSha256: 'p',
      patchFormat: 'bps',
      sourceZipSha256: 'z',
      patchedRomSha256: 'r',
      patchedRomSize: 8,
      baseRomSha256: 'b',
      date: '2026-10-10',
    }
    expect(indexRecord({ ...base, failure: null })).toMatchObject({
      smwc_id: 7,
      patch_result: 'success',
      patched_rom_file: 'roms/7.sfc',
      smwc_type: 'Standard',
      authors: ['a'],
    })
    const failed = indexRecord({
      ...base,
      failure: 'no .bps',
      patchedRomSha256: null,
      patchedRomSize: null,
    })
    expect(failed).toMatchObject({
      patch_result: 'failed',
      patched_rom_file: null,
      failure_reason: 'no .bps',
    })
  })
  it('lists and reads stored and deflated zip entries, and refuses a non-zip', () => {
    const zip = makeZip([
      ['a/readme.txt', bytes('hello'), 0],
      ['Hack.bps', bytes('BPS1'.repeat(50)), 8],
    ])
    const entries = zipEntries(zip)
    expect(entries.map(e => e.name)).toEqual(['a/readme.txt', 'Hack.bps'])
    expect(new TextDecoder().decode(zipRead(zip, entries[0]!))).toBe('hello')
    expect(new TextDecoder().decode(zipRead(zip, entries[1]!))).toBe('BPS1'.repeat(50))
    expect(() => zipEntries(bytes('<html>not a zip</html>'))).toThrow('not a zip')
  })

  it('skips a UTF-8 byte-order mark before judging a blocked answer', () => {
    expect(looksLikeHtml(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('<html>')]))).toBe(true)
    expect(looksLikeHtml(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('{"data":[]}')]))).toBe(false)
  })
})

/** Patches one little-endian field of the first central-directory record, the end record, or nothing. */
function patched(zip: Uint8Array, at: 'cd' | 'eocd', field: number, value: number, w: 2 | 4 = 4) {
  const copy = new Uint8Array(zip)
  const v = new DataView(copy.buffer)
  let base = copy.length - 22
  if (at === 'cd') {
    base = 0
    while (v.getUint32(base, true) !== 0x02014b50) base++
  }
  if (w === 4) v.setUint32(base + field, value, true)
  else v.setUint16(base + field, value, true)
  return copy
}
const oneZip = () => makeZip([['Hack.bps', bytes('BPS1'.repeat(10)), 0]])

describe('hack-fetch zip refusals (synthetic)', () => {
  it('refuses more than 5000 entries', () => {
    expect(() => zipEntries(patched(oneZip(), 'eocd', 10, 5001, 2))).toThrow('5001 entries')
    expect(zipEntries(patched(oneZip(), 'eocd', 10, 1, 2))).toHaveLength(1)
  })
  it('refuses a central directory whose signature is wrong', () => {
    expect(() => zipEntries(patched(oneZip(), 'cd', 0, 0x12345678))).toThrow('bad central')
  })
  it('refuses a central record whose name or extra field runs past the archive', () => {
    expect(() => zipEntries(patched(oneZip(), 'cd', 28, 60000, 2))).toThrow('bad central')
    expect(() => zipEntries(patched(oneZip(), 'cd', 30, 60000, 2))).toThrow('bad central')
  })
  it('refuses a central directory that starts outside the archive', () => {
    expect(() => zipEntries(patched(oneZip(), 'eocd', 16, 0xffffff))).toThrow('bad central')
  })
  it('refuses an entry over 256 MiB unpacked, by either size field', () => {
    const big = 300 * 1024 * 1024
    const unpacked = patched(oneZip(), 'cd', 24, big)
    expect(() => zipRead(unpacked, zipEntries(unpacked)[0]!)).toThrow('over the limit')
    const stored = patched(oneZip(), 'cd', 20, big)
    expect(() => zipRead(stored, zipEntries(stored)[0]!)).toThrow('over the limit')
  })
  it('refuses a bad local header', () => {
    const zip = oneZip()
    const e = zipEntries(zip)[0]!
    new DataView(zip.buffer).setUint32(e.offset, 0, true)
    expect(() => zipRead(zip, e)).toThrow('bad local header')
  })
  it('refuses a method other than stored or deflate', () => {
    const zip = patched(oneZip(), 'cd', 10, 12, 2)
    expect(() => zipRead(zip, zipEntries(zip)[0]!)).toThrow('unsupported zip method 12')
  })
  it('refuses entry ranges that leave the archive', () => {
    const zip = oneZip()
    const e = zipEntries(zip)[0]!
    expect(() => zipRead(zip, { ...e, offset: zip.length })).toThrow('range')
    expect(() => zipRead(zip, { ...e, offset: zip.length + 1000 })).toThrow('range')
    expect(() => zipRead(zip, { ...e, csize: zip.length })).toThrow('range')
  })
})

describe('hack-fetch command pieces (synthetic)', () => {
  const vanilla = new Uint8Array(16).fill(1)
  const ips = (...records: number[][]) =>
    new Uint8Array([...bytes('PATCH'), ...records.flat(), ...bytes('EOF')])

  it('rejects an IPS record that ends past 16 MiB, accepts one ending exactly there', () => {
    expect(applyPatch(vanilla, ips([0xff, 0xff, 0xff, 0, 2, 7, 7]), 'ips')).toMatch(/16 MiB/)
    expect(applyPatch(vanilla, ips([0xff, 0xff, 0xff, 0, 0, 0xff, 0xff, 9]), 'ips')).toMatch(
      /16 MiB/,
    )
    const ok = applyPatch(vanilla, ips([0xff, 0xff, 0xfe, 0, 2, 7, 8]), 'ips') as Uint8Array
    expect(ok.length).toBe(0x1000000)
    expect(ok[0xfffffe]).toBe(7)
    expect(ok[0xffffff]).toBe(8)
  })

  it('refuses a malformed IPS and applies a small one', () => {
    expect(applyPatch(vanilla, bytes('nope'), 'ips')).toMatch(/refused/)
    const out = applyPatch(vanilla, ips([0, 0, 2, 0, 1, 9]), 'ips') as Uint8Array
    expect([...out.subarray(0, 4)]).toEqual([1, 1, 9, 1])
  })

  it('writes only the last path part of a patch name, either separator, never a dot name', () => {
    expect(patchBasename('a/b/Hack.bps')).toBe('Hack.bps')
    expect(patchBasename(String.raw`a\b\Hack.bps`)).toBe('Hack.bps')
    expect(patchBasename('Hack.bps')).toBe('Hack.bps')
    for (const bad of ['dir/', '..', 'a/..', '.']) expect(patchBasename(bad)).toBeNull()
  })

  it('treats a store inside the repository as a refusal, a sibling as fine', () => {
    expect(storeInsideRepo('/r/repo/hacks', '/r/repo')).toBe(true)
    expect(storeInsideRepo('/r/repo', '/r/repo')).toBe(true)
    expect(storeInsideRepo('/r/repo/../hacks', '/r/repo')).toBe(false)
    expect(storeInsideRepo('/r/repo-tools/hacks', '/r/repo')).toBe(false)
  })

  it('builds curl arguments that allow https only, follow only to https, and fail on HTTP errors', () => {
    const a = curlArgs('https://x/y.zip', '/t/o.zip')
    expect(a).toContain('-f')
    expect(a.join(' ')).toContain('--proto =https')
    expect(a.join(' ')).toContain('--proto-redir =https')
    expect(a.at(-1)).toBe('https://x/y.zip')
    expect(curlArgs('https://x').includes('-o')).toBe(false)
  })

  it('reads an index only when it parses and holds a hacks array of records with ids', () => {
    expect(readIndex('{"hacks":[{"smwc_id":3}]}').hacks).toHaveLength(1)
    expect(() => readIndex('not json')).toThrow(/index\.json/)
    expect(() => readIndex('{}')).toThrow(/hacks/)
    expect(() => readIndex('{"hacks":{}}')).toThrow(/hacks/)
    expect(() => readIndex('{"hacks":[null]}')).toThrow(/record/)
    expect(() => readIndex('{"hacks":[{"smwc_id":"3"}]}')).toThrow(/smwc_id/)
  })

  it('keeps only listing rows whose id is a positive integer and whose link is https', () => {
    const rows = [
      item(5),
      { ...item(6), id: '../../outside' },
      item(7, { download_url: 'http://dl.example/7.zip' }),
      item(8, { download_url: 'file:///etc/passwd' }),
      { ...item(9), authors: null },
      item(-4),
      item(1.5),
      null,
    ]
    expect(validListing({ data: rows }).map(i => i.id)).toEqual([5])
    expect(() => validListing({})).toThrow(/data/)
    expect(() => validListing(null)).toThrow(/data/)
  })

  it('a path-traversal id never reaches the candidate list', () => {
    const listed = validListing({ data: [{ ...item(6), id: '../../outside' }, item(2)] })
    expect(candidates(listed, new Set()).map(c => c.id)).toEqual([2])
  })

  it('flag values: absent is undefined, present needs a value that is not another flag', () => {
    expect(flagValue(['--next'], '--out')).toBeUndefined()
    expect(flagValue(['--out', 'f.json'], '--out')).toBe('f.json')
    expect(() => flagValue(['--out'], '--out')).toThrow('--out needs a value')
    expect(() => flagValue(['--out', '--count'], '--out')).toThrow('--out needs a value')
  })

  describe('processArchive', () => {
    const run = (z: Uint8Array) => processArchive(z, vanilla)
    it('refuses an unsafe entry name before reading anything', () => {
      const r = run(makeZip([['../evil.bps', bytes('x'), 0]]))
      expect(r.failure).toMatch(/unsafe archive entry/)
      expect(r.patch).toBeNull()
    })
    it('records no patch, two patches and a corrupt entry as failures, not throws', () => {
      expect(run(makeZip([['r.txt', bytes('x'), 0]])).failure).toMatch(/no \.bps or \.ips/)
      expect(
        run(
          makeZip([
            ['a.bps', bytes('x'), 0],
            ['b.ips', bytes('x'), 0],
          ]),
        ).failure,
      ).toMatch(/2 patch files/)
      const zip = makeZip([['a.ips', bytes('x'), 0]])
      new DataView(zip.buffer).setUint32(0, 0, true)
      expect(run(zip).failure).toMatch(/bad local header/)
      expect(run(bytes('<html>')).failure).toMatch(/not a zip/)
    })
    it('records a patch that fails to apply, and returns the ROM for one that does', () => {
      expect(run(makeZip([['a.ips', bytes('junk'), 0]])).failure).toMatch(/ips apply failed/)
      const good = run(makeZip([[String.raw`sub\a.ips`, ips([0, 0, 2, 0, 1, 9]), 0]]))
      expect(good.failure).toBeNull()
      expect(good.patch?.name).toBe('a.ips')
      expect([...good.rom!.subarray(0, 3)]).toEqual([1, 1, 9])
    })
  })
})
