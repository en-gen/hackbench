/**
 * The widened decompressor gate (#274) against real cartridges. Needs the
 * corpus; skipped without it, and the synthetic twin
 * (GfxBackRefOrder.synthetic.test.ts) holds the refusals.
 */
import { describe, it, expect } from 'vitest'
import { checkStockCompression } from '../../../src/rom/GfxArena'
import { RomFile } from '../../../src/rom/RomFile'
import { hasRom, INVICTUS, MAGIC, romPath, VANILLA } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('gate on the vanilla US ROM', () => {
  it('accepts it as the stock decompressor, back-references big-endian', () => {
    const r = checkStockCompression(RomFile.load(romPath(VANILLA)))
    expect(r.ok && [r.kind, r.order]).toEqual(['stock', 'be'])
  })
})

describe.skipIf(!hasRom(MAGIC))('gate on the Lunar Magic ROM', () => {
  it('accepts it as the stock decompressor, back-references big-endian', () => {
    const r = checkStockCompression(RomFile.load(romPath(MAGIC)))
    expect(r.ok && [r.kind, r.order]).toEqual(['stock', 'be'])
  })
})

describe.skipIf(!hasRom(INVICTUS))('gate on Invictus (fast LC_LZ2)', () => {
  it('accepts it as the fast routine, back-references big-endian as before', () => {
    const r = checkStockCompression(RomFile.load(romPath(INVICTUS)))
    expect(r.ok && [r.kind, r.order]).toEqual(['fast', 'be'])
  })
})
