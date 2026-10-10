/** The pure parts of hack-fetch (#543): each refusal is pinned so a loosened check goes red. */
import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'zlib'
import {
  candidates,
  indexRecord,
  looksLikeHtml,
  pickPatch,
  unsafeEntry,
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
})
