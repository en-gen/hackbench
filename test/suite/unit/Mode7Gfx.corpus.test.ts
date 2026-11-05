/**
 * Mode7Gfx on the real corpus ROMs: the fingerprints must accept the stock
 * code (vanilla and the five hacks) and refuse a one-opcode change in the
 * routine, the helper or the call site. Skipped per ROM without the corpus;
 * the synthetic suite covers the same logic on hand-written code.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { CORPUS, ROM_DIR, VANILLA, freshRom, hasRom } from '../support/corpus'
import { findPattern } from '../../../src/rom/BytePattern'
import { decodeMode7Tiles, findMode7GfxFiles } from '../../../src/rom/Mode7Gfx'
import { readGfxFile } from '../../../src/rom/GfxLoader'
import { flip } from '../support/syntheticRom'
import { ALT_HELPER, callSiteBytes, helperBytes, unpackBytes } from '../support/syntheticMode7'
import { RomFile } from '../../../src/rom/RomFile'

const BEQ = 0xf0
const JSR = 0x20
const JSR_LENGTH = 3 // opcode and a 2-byte operand: what a BEQ over it skips
const BANK = 0x8000
const ROUTINE = 0x00ab42 // CODE_00AB42, SMWDisX bank_00.asm:5515
const HELPER = 0x00abc4 // CODE_00ABC4, :5575

// What the literal-pattern build on develop returned for every corpus ROM
// (measured on a scratch copy, 6 of 6 ROMs, one machine): file $27, 0xC00
// bytes, and this SHA-256 of the decoded pixels.
const DEVELOP_PIXELS = '5f19015e48aed0674ad573bfd606a4c525315a8417cdad42ee1a55dc303e72ec'

/** The file is claimed but unavailable, with a reason: refused, never read as planar. */
function expectRefused(rom: RomFile, label: string): void {
  const [file] = findMode7GfxFiles(rom)
  expect(file, label).toMatchObject({ fileIndex: 0x27, byteLength: null })
  expect(file!.reason, label).toMatch(/does not unpack|not found exactly once|changed|executed at/)
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

    it('names nothing when the routine no longer opens LDY / JSL', () => {
      const rom = freshRom(name)
      flip(rom, ROUTINE)
      expect(findMode7GfxFiles(rom)).toEqual([])
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
      // BEQ over JSR CODE_00AB42 (SMWDisX bank_00.asm:5392-5393): found as src does, one
      // opcode at a time, with the JSR target derived from its operand.
      const site = findPattern(rom, [BEQ]).find(at => {
        const b = rom.readAtFileOffset(at + 1, 1 + JSR_LENGTH)!
        const to = at - (at % BANK) + ((b[2]! | (b[3]! << 8)) - BANK)
        return b[0] === JSR_LENGTH && b[1] === JSR && to === ROUTINE - BANK
      })
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
      ['routine', unpackBytes(0x27, 0x03ff, 0xb1c4)],
      ['routine, other file and count', unpackBytes(0x1c, 0x00ff, 0x9100)],
      ['helper', helperBytes()],
      ['alt helper', ALT_HELPER],
      ['call site', callSiteBytes(0xb142)],
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

// Hack acceptance equals develop's. Measured 2026-10-18, one machine, over the
// 152 ROMs in hackbench-tools (hacks/roms plus roms): develop's literal-pattern
// build and this one gave the same answer for file $27 on every ROM, 110 read as
// Mode 7 (the file's decoded length equals the loop's) and 42 unavailable. Pinned as counts
// because develop's code is gone; a looser recognizer moves them.
// No corpus helper lists the hack collection, so it is located beside the corpus and gated here.
const ROMS = ROM_DIR
const HACKS = resolve(dirname(ROM_DIR), 'hacks/roms')
describe.skipIf(!existsSync(HACKS) || !existsSync(ROMS))('Mode7Gfx on the hack collection', () => {
  it('reads 110 ROMs as Mode 7 and claims 42 unavailable, as develop did', () => {
    const tally: Record<string, number> = {}
    for (const dir of [HACKS, ROMS]) {
      for (const f of readdirSync(dir).filter(f => /\.(sfc|smc)$/i.test(f))) {
        const rom = RomFile.load(resolve(dir, f))
        const read = readGfxFile(rom, 0x27)
        const len = read.ok ? read.bytes.length : 0
        const file = findMode7GfxFiles(rom).find(x => x.fileIndex === 0x27)
        // inferDefaultBpp's rule: a claimed file reads as Mode 7 only at the loop's length.
        const k = !file ? 'planar' : file.byteLength === len ? 'mode7' : 'unavailable'
        tally[k] = (tally[k] ?? 0) + 1
      }
    }
    expect(tally).toEqual({ mode7: 110, unavailable: 42 })
  }, 120_000)
})

// The plant for the tally above: an edited routine is unavailable, never planar.
describe.skipIf(!hasRom(CORPUS[0]!))('Mode7Gfx plant for the hack tally', () => {
  it('goes red when a routine byte is flipped on a Mode 7 ROM: unavailable, never planar', () => {
    const rom = freshRom(CORPUS[0])
    flip(rom, ROUTINE + 40)
    expect(findMode7GfxFiles(rom).find(x => x.fileIndex === 0x27)?.byteLength).toBeNull()
  })
})
