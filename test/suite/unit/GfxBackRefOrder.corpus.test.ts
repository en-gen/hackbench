/**
 * The widened decompressor gate (#274) against real cartridges. Needs the
 * corpus; skipped without it, and the synthetic twin
 * (GfxBackRefOrder.synthetic.test.ts) holds the refusals.
 */
import { describe, it, expect } from 'vitest'
import { checkStockCompression } from '../../../src/rom/GfxArena'
import { RomFile } from '../../../src/rom/RomFile'
import { hasRom, INVICTUS, MAGIC, romPath, VANILLA } from '../support/corpus'

const CASES = [
  [
    'the vanilla US ROM',
    VANILLA,
    'stock',
    'accepts it as the stock decompressor, back-references big-endian',
  ],
  [
    'the Lunar Magic ROM',
    MAGIC,
    'stock',
    'accepts it as the stock decompressor, back-references big-endian',
  ],
  [
    'Invictus (fast LC_LZ2)',
    INVICTUS,
    'fast',
    'accepts it as the fast routine, back-references big-endian as before',
  ],
] as const

for (const [name, rom, kind, title] of CASES) {
  describe.skipIf(!hasRom(rom))(`gate on ${name}`, () => {
    it(title, () => {
      const r = checkStockCompression(RomFile.load(romPath(rom)))
      expect(r.ok && [r.kind, r.order]).toEqual([kind, 'be'])
    })
  })
}
