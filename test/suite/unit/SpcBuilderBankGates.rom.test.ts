/**
 * What the overworld and credits path gates say about the six real carts.
 *
 * The synthetic suite proves the refusals can fire; this pins which
 * cartridges they fire on, so a change that quietly starts reporting a
 * stock bank for a hack is visible. Skips per file when test/roms/ is
 * absent, which is always the case in CI.
 *
 * The credits row is the one that matters. On all three AddmusicK carts the
 * credits upload routine at $008159 is byte-identical to a stock cart's and
 * still holds the stock operands - `getCreditsMusicBankAddr` returns
 * $03E400 for every one of them. Nothing reaches it: $0094A0 holds $80
 * (BRA) rather than JSR. The gated reader is expected to return null, and
 * the ungated one is asserted alongside it to keep the contrast visible.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import {
  getOverworldMusicBankAddrIfReadable,
  getCreditsMusicBankAddrIfReadable,
  getCreditsMusicBankAddr,
} from '../../../src/rom/SpcBuilder'

const ROMS_DIR = resolve(__dirname, '../../roms')

/** Measured 2026-09-21 on this repo's six-cartridge corpus, one machine. */
const EXPECTED: Record<string, { overworld: number | null; credits: number | null }> = {
  'Super Mario World (USA).vanilla.sfc': { overworld: 0x0e98b1, credits: 0x03e400 },
  'Super Mario World (USA).magic.sfc': { overworld: 0x0e98b1, credits: 0x03e400 },
  'Seven_Vanilla_Levels.sfc': { overworld: 0x0e98b1, credits: 0x03e400 },
  'Grand Poo World 2 1.1.sfc': { overworld: null, credits: null },
  'GrandPooWorld_V1.2.sfc': { overworld: null, credits: null },
  'Invictus 1.0.sfc': { overworld: null, credits: null },
}

describe('music bank path gates (requires test/roms/*.sfc)', () => {
  for (const [file, expected] of Object.entries(EXPECTED)) {
    const path = resolve(ROMS_DIR, file)
    // skipIf per file: with the corpus absent these must still be
    // REGISTERED and reported skipped, not silently cease to exist.
    describe.skipIf(!existsSync(path))(file, () => {
      it(`reads the overworld bank as ${expected.overworld === null ? 'unavailable' : '$0E98B1'}`, () => {
        expect(getOverworldMusicBankAddrIfReadable(RomFile.load(path))).toBe(expected.overworld)
      })

      it(`reads the credits bank as ${expected.credits === null ? 'unavailable' : '$03E400'}`, () => {
        expect(getCreditsMusicBankAddrIfReadable(RomFile.load(path))).toBe(expected.credits)
      })

      if (expected.credits === null) {
        it('the ungated reader still returns the stock credits address, which is the bug', () => {
          // Pins the contrast the gate exists for. If this ever stops being
          // $03E400 the gate's justification has changed and the comment
          // above it needs rewriting.
          expect(getCreditsMusicBankAddr(RomFile.load(path))).toBe(0x03e400)
        })
      }
    })
  }
})
