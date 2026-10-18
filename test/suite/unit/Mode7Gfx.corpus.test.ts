/**
 * Mode7Gfx on the real corpus ROMs: the fingerprints must accept the stock
 * code (vanilla and the five hacks) and refuse a one-opcode change in the
 * routine, the helper or the call site. Skipped per ROM without the corpus;
 * the synthetic suite covers the same logic on hand-written code.
 */
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { CORPUS, VANILLA, freshRom, hasRom } from '../support/corpus'
import { WILD, findPattern } from '../../../src/rom/BytePattern'
import { decodeMode7Tiles, findMode7GfxFiles } from '../../../src/rom/Mode7Gfx'
import { readGfxFile } from '../../../src/rom/GfxLoader'
import { flip } from '../support/syntheticRom'
import { ALT_HELPER, callSiteBytes, helperBytes, unpackBytes } from '../support/syntheticMode7'
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
  expect(file!.reason, label).toMatch(/does not unpack|not found exactly once/)
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

    it('names nothing when one byte of the routine changes', () => {
      for (const i of [0, 18, 40, 80, 117]) {
        const rom = freshRom(name)
        flip(rom, ROUTINE + i)
        expect(findMode7GfxFiles(rom), `routine offset ${i}`).toEqual([])
      }
    })

    it('refuses the file, with a reason, when the helper no longer shifts three bits', () => {
      for (const i of [0, 2, 5, 14]) {
        const rom = freshRom(name)
        flip(rom, HELPER + i)
        expectRefused(rom, `helper offset ${i}`)
      }
    })

    it('refuses the file, with a reason, when one byte of the call site changes', () => {
      const rom = freshRom(name)
      // BEQ over JSR CODE_00AB42 (SMWDisX bank_00.asm:5392-5393), found by shape.
      const [site] = findPattern(rom, [0xf0, WILD, 0x20, 0x42, 0xab])
      expect(site).toBeDefined()
      for (const i of [0, 1, 2, 3, 4]) {
        const bad = freshRom(name)
        flip(bad, 0x8000 + site! + i)
        expectRefused(bad, `call site offset ${i}`)
      }
    })
  })
})

// The synthetic fixtures (support/syntheticMode7.ts) must not be the game's
// code: no 8-byte run of any of them, as assembled, may occur in the vanilla ROM.
describe.skipIf(!hasRom(VANILLA))(
  'the synthetic Mode 7 fixtures share no 8-byte run with the ROM',
  () => {
    const RUN = 8
    const sample = (): Buffer => freshRom(VANILLA).buffer
    const fixtures: [string, number[]][] = [
      ['routine', unpackBytes(0x27, 0x03ff, 0xabc4)],
      ['routine, other file and count', unpackBytes(0x1c, 0x00ff, 0x9100)],
      ['helper', helperBytes()],
      ['alt helper', ALT_HELPER],
      ['call site', callSiteBytes(0xab42)],
    ]
    const runsIn = (bytes: number[]): Buffer[] =>
      Array.from({ length: bytes.length - RUN + 1 }, (_, i) => Buffer.from(bytes.slice(i, i + RUN)))

    it.each(fixtures)('%s', (_, bytes) => {
      expect(runsIn(bytes).filter(r => sample().includes(r))).toEqual([])
    })

    it('goes red when a fixture is replaced by a run taken from the ROM', () => {
      const planted = Array.from(sample().subarray(0x2b42, 0x2b42 + 16))
      expect(runsIn(planted).some(r => sample().includes(r))).toBe(true)
    })
  },
)
