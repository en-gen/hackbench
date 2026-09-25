/**
 * Every readable GFX file across the corpus, hashed and compared against
 * hashes captured from the pre-#494 decoder before the fix landed. Proves
 * the fix changes output only for the streams it targets, not for real ROM
 * data. Evidence scope: one machine, this corpus, captured 2026-09-25.
 *
 * Invictus is excluded: its GFX are not LC_LZ2 at all (#526), and its
 * pointer-readable files no longer all decompress to pinned garbage; the
 * #526 gate is what actually protects shipping callers.
 */
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { decompress, tryDecompress } from '../../../src/rom/LcLz2'
import { readGfxFileTable, checkStockCompression } from '../../../src/rom/GfxArena'
import { INVICTUS, hasRom, romPath } from '../support/corpus'

const FILES = 50
const VANILLA_HASH = '15462611a20fb7e3863edf99ea51b5a7942d561bbd800f4a375a533c1826847e'
const STOCK: Record<string, string> = {
  'Super Mario World (USA).vanilla.sfc': VANILLA_HASH,
  'Super Mario World (USA).magic.sfc': VANILLA_HASH,
  'Grand Poo World 2 1.1.sfc': 'ba03e803b04cfede1b002fdec58bb669f0fea27a4d0a8b978047f71614612266',
  'GrandPooWorld_V1.2.sfc': 'be60b61da2cf6660526d2483ead6e1a930c3bf074bc7cf4ffe55da688d30951d',
  'Seven_Vanilla_Levels.sfc': VANILLA_HASH,
}

function readableFiles(rom: RomFile): ReturnType<typeof readGfxFileTable> {
  return readGfxFileTable(rom).filter(f => f.offset !== null && f.terminated)
}

for (const [name, hash] of Object.entries(STOCK)) {
  describe.skipIf(!hasRom(name))(`${name}: GFX decode is unchanged`, () => {
    it('every readable file decompresses to the pre-#494 bytes', () => {
      const rom = RomFile.load(romPath(name))
      const readable = readableFiles(rom)
      expect(readable.length).toBe(FILES)
      const digest = createHash('sha256')
      for (const f of readable) {
        digest.update(Buffer.from(decompress(rom.readAtFileOffset(f.offset!, f.byteLength)!)))
      }
      expect(digest.digest('hex')).toBe(hash)
    })
  })
}

describe.skipIf(!hasRom(INVICTUS))('Invictus: not LC_LZ2, excluded above', () => {
  it('the #526 gate refuses it before any shipping caller reaches decompress', () => {
    expect(checkStockCompression(RomFile.load(romPath(INVICTUS))).ok).toBe(false)
  })

  it('some, not all, of its pointer-readable files also fail this decoder directly', () => {
    // The #526 gate is what actually protects shipping callers; this is
    // corroborating evidence, not a claim that decompress alone catches
    // every file in a hack that replaced it.
    const rom = RomFile.load(romPath(INVICTUS))
    const readable = readableFiles(rom)
    expect(readable.length).toBeGreaterThan(0)
    const refused = readable.filter(
      f => !tryDecompress(rom.readAtFileOffset(f.offset!, f.byteLength)!).ok,
    )
    expect(refused.length).toBeGreaterThan(0)
  })
})
