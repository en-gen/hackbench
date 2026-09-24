/**
 * The in-memory decoded GFX state, and what saving it costs.
 *
 * **Synthetic cartridges only** (test/suite/support/syntheticGfxCart.ts), so
 * this runs in CI where the corpus is absent by design.
 *
 * The pixel op is the unit of intent: what is persisted is
 * `{ kind: 'gfxPixel', file, tile, x, y, value }`, never the resulting
 * bytes. src/rom/EditStack.ts says why. The byte-level arena rewrite is
 * derived on demand and thrown away.
 */
import { describe, it, expect } from 'vitest'
import { decompress, encode } from '../../../src/rom/LcLz2'
import { decodeTilesBatch, setTilePixel, planeOffsets } from '../../../src/rom/GraphicsDecoder'
import { GFX_FILE_COUNT, readGfxFileTable } from '../../../src/rom/GfxArena'
import { GfxTable, planGfxSave, readTilesPerFile } from '../../../src/rom/GfxTable'
import { RomFile } from '../../../src/rom/RomFile'
import {
  applyWrites,
  buildCart,
  gfxStreams,
  uploadGfxFileSite,
  UPLOAD_GFX_AT,
} from '../support/syntheticGfxCart'

/**
 * 11 tiles at 3bpp. Deliberately NOT a multiple of 16 or 32, so every file
 * infers 3bpp whatever the Layer 3 range on the synthetic cart says, and the
 * depth under test is the one the test names.
 */
const TILES = 11
const THREE_BPP_BYTES = TILES * 24

function cartWith3bppFiles(): ReturnType<typeof buildCart> {
  const streams = Array.from({ length: GFX_FILE_COUNT }, (_, i) =>
    encode(Uint8Array.from({ length: THREE_BPP_BYTES }, (_, k) => (i * 13 + k * 5) & 0xff)),
  )
  return buildCart({ streams, filler: 4096 })
}

