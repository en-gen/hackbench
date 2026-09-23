/**
 * readLevelMusicTableIfReadable against the real cartridges.
 *
 * The synthetic suite beside this one proves each gate can fire; this one
 * pins what the gates actually say about six real carts, so a change that
 * quietly alters the verdict on a hack is visible. It skips per file when
 * test/roms/ is absent, which is always the case in CI.
 *
 * The measured result, and the reason this function exists: the decode site
 * matches exactly once on all six carts and always names $0584DB, so the
 * table does not relocate. Its CONTENTS do. Reading the stock address would
 * therefore have worked here by luck; reading the operand is what makes the
 * answer a reading rather than a coincidence, and the refusal path is what
 * stops a cart without the decode reporting eight commands anyway.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import { readLevelMusicTableIfReadable, LEVEL_MUSIC_COUNT } from '../../../src/rom/MusicData'

const ROMS_DIR = resolve(__dirname, '../../roms')

/** The stock table: BGM $02 $06 $01 $08 $07 $03 $05 $12 (bank_05.asm:513-521). */
const STOCK = [0x02, 0x06, 0x01, 0x08, 0x07, 0x03, 0x05, 0x12]

/**
 * What the three AddmusicK carts hold instead. Identical on all three, which
 * is what AddmusicK writes rather than anything the individual hacks chose.
 * Under stock naming these would be GAMEOVER, KEYHOLE, BOSSCLEAR, SPOTLIGHT,
 * KEYHOLE2, LEVELCLEAR, PSWITCH, BONUSGAME - visible nonsense, and the
 * reason the panel must not label a track from constants.asm.
 */
const ADDMUSICK = [0x0b, 0x0f, 0x0a, 0x11, 0x10, 0x0c, 0x0e, 0x12]

/** Measured 2026-09-21 on this repo's six-cartridge corpus, one machine. */
const EXPECTED: Record<string, number[]> = {
  'Super Mario World (USA).vanilla.sfc': STOCK,
  'Super Mario World (USA).magic.sfc': STOCK,
  'Seven_Vanilla_Levels.sfc': STOCK,
  'Grand Poo World 2 1.1.sfc': ADDMUSICK,
  'GrandPooWorld_V1.2.sfc': ADDMUSICK,
  'Invictus 1.0.sfc': ADDMUSICK,
}

/** The decode site and the table it names, identical on all six. */
const SITE = 0x058549
const TABLE = 0x0584db

describe('readLevelMusicTableIfReadable (requires test/roms/*.sfc)', () => {
  for (const [file, commands] of Object.entries(EXPECTED)) {
    const path = resolve(ROMS_DIR, file)
    // skipIf per file: with the corpus absent these must still be
    // REGISTERED and reported skipped, not silently cease to exist.
    describe.skipIf(!existsSync(path))(file, () => {
      it('finds exactly one decode site, at $058549', () => {
        const result = readLevelMusicTableIfReadable(RomFile.load(path))

        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        expect(result.table.foundAt).toBe(SITE)
      })

      it('names $0584DB through the LDA.L operand', () => {
        const result = readLevelMusicTableIfReadable(RomFile.load(path))

        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        expect(result.table.address).toBe(TABLE)
      })

      it('reads the eight commands this cartridge actually holds', () => {
        const result = readLevelMusicTableIfReadable(RomFile.load(path))

        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        expect(result.table.commands).toHaveLength(LEVEL_MUSIC_COUNT)
        expect(result.table.commands).toEqual(commands)
      })
    })
  }
})
