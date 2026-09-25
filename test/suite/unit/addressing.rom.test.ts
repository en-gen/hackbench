/**
 * ROM-gated acceptance tests for the expanded-ROM loromToOffset fix.
 *
 * These are the two independent measurements from the bug report: a known
 * compressed table must decompress to its documented size, and the level
 * catalog's parseable count must not regress. Both exercise real pointers
 * from real ROM files (outside the repo, see support/corpus.ts) rather than hand-picked
 * addresses, so a broken bank branch has nowhere to hide.
 *
 * Skipped entirely (describe.skipIf) when a given ROM file is absent, per
 * docs/testing.md - CI never sees ROM-derived bytes.
 */
import { describe, it, expect } from 'vitest'
import { SmwRom, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { decompress } from '../../../src/rom/LcLz2'
import { loromToOffset, COPIER_HEADER_SIZE } from '../../../src/rom/addressing'
import { brokenOldHiromShaped } from './fixtures/brokenLoromConverter'
import { hasRom, romPath } from '../support/corpus'

// LM writes a JSL ($22) over the vanilla level-load dispatch at $05D8B1 when
// a ROM has been touched by Lunar Magic; vanilla/.magic keep $F0 (BEQ).
const LM_PATCH_PROBE = 0x05d8b1
// LM's compressed-translevel-table pointer: 16-bit LE lo/hi + separate bank byte.
const TABLE_PTR_WORD = 0x04d803
const TABLE_PTR_BANK = 0x04d808
const EXPECTED_TABLE_SIZE = 4096

// Invictus 1.0.sfc replaces the LC_LZ2 decompressor (#526), so whatever
// sits at this hook is not a real LC_LZ2 stream; it now correctly refuses.
const NOT_A_REAL_TABLE = new Set(['Invictus 1.0.sfc'])

describe('Acceptance A: LM compressed translevel table decompresses to 4096 bytes', () => {
  const hackRoms = [
    'Seven_Vanilla_Levels.sfc',
    'GrandPooWorld_V1.2.sfc',
    'Grand Poo World 2 1.1.sfc',
    'Invictus 1.0.sfc',
  ]
  for (const name of hackRoms) {
    // `it.skipIf`, not a ternary choosing between the two spellings of `it`.
    // Both register the case here, but the ternary is one edit away from the
    // shape that drops cases entirely, and it states the gate twice.
    it.skipIf(!hasRom(name))(`${name} table decompresses as expected`, () => {
      const smw = SmwRom.open(romPath(name))
      const rom = smw.rom
      expect(rom.readByte(LM_PATCH_PROBE)).toBe(0x22) // sanity: is actually LM-patched
      const word = rom.readWord(TABLE_PTR_WORD)
      const bank = rom.readByte(TABLE_PTR_BANK)
      expect(word).not.toBeNull()
      expect(bank).not.toBeNull()
      const ptr = ((bank as number) << 16) | (word as number)
      const offset = loromToOffset(ptr, rom.romSize, rom.hasHeader)
      expect(offset).not.toBeNull()
      if (NOT_A_REAL_TABLE.has(name)) {
        expect(() => decompress(rom.buffer, offset as number)).toThrow(/back-reference/i)
        return
      }
      const out = decompress(rom.buffer, offset as number)
      expect(out.length).toBe(EXPECTED_TABLE_SIZE)
    })
  }
})

/**
 * How many of `realIndices` would have been readable under the pre-fix
 * converter (`brokenOldHiromShaped`), mirroring RomFile.readAt's own
 * offset + length <= buffer.length bounds check and SmwRom.getLevelRawData's
 * length-fallback ladder. Gives Acceptance B a real, computed floor instead
 * of a hardcoded magic number or a `> 0` check that can't fail.
 */
function preFixParseableCount(smw: SmwRom, realIndices: number[]): number {
  const rom = smw.rom
  const headerBytes = rom.hasHeader ? COPIER_HEADER_SIZE : 0
  let count = 0
  for (const i of realIndices) {
    const ptr = smw.getLevelL1Pointer(i)
    if (ptr === null) continue
    const rawOffset = brokenOldHiromShaped(ptr)
    if (rawOffset === null) continue
    const offset = rawOffset + headerBytes
    const readable = [0x2000, 0x1000, 0x800, 0x400, 0x200].some(
      len => offset >= 0 && offset + len <= rom.buffer.length,
    )
    if (readable) count++
  }
  return count
}

describe('Acceptance B: level catalog parseable count', () => {
  const roms: Array<{ name: string; expectRise: boolean }> = [
    { name: 'Super Mario World (USA).vanilla.sfc', expectRise: false },
    { name: 'Super Mario World (USA).magic.sfc', expectRise: false },
    { name: 'Seven_Vanilla_Levels.sfc', expectRise: false },
    { name: 'GrandPooWorld_V1.2.sfc', expectRise: false },
    { name: 'Grand Poo World 2 1.1.sfc', expectRise: true },
    { name: 'Invictus 1.0.sfc', expectRise: true },
  ]

  for (const { name, expectRise } of roms) {
    it.skipIf(!hasRom(name))(
      `${name}: parseable count ${expectRise ? 'rises' : 'is unchanged'} vs the pre-fix count`,
      () => {
        const smw = SmwRom.open(romPath(name))

        // "Real slots" = every L1 pointer except the modal (filler) value that
        // fills unused slots - counting occurrences is how the bug report
        // derived 235/251/291/354 without hardcoding per-ROM numbers here.
        const pointers = Array.from({ length: LEVEL_COUNT }, (_, i) => smw.getLevelL1Pointer(i))
        const counts = new Map<number, number>()
        for (const p of pointers) if (p !== null) counts.set(p, (counts.get(p) ?? 0) + 1)
        let filler = -1,
          fillerCount = 0
        for (const [p, c] of counts)
          if (c > fillerCount) {
            filler = p
            fillerCount = c
          }
        const realIndices = pointers
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => p !== null && p !== filler)
          .map(({ i }) => i)

        const parseable = realIndices.filter(i => smw.getLevelRawData(i) !== null).length
        const preFixParseable = preFixParseableCount(smw, realIndices)

        // Not tuned to hit 100%: report what we get and let a human diagnose
        // any residual gap between parseable and realIndices.length.
        console.log(
          `  [${name}] real slots=${realIndices.length} parseable=${parseable} preFixParseable=${preFixParseable}`,
        )
        if (expectRise) {
          // The actual pre-fix floor, computed from the committed
          // brokenOldHiromShaped mutant rather than a hardcoded number - a
          // buggy converter that regressed to pre-fix behavior fails this.
          expect(parseable).toBeGreaterThan(preFixParseable)
        } else {
          expect(parseable).toBe(realIndices.length)
          // These ROMs don't touch the banks the bug affected, so the pre-fix
          // and post-fix converters must agree exactly here too.
          expect(preFixParseable).toBe(parseable)
        }
      },
    )
  }
})