describe('setTilePixel', () => {
  it.each([2, 3, 4] as const)('round trips every value at every position, %ibpp', bpp => {
    const bpt = bpp === 4 ? 32 : bpp === 3 ? 24 : 16
    const data = new Uint8Array(bpt)
    const wrong: string[] = []
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        for (let v = 0; v < 1 << bpp; v++) {
          setTilePixel(data, 0, bpp, x, y, v)
          const px = decodeTilesBatch(data, bpp)[0]!
          if (px[y * 8 + x] !== v) wrong.push(`${x},${y}=${v} read ${px[y * 8 + x]}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('touches only the pixel it was asked for', () => {
    const before = Uint8Array.from({ length: 24 }, (_, i) => (i * 37) & 0xff)
    const after = Uint8Array.from(before)
    setTilePixel(after, 0, 3, 3, 4, 5)
    const pxBefore = decodeTilesBatch(before, 3)[0]!
    const pxAfter = decodeTilesBatch(after, 3)[0]!
    const changed = [...pxAfter].map((v, i) => (v === pxBefore[i] ? -1 : i)).filter(i => i >= 0)
    expect(changed).toEqual([4 * 8 + 3])
  })

  it('refuses a value the depth cannot hold rather than truncating it', () => {
    expect(() => setTilePixel(new Uint8Array(24), 0, 3, 0, 0, 8)).toThrow(/3bpp/)
    expect(() => setTilePixel(new Uint8Array(16), 0, 2, 0, 0, 4)).toThrow(/2bpp/)
  })

  it('refuses a pixel outside the tile', () => {
    expect(() => setTilePixel(new Uint8Array(24), 0, 3, 8, 0, 1)).toThrow(/8x8/)
    expect(() => setTilePixel(new Uint8Array(24), 0, 3, 0, -1, 1)).toThrow(/8x8/)
  })

  it('refuses a tile that runs past the end of the sheet', () => {
    expect(() => setTilePixel(new Uint8Array(20), 0, 3, 0, 7, 4)).toThrow(/past the end/)
  })

  it('the plane layout is the decoder s own, not a second copy of it', () => {
    // A planted defect: swap two planes and the round trip must notice.
    expect(planeOffsets(3, 0, 5)).toEqual([10, 11, 21])
    expect(planeOffsets(4, 0, 5)).toEqual([10, 11, 26, 27])
    expect(planeOffsets(2, 0, 5)).toEqual([10, 11])
  })
})

describe('readTilesPerFile', () => {
  it('reads the count out of the upload loop rather than assuming 128', () => {
    expect(readTilesPerFile(buildCart().rom)).toBe(128)
  })

  it('follows a cartridge that changed the count', () => {
    const { rom } = buildCart({ uploadSite: uploadGfxFileSite(0x3f) })
    expect(readTilesPerFile(rom)).toBe(64)
  })

  it('reports unavailable rather than falling back when the site is gone', () => {
    // Never fall back to the vanilla value: a cart that no longer says 128
    // must not be told it said 128.
    expect(readTilesPerFile(buildCart({ uploadSite: null }).rom)).toBeNull()
  })

  it('reports unavailable when the site is ambiguous', () => {
    // Two candidates means we cannot say which one the game runs, and
    // picking the first would be a guess dressed as a reading.
    const { rom } = buildCart({ uploadSite: null })
    const buf = Buffer.from(rom.buffer)
    buf.set(uploadGfxFileSite(), UPLOAD_GFX_AT)
    buf.set(uploadGfxFileSite(0x3f), UPLOAD_GFX_AT + 0x40)
    expect(readTilesPerFile(new RomFile('synthetic.sfc', buf))).toBeNull()
  })
})

describe('GfxTable', () => {
  it('decodes every file the cartridge holds', () => {
    const table = GfxTable.load(cartWith3bppFiles().rom)
    expect(table.files.length).toBe(GFX_FILE_COUNT)
    expect(table.tilesPerFile).toBe(128)
    for (const f of table.files) {
      expect(f.bpp).toBe(3)
      expect(f.tileCount).toBe(TILES)
      expect(f.dirty).toBe(false)
    }
    expect(table.isDirty()).toBe(false)
    expect(table.dirtyFiles()).toEqual([])
  })

  it('reads a pixel back after setting it, and marks only that file dirty', () => {
    const table = GfxTable.load(cartWith3bppFiles().rom)
    const r = table.setPixel({ kind: 'gfxPixel', file: 7, tile: 9, x: 3, y: 5, value: 6 })

    expect(r.status).toBe('ok')
    expect(table.tile(7, 9)![5 * 8 + 3]).toBe(6)
    expect(table.dirtyFiles()).toEqual([7])
    expect(table.isDirty()).toBe(true)
  })

  it('refuses a pixel op it cannot place, in every direction', () => {
    const table = GfxTable.load(cartWith3bppFiles().rom)
    const base = { kind: 'gfxPixel' as const, file: 0, tile: 0, x: 0, y: 0, value: 0 }
    const refused = [
      { ...base, file: GFX_FILE_COUNT },
      { ...base, file: -1 },
      { ...base, tile: TILES },
      { ...base, x: 8 },
      { ...base, y: 8 },
      { ...base, value: 8 }, // 3bpp holds 0-7
    ]
    for (const op of refused) {
      const r = table.setPixel(op)
      expect(r.status, JSON.stringify(op)).toBe('refused')
    }
    expect(table.isDirty()).toBe(false)
  })

  it('refuses to paint a file whose bit depth it cannot read', () => {
    // GfxFileDto.defaultBpp is already nullable; such a file is read-only
    // until the user asserts a depth, and painting it blind would write
    // bitplanes into bytes that are not bitplanes.
    const streams = gfxStreams(7) // 7 bytes fits no tile at 2, 3 or 4bpp
    const table = GfxTable.load(buildCart({ streams }).rom)
    expect(table.files[0]!.bpp).toBeNull()
    expect(
      table.setPixel({ kind: 'gfxPixel', file: 0, tile: 0, x: 0, y: 0, value: 1 }).status,
    ).toBe('refused')
  })
})

describe('planGfxSave', () => {
  it('is a no-op plan when nothing is dirty', () => {
    const { rom } = cartWith3bppFiles()
    const r = planGfxSave(rom, GfxTable.load(rom))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    for (const w of r.plan.writes) {
      expect(
        Buffer.compare(Buffer.from(w.bytes), rom.readAtFileOffset(w.offset, w.bytes.length)!),
      ).toBe(0)
    }
  })

  it('a pixel op round trips through the cartridge bytes', () => {
    // The acceptance the spec asks for: set a pixel, save, reload from the
    // resulting bytes, read the same pixel back.
    const { rom } = cartWith3bppFiles()
    const table = GfxTable.load(rom)
    table.setPixel({ kind: 'gfxPixel', file: 4, tile: 9, x: 2, y: 6, value: 5 })

    const r = planGfxSave(rom, table)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return

    const after = applyWrites(rom, r.plan.writes)
    const reloaded = GfxTable.load(after)
    expect(reloaded.tile(4, 9)![6 * 8 + 2]).toBe(5)
    expect(reloaded.isDirty()).toBe(false)
    // and nothing else moved
    expect(reloaded.tile(4, 8)).toEqual(table.tile(4, 8))
    expect(reloaded.tile(5, 9)).toEqual(table.tile(5, 9))
  })

  it('every one of the 50 files survives a save', () => {
    // Not a single-case acceptance test: one file proves nothing about the
    // pointer rewrite for the other 49.
    const { rom } = cartWith3bppFiles()
    const table = GfxTable.load(rom)
    for (let i = 0; i < GFX_FILE_COUNT; i++) {
      table.setPixel({
        kind: 'gfxPixel',
        file: i,
        tile: i % TILES,
        x: i % 8,
        y: 1,
        value: (i % 7) + 1,
      })
    }
    const r = planGfxSave(rom, table)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return

    const after = applyWrites(rom, r.plan.writes)
    const wrong: number[] = []
    for (let i = 0; i < GFX_FILE_COUNT; i++) {
      const px = GfxTable.load(after).tile(i, i % TILES)
      if (!px || px[1 * 8 + (i % 8)] !== (i % 7) + 1) wrong.push(i)
    }
    expect(wrong).toEqual([])
    for (const f of readGfxFileTable(after)) {
      expect(f.terminated, `file ${f.index} stream`).toBe(true)
      expect(f.outputLength, `file ${f.index} length`).toBe(THREE_BPP_BYTES)
    }
  })

  it('refuses when a re-encoded stream does not decompress back to its own length', () => {
    // The oracle the spec asks for, planted: a truncated encode must be
    // caught before it reaches the cartridge, not after.
    const { rom } = cartWith3bppFiles()
    const table = GfxTable.load(rom)
    const truncating = (data: Uint8Array, template?: Uint8Array): Uint8Array =>
      encode(data, template).subarray(0, 4)
    const r = planGfxSave(rom, table, truncating)
    expect(r.status).toBe('unavailable')
    if (r.status !== 'unavailable') return
    expect(r.reason).toMatch(/decompress/i)
  })

  it('the length oracle is not fooled by a stream of the right size', () => {
    // An encoder that produced the wrong CONTENT at the right length must
    // still be caught, so the check compares bytes and not only lengths.
    const { rom } = cartWith3bppFiles()
    const table = GfxTable.load(rom)
    const scrambling = (data: Uint8Array): Uint8Array => {
      const flipped = Uint8Array.from(data)
      flipped[0] = (flipped[0]! + 1) & 0xff
      return encode(flipped)
    }
    const r = planGfxSave(rom, table, scrambling)
    expect(r.status).toBe('unavailable')
  })

  it('turns an encoder that THROWS into a refusal, not an escaping exception', () => {
    // Every other refusal returns a status. This one has to as well: an
    // exception out of the save path crashes the caller instead of telling
    // the user why nothing was written.
    const { rom } = cartWith3bppFiles()
    const throwing = (): Uint8Array => {
      throw new Error('template stream is not terminated')
    }
    const r = planGfxSave(rom, GfxTable.load(rom), throwing)
    expect(r.status).toBe('unavailable')
    if (r.status !== 'unavailable') return
    expect(r.reason).toMatch(/did not re-encode/)
    expect(r.reason).toMatch(/not terminated/)
  })

  it('refuses a cartridge whose decompressor has been replaced', () => {
    const entryBytes = [0x22, 0, 0, 0x20, 0xea, 0x22, 0, 0, 0x20, 0x60]
    const streams = Array.from({ length: GFX_FILE_COUNT }, (_, i) =>
      encode(Uint8Array.from({ length: THREE_BPP_BYTES }, (_, k) => (i + k) & 0xff)),
    )
    const { rom } = buildCart({ streams, entryBytes })
    const r = planGfxSave(rom, GfxTable.load(rom))
    expect(r.status).toBe('unavailable')
    if (r.status !== 'unavailable') return
    expect(r.reason).toMatch(/LC_LZ2/i)
  })

  it('surfaces the overage when the repack does not fit', () => {
    const streams = Array.from({ length: GFX_FILE_COUNT }, (_, i) =>
      encode(new Uint8Array(THREE_BPP_BYTES).fill(i & 0xff)),
    )
    const { rom } = buildCart({ streams, filler: 0 })
    const table = GfxTable.load(rom)
    // A flat file is maximally compressible, so any edit at all grows it.
    table.setPixel({ kind: 'gfxPixel', file: 2, tile: 0, x: 0, y: 0, value: 7 })
    const r = planGfxSave(rom, table)
    expect(r.status).toBe('overflow')
    if (r.status !== 'overflow') return
    expect(r.overage).toBeGreaterThan(0)
    expect(r.reason).toMatch(/446/)
  })
})

describe('decompress(encode(x)) holds for every file the table decodes', () => {
  it('re-encodes each file back to its own bytes when nothing changed', () => {
    const { rom } = cartWith3bppFiles()
    const table = GfxTable.load(rom)
    const differing: number[] = []
    for (const f of table.files) {
      const re = encode(f.bytes, f.template)
      if (Buffer.compare(Buffer.from(re), Buffer.from(f.template)) !== 0) differing.push(f.index)
      if (Buffer.compare(Buffer.from(decompress(re)), Buffer.from(f.bytes)) !== 0) {
        differing.push(f.index)
      }
    }
    expect(differing).toEqual([])
  })
})
