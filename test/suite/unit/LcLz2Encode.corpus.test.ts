/**
 * The encoder against real cartridges.
 *
 * `test/roms/` is gitignored, so CI never runs this: the encoder's contract
 * is proven synthetically in LcLz2Encode.synthetic.test.ts, and this file
 * adds the one thing a synthetic stream cannot, which is Nintendo's own
 * command mix. Gated per cart with `describe.skipIf` so the cases SKIP
 * rather than vanish when the corpus is absent (CLAUDE.md: a `for` loop over
 * an empty directory listing registers nothing and reports zero skips).
 *
 * Reports no ROM bytes, only counts and lengths.
 *
 * A cartridge that has replaced the decompressor is asserted to be REFUSED
 * rather than skipped. Its GFX are not LC_LZ2 at all, so re-encoding them
 * would be meaningless, and quietly passing over it is how a gate stops
 * being tested.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import { decompress, encode, parseStream } from '../../../src/rom/LcLz2'
import { checkStockCompression, readGfxFileTable } from '../../../src/rom/GfxArena'

const ROMS_DIR = resolve(__dirname, '../../roms')
const CARTS = existsSync(ROMS_DIR) ? readdirSync(ROMS_DIR).filter(f => /\.(sfc|smc)$/i.test(f)) : []

/** Every cart the corpus may hold, named so the cases register and SKIP
 *  whether or not the files are present. */
const EXPECTED_CARTS = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Seven_Vanilla_Levels.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Grand Poo World 2 1.1.sfc',
  'Invictus 1.0.sfc',
]

/** Invictus 1.0 replaces the LC_LZ2 entry at $00B8DE; every other cart in
 *  the corpus holds the stock prologue. Measured, 6 of 6, one machine. */
const NON_STOCK_COMPRESSION = new Set(['Invictus 1.0.sfc'])

for (const name of EXPECTED_CARTS) {
  const path = resolve(ROMS_DIR, name)
  const present = existsSync(path)
  const stock = !NON_STOCK_COMPRESSION.has(name)

  describe.skipIf(!present || !stock)(`${name}: structure-preserving re-encode`, () => {
    it('reproduces every GFX stream byte for byte', () => {
      const rom = RomFile.load(path)
      expect(checkStockCompression(rom).ok).toBe(true)
      const readable = readableFiles(rom)

      const differing: number[] = []
      for (const f of readable) {
        const src = rom.readAtFileOffset(f.offset!, f.byteLength)!
        const re = encode(decompress(src), src)
        if (Buffer.compare(Buffer.from(re), src) !== 0) differing.push(f.index)
      }
      expect(differing).toEqual([])
    })

    it('round trips every GFX stream with no template at all', () => {
      const rom = RomFile.load(path)
      const broken: number[] = []
      for (const f of readableFiles(rom)) {
        const out = decompress(rom.readAtFileOffset(f.offset!, f.byteLength)!)
        if (Buffer.compare(Buffer.from(decompress(encode(out))), Buffer.from(out)) !== 0) {
          broken.push(f.index)
        }
      }
      expect(broken).toEqual([])
    })

    it('parseStream agrees with decompress on every GFX stream', () => {
      const rom = RomFile.load(path)
      for (const f of readableFiles(rom)) {
        const src = rom.readAtFileOffset(f.offset!, f.byteLength)!
        expect(parseStream(src).outputLength, `file ${f.index}`).toBe(decompress(src).length)
      }
    })
  })

  describe.skipIf(!present || stock)(`${name}: non-stock compression`, () => {
    it('is refused rather than re-encoded', () => {
      const r = checkStockCompression(RomFile.load(path))
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toMatch(/LC_LZ2/i)
    })
  })
}

/** Files whose pointers resolve to a terminated stream. Tripwires on empty:
 *  a cart we could not read at all would otherwise pass by checking nothing. */
function readableFiles(rom: RomFile): ReturnType<typeof readGfxFileTable> {
  const readable = readGfxFileTable(rom).filter(f => f.offset !== null && f.terminated)
  expect(readable.length).toBeGreaterThan(0)
  return readable
}

describe('the corpus listing is a cross-check, never the source of cases', () => {
  it('names every cart present on this machine', () => {
    const unlisted = CARTS.filter(f => !EXPECTED_CARTS.includes(f))
    expect(unlisted, `add these to EXPECTED_CARTS: ${unlisted.join(', ')}`).toEqual([])
  })
})
