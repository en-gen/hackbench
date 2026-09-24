import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  readLevelMusicTable,
  getAllLevelBgmTracks,
  LEVEL_MUSIC_COUNT,
} from '../../../src/rom/MusicData'
import { hasRom, romPath } from '../support/corpus'

/**
 * Pinned per-ROM rather than cross-checked against SpcBuilder.countBankSongs:
 * getAllLevelBgmTracks IS `Array.from({length: countBankSongs(...)}, ...)`
 * (src/rom/MusicData.ts), so comparing lengths against that same call is the
 * same tautology SpcBuilderBankSongs.test.ts had, just crossing a module
 * boundary. See that file for the disassembly citation (bank_0E.asm:3840-3868,
 * 29 entries).
 *
 * getAllLevelBgmTracks calls the UNGATED getLevelMusicBankAddr, not the
 * path-verified getLevelMusicBankAddrIfReadable (src/rom/SpcBuilder.ts) - it
 * is prior work this feature ports from, not code this diff owns. The three
 * AddmusicK carts still read 0 here, but only because readBankSongPointers'
 * own boundary check happens to reject the filler address it derives; that
 * is a narrower, coincidental protection than the opcode/path gate
 * MusicServiceImpl actually uses (see SpcBuilderPathGate.test.ts).
 */
const EXPECTED_TRACK_COUNT: Record<string, number> = {
  'Super Mario World (USA).vanilla.sfc': 29,
  'Super Mario World (USA).magic.sfc': 29,
  'Seven_Vanilla_Levels.sfc': 29,
  'Grand Poo World 2 1.1.sfc': 0,
  'GrandPooWorld_V1.2.sfc': 0,
  'Invictus 1.0.sfc': 0,
}

describe('MusicData track enumeration (requires the ROM corpus)', () => {
  for (const file of Object.keys(EXPECTED_TRACK_COUNT)) {
    const present = hasRom(file)
    const expectedCount = EXPECTED_TRACK_COUNT[file]

    // skipIf per file: with the corpus absent these must still be
    // REGISTERED and reported skipped, not silently cease to exist.
    describe.skipIf(!present)(file, () => {
      const openRom = () => SmwRom.open(romPath(file)).rom

      it('readLevelMusicTable always has exactly 8 entries, indices 0-7', () => {
        const table = readLevelMusicTable(openRom())
        expect(table).toHaveLength(LEVEL_MUSIC_COUNT)
        table.forEach((e, i) => expect(e.index).toBe(i))
      })

      it('reads the track count this fixture actually has', () => {
        expect(getAllLevelBgmTracks(openRom())).toHaveLength(expectedCount)
      })

      if (expectedCount > 0) {
        it('track bgmCommand values are 1-based and sequential', () => {
          getAllLevelBgmTracks(openRom()).forEach((t, i) => expect(t.bgmCommand).toBe(i + 1))
        })
      }
    })
  }
})
