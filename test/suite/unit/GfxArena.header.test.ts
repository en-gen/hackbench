/**
 * The copier header, and the offset frame the arena works in.
 *
 * **Synthetic cartridges only**, built here and never read from a cart, so
 * this runs on CI where the corpus is absent by design. That matters more
 * than usual: the defect class is a 512-byte silent write to the wrong
 * place, and a corpus-only test would not guard it where it actually runs.
 *
 * THE CONVENTION, stated once because getting it backwards is the bug:
 *
 *   `ArenaWrite.offset` is CART-RELATIVE, the copier header excluded. It is
 *   the same frame `RomFile.readAtFileOffset` takes, the same frame
 *   `findPattern` returns, and the same frame `loromFromOffset` inverts.
 *   `loromToOffset(addr, romSize)` with its third argument left off returns
 *   exactly that, which is why the arena calls it with two arguments.
 *
 * Passing `hasHeader` there instead would add 512 to a number that is then
 * handed to `readAtFileOffset`, which adds 512 again. Every read would land
 * a header late and every pointer-table write address would be a header
 * high. The last describe in this file plants precisely that and proves the
 * assertions above it go red, so the convention is checked rather than
 * merely written down.
 *
 * The invariant is NOT "the headered cart's offsets are 512 higher". It is
 * that the same game at the same SNES addresses produces the SAME
 * cart-relative offsets whichever way it was dumped, and that the 512 shows
 * up only in the raw file.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { COPIER_HEADER_SIZE, loromToOffset } from '../../../src/rom/addressing'
import {
  GFX_FILE_COUNT,
  checkStockCompression,
  planRegions,
  readGfxFileTable,
  readGfxPointerSites,
} from '../../../src/rom/GfxArena'
import { GfxTable, planGfxSave, readTilesPerFile } from '../../../src/rom/GfxTable'
import { applyWrites, buildCart, gfxStreams } from '../support/syntheticGfxCart'

const TILES = 11
const SHEET_BYTES = TILES * 24 // 3bpp, and not a multiple of 16 or 32

function twins(): { bare: RomFile; headered: RomFile } {
  const streams = Array.from({ length: GFX_FILE_COUNT }, (_, i) =>
    Uint8Array.from(gfxStreams(SHEET_BYTES)[i]!),
  )
  return {
    bare: buildCart({ streams, filler: 4096 }).rom,
    headered: buildCart({ streams, filler: 4096, headered: true }).rom,
  }
}

describe('a headered cartridge and its headerless twin', () => {
  it('are detected as the pair this file claims they are', () => {
    // Tripwire: if CART_SIZE ever stops being a whole number of KB, the
    // "headered" fixture stops being headered and every case below would
    // pass by testing the same cart twice.
    const { bare, headered } = twins()
    expect(bare.hasHeader).toBe(false)
    expect(headered.hasHeader).toBe(true)
    expect(headered.buffer.length).toBe(bare.buffer.length + COPIER_HEADER_SIZE)
    expect(headered.romSize).toBe(bare.romSize)
  })

  it('resolve the same routine, tables and decompressor entry', () => {
    const { bare, headered } = twins()
    expect(readGfxPointerSites(headered)).toEqual(readGfxPointerSites(bare))
    expect(readTilesPerFile(headered)).toBe(readTilesPerFile(bare))
    expect(checkStockCompression(headered)).toEqual(checkStockCompression(bare))
  })

  it('report the same file table, byte for byte', () => {
    const { bare, headered } = twins()
    expect(readGfxFileTable(headered)).toEqual(readGfxFileTable(bare))
    // Not vacuously: every file has to have actually parsed.
    for (const f of readGfxFileTable(headered)) {
      expect(f.terminated, `file ${f.index}`).toBe(true)
      expect(f.outputLength, `file ${f.index}`).toBe(SHEET_BYTES)
    }
  })

  it('report the same regions and the same slack', () => {
    const { bare, headered } = twins()
    expect(planRegions(headered, readGfxFileTable(headered))).toEqual(
      planRegions(bare, readGfxFileTable(bare)),
    )
  })

  it('decode to the same tiles', () => {
    const { bare, headered } = twins()
    const a = GfxTable.load(bare)
    const b = GfxTable.load(headered)
    for (let i = 0; i < GFX_FILE_COUNT; i++) {
      expect(Buffer.from(b.files[i]!.bytes), `file ${i}`).toEqual(Buffer.from(a.files[i]!.bytes))
      expect(Buffer.from(b.files[i]!.template), `file ${i} stream`).toEqual(
        Buffer.from(a.files[i]!.template),
      )
    }
  })

  it('plan the same writes at the same cart-relative offsets', () => {
    const { bare, headered } = twins()
    const a = planGfxSave(bare, GfxTable.load(bare))
    const b = planGfxSave(headered, GfxTable.load(headered))
    expect(a.status).toBe('ok')
    expect(b.status).toBe('ok')
    if (a.status !== 'ok' || b.status !== 'ok') return

    expect(b.plan.writes.map(w => w.offset)).toEqual(a.plan.writes.map(w => w.offset))
    for (let i = 0; i < a.plan.writes.length; i++) {
      expect(Buffer.from(b.plan.writes[i]!.bytes)).toEqual(Buffer.from(a.plan.writes[i]!.bytes))
    }
  })

  it('put the pointer tables at the SNES address the routine names, not 512 off it', () => {
    // The corruption case: these three writes are addresses to WRITE to. On
    // a headered cart a wrong frame here overwrites whatever lives 512 bytes
    // away, silently, and no refusal fires.
    const { headered } = twins()
    const sites = readGfxPointerSites(headered)!
    const r = planGfxSave(headered, GfxTable.load(headered))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return

    const tableWrites = r.plan.writes.filter(w => w.bytes.length === GFX_FILE_COUNT)
    expect(tableWrites.length).toBe(3)
    expect(tableWrites.map(w => w.offset).sort((x, y) => x - y)).toEqual(
      [sites.lo, sites.hi, sites.bank]
        .map(a => loromToOffset(a, headered.romSize)!)
        .sort((x, y) => x - y),
    )

    // And what is written matches what the cart already holds there, since
    // nothing moved: a frame error would make this a diff.
    for (const w of tableWrites) {
      expect(Buffer.from(w.bytes)).toEqual(headered.readAtFileOffset(w.offset, w.bytes.length)!)
    }
  })

  it('round trip an edit, with the bytes landing a header later in the FILE', () => {
    const { bare, headered } = twins()
    const edit = { kind: 'gfxPixel' as const, file: 4, tile: 9, x: 2, y: 6, value: 5 }

    const table = GfxTable.load(headered)
    expect(table.setPixel(edit).status).toBe('ok')
    const r = planGfxSave(headered, table)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return

    const after = applyWrites(headered, r.plan.writes)
    expect(after.hasHeader).toBe(true)
    expect(GfxTable.load(after).tile(4, 9)![6 * 8 + 2]).toBe(5)

    // The header itself is untouched, which is what an off-by-512 write
    // into the front of the cart would destroy.
    expect(Buffer.from(after.buffer.subarray(0, COPIER_HEADER_SIZE))).toEqual(
      Buffer.from(headered.buffer.subarray(0, COPIER_HEADER_SIZE)),
    )

    // Same cart-relative offset on both twins; the 512 appears only in the
    // raw file position.
    const at = r.plan.writes[0]!.offset
    expect(planGfxSave(bare, GfxTable.load(bare)).status).toBe('ok')
    expect(after.readAtFileOffset(at, 4)).toEqual(
      Buffer.from(r.plan.writes[0]!.bytes.subarray(0, 4)),
    )
    expect(
      Buffer.from(after.buffer.subarray(at + COPIER_HEADER_SIZE, at + COPIER_HEADER_SIZE + 4)),
    ).toEqual(Buffer.from(r.plan.writes[0]!.bytes.subarray(0, 4)))
  })
})

describe('planting the header argument turns those assertions red', () => {
  /**
   * `readGfxFileTable` as it would be if `loromToOffset` were given
   * `hasHeader`, which is the change that looks correct and is not: the
   * result is then handed to `readAtFileOffset`, which adds the header a
   * second time.
   */
  function tableWithHeaderAddedTwice(rom: RomFile): { terminated: boolean; index: number }[] {
    const sites = readGfxPointerSites(rom)!
    const out: { terminated: boolean; index: number }[] = []
    for (let index = 0; index < GFX_FILE_COUNT; index++) {
      const lo = rom.readByte(sites.lo + index)!
      const hi = rom.readByte(sites.hi + index)!
      const bank = rom.readByte(sites.bank + index)!
      const offset = loromToOffset((bank << 16) | (hi << 8) | lo, rom.romSize, rom.hasHeader)
      const tail = offset === null ? null : rom.readAtFileOffset(offset, 64)
      out.push({ index, terminated: tail !== null && tail.includes(0xff) })
    }
    return out
  }

  it('reads different bytes on a headered cart, which is the whole defect', () => {
    const { headered } = twins()
    const correct = readGfxFileTable(headered)
    const planted = tableWithHeaderAddedTwice(headered)

    // A file that parses cleanly the right way must not parse the same way
    // when every read is a header late.
    const stillAgreeing: number[] = []
    for (let i = 0; i < GFX_FILE_COUNT; i++) {
      const right = headered.readAtFileOffset(correct[i]!.offset!, 64)!
      const wrong = headered.readAtFileOffset(
        loromToOffset(correct[i]!.snesAddr, headered.romSize, true)!,
        64,
      )!
      if (Buffer.compare(right, wrong) === 0) stillAgreeing.push(i)
    }
    expect(stillAgreeing, 'the planted frame read the same bytes, so it proves nothing').toEqual([])
    expect(planted.length).toBe(GFX_FILE_COUNT)
  })

  it('leaves the headerless twin alone, so the defect is specific to the header', () => {
    const { bare } = twins()
    for (const f of readGfxFileTable(bare)) {
      expect(loromToOffset(f.snesAddr, bare.romSize, bare.hasHeader)).toBe(f.offset)
    }
  })
})
