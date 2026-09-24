/**
 * The three music banks as the six real cartridges hold them.
 *
 * Pins the two facts the panel is built on. Every bank resolves on the
 * three stock carts and NONE resolve on the three AddmusicK ones, which is
 * why the panel needs a tier that works without a bank at all
 * (readLevelMusicUsage, MusicData.usage.rom.test.ts). And the stock level
 * bank really does have two pairs of commands sharing one song, so the
 * `sharedWith` grouping is answering a real question rather than a
 * hypothetical one.
 *
 * Skips per file when the corpus is absent, which is always the case in CI.
 */
import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { readMusicCatalog, MusicBankName, MUSIC_BANKS } from '../../../src/rom/MusicCatalog'
import { hasRom, romPath } from '../support/corpus'

interface BankShape {
  romAddr: number
  blockSize: number
  trackCount: number
  /** Distinct song pointers; lower than trackCount where commands share one. */
  distinctSongs: number
}

/** Measured 2026-09-21 on this repo's six-cartridge corpus, one machine. */
const STOCK: Record<MusicBankName, BankShape> = {
  level: { romAddr: 0x0eaed6, blockSize: 16893, trackCount: 29, distinctSongs: 27 },
  overworld: { romAddr: 0x0e98b1, blockSize: 5661, trackCount: 9, distinctSongs: 9 },
  // Twelve command slots resolving to four songs, each repeated three times.
  credits: { romAddr: 0x03e400, blockSize: 6598, trackCount: 12, distinctSongs: 4 },
}

const STOCK_CARTS = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Seven_Vanilla_Levels.sfc',
]

const ADDMUSICK_CARTS = ['Grand Poo World 2 1.1.sfc', 'GrandPooWorld_V1.2.sfc', 'Invictus 1.0.sfc']

describe('readMusicCatalog (requires the ROM corpus)', () => {
  for (const file of STOCK_CARTS) {
    const path = romPath(file)
    // skipIf per file: with the corpus absent these must still be
    // REGISTERED and reported skipped, not silently cease to exist.
    describe.skipIf(!hasRom(file))(file, () => {
      for (const bank of MUSIC_BANKS) {
        const shape = STOCK[bank]

        it(`resolves the ${bank} bank to $${shape.romAddr.toString(16).toUpperCase()}`, () => {
          const result = readMusicCatalog(SmwRom.open(path), bank)

          expect(result.status).toBe('ok')
          if (result.status !== 'ok') return
          expect(result.bank.romAddr).toBe(shape.romAddr)
          expect(result.bank.blockSize).toBe(shape.blockSize)
          expect(result.bank.tracks).toHaveLength(shape.trackCount)
        })

        it(`counts ${shape.distinctSongs} distinct songs in the ${bank} bank`, () => {
          const result = readMusicCatalog(SmwRom.open(path), bank)

          expect(result.status).toBe('ok')
          if (result.status !== 'ok') return
          const distinct = new Set(result.bank.tracks.map(t => t.aramPointer))
          expect(distinct.size).toBe(shape.distinctSongs)
        })
      }

      it("finds the level bank's two shared-song pairs, $04 with $16 and $0F with $10", () => {
        const result = readMusicCatalog(SmwRom.open(path), 'level')

        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        const shared = Object.fromEntries(
          result.bank.tracks
            .filter(t => t.sharedWith.length > 0)
            .map(t => [t.bgmCommand, t.sharedWith]),
        )
        expect(shared).toEqual({ 0x04: [0x16], 0x16: [0x04], 0x0f: [0x10], 0x10: [0x0f] })
      })

      it('attributes the level bank and leaves the other two alone', () => {
        const smw = SmwRom.open(path)
        const level = readMusicCatalog(smw, 'level')
        const overworld = readMusicCatalog(smw, 'overworld')

        expect(level.status).toBe('ok')
        expect(overworld.status).toBe('ok')
        if (level.status !== 'ok' || overworld.status !== 'ok') return

        expect(level.bank.attributionUnavailable).toBeUndefined()
        expect(level.bank.tracks.some(t => t.maps.length > 0)).toBe(true)
        expect(overworld.bank.attributionUnavailable).toBeUndefined()
        // Level headers do not select overworld music, so no track there
        // carries maps - and that is not reported as a gap.
        expect(overworld.bank.tracks.every(t => t.maps.length === 0)).toBe(true)
      })
    })
  }

  for (const file of ADDMUSICK_CARTS) {
    const path = romPath(file)
    describe.skipIf(!hasRom(file))(file, () => {
      for (const bank of MUSIC_BANKS) {
        it(`refuses the ${bank} bank rather than naming the stock address`, () => {
          const result = readMusicCatalog(SmwRom.open(path), bank)

          expect(result.status).toBe('unavailable')
          if (result.status !== 'unavailable') return
          expect(result.bank).toBe(bank)
          expect(result.reason).toMatch(/could not be verified/i)
        })
      }
    })
  }
})
