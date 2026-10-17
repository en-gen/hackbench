/**
 * Mode7Gfx on the real corpus ROMs: the fingerprints must accept the stock
 * code (vanilla and the five hacks) and refuse a one-opcode change in the
 * routine, the helper or the call site. Skipped per ROM without the corpus;
 * the synthetic suite covers the same logic on hand-written code.
 */
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { CORPUS, freshRom, hasRom } from '../support/corpus'
import { WILD, findPattern } from '../../../src/rom/BytePattern'
import { decodeMode7Tiles, findMode7GfxFiles } from '../../../src/rom/Mode7Gfx'
import { readGfxFile } from '../../../src/rom/GfxLoader'
import { flip } from '../support/syntheticRom'
import type { RomFile } from '../../../src/rom/RomFile'

const ROUTINE = 0x00ab42 // CODE_00AB42, SMWDisX bank_00.asm:5515
const HELPER = 0x00abc4 // CODE_00ABC4, :5575

// What the literal-pattern build on develop returned for every corpus ROM
// (measured on a scratch copy, 6 of 6 ROMs, one machine): file $27, 0xC00
// bytes, and this SHA-256 of the decoded pixels.
const DEVELOP_PIXELS = '5f19015e48aed0674ad573bfd606a4c525315a8417cdad42ee1a55dc303e72ec'

function expectRefused(rom: RomFile, label: string): void {
  const [file] = findMode7GfxFiles(rom)
  expect(file, label).toMatchObject({ fileIndex: 0x27, byteLength: null })
  expect(file!.reason, label).toMatch(/not a recognized build|not found exactly once/)
}

// CORPUS is the static name list, not a directory listing: every ROM registers
// its describe and is skipped when absent, so a missing ROM shows as skipped.
describe.each(CORPUS)('Mode7Gfx on %s', name => {
  describe.skipIf(!hasRom(name))('with the ROM present', () => {
    it('reads file $27 at 0xC00 bytes and decodes it as the literal-pattern build did', () => {
      const rom = freshRom(name)
      expect(findMode7GfxFiles(rom)).toEqual([{ fileIndex: 0x27, byteLength: 0xc00 }])
      const gfx = readGfxFile(rom, 0x27)
      expect(gfx.ok).toBe(true)
      if (!gfx.ok) return
      const decoded = Buffer.concat(decodeMode7Tiles(gfx.bytes))
      expect(createHash('sha256').update(decoded).digest('hex')).toBe(DEVELOP_PIXELS)
    })

    it('refuses the file, with a reason, when one byte of the routine changes', () => {
      for (const i of [18, 40, 80, 117]) {
        const rom = freshRom(name)
        flip(rom, ROUTINE + i)
        expectRefused(rom, `routine offset ${i}`)
      }
    })

    it('refuses the file, with a reason, when one byte of the helper changes', () => {
      const rom = freshRom(name)
      flip(rom, HELPER + 2)
      expectRefused(rom, 'helper')
    })

    it('refuses the file, with a reason, when one byte of the call site changes', () => {
      const rom = freshRom(name)
      // BEQ over JSR CODE_00AB42 (SMWDisX bank_00.asm:5392-5393), found by shape.
      const [site] = findPattern(rom, [0xf0, WILD, 0x20, 0x42, 0xab])
      expect(site).toBeDefined()
      flip(rom, 0x8000 + site! + 1)
      expectRefused(rom, 'call site')
    })
  })
})
