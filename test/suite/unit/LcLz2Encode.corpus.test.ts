/**
 * The encoder against real cartridges.
 *
 * the corpus is gitignored, so CI never runs this: the encoder's contract
 * is proven synthetically in LcLz2Encode.synthetic.test.ts, and this file
 * adds the one thing a synthetic stream cannot, which is Nintendo's own
 * command mix. Gated per cart with `describe.skipIf` so the cases SKIP
 * rather than vanish when the corpus is absent (CLAUDE.md: a `for` loop over
 * an empty directory listing registers nothing and reports zero skips).
 *
 * Reports no ROM bytes, only counts and lengths.
 *
 * Every corpus ROM passes the decompressor gate since #603, so refusal of a
 * replaced decompressor is proven synthetically (GfxDecompressor.synthetic).
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { decompress, encode, parseStream } from '../../../src/rom/LcLz2'
import { checkStockCompression, readGfxFileTable } from '../../../src/rom/GfxArena'
import { CORPUS, MAGIC, hasRom, romPath, romsOnDisk } from '../support/corpus'

const CARTS = romsOnDisk()

/** Every cart the corpus may hold, named so the cases register and SKIP
 *  whether or not the files are present. */
const EXPECTED_CARTS = CORPUS

/** The corpus's headered dumps: 524,800 bytes, so `size % 1024 === 512`.
 *  A copier-header frame error reads identically on every other cart. */
const HEADERED = new Set<string>([MAGIC])

for (const name of EXPECTED_CARTS) {
  const path = romPath(name)
  const present = hasRom(name)

  describe.skipIf(!present)(`${name}: structure-preserving re-encode`, () => {
    it('reproduces every GFX stream byte for byte', () => {
      const rom = RomFile.load(path)
      // Tripwire: the .magic dump is the corpus's only headered cart, and a
      // 512-byte frame error is invisible on the other five. If it ever
      // stops being headered this suite silently stops covering that case.
      expect(rom.hasHeader, `${name} header`).toBe(HEADERED.has(name))
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
