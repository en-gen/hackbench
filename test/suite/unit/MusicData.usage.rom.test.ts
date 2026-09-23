/**
 * Map-to-track attribution across the six real cartridges.
 *
 * This is the measurement behind the panel's two tiers. Attribution reads
 * the level-header decode, which survives AddmusicK, so it succeeds on ALL
 * SIX carts - including the three where the music bank cannot be located
 * and no track can be played. A panel that only listed playable tracks
 * would show nothing at all for those three.
 *
 * The vanilla row was cross-checked against an independent probe written
 * before this function existed: both report 235 real maps and the same
 * eight per-slot counts.
 *
 * Skips per file when test/roms/ is absent, which is always the case in CI.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import { readLevelMusicUsage } from '../../../src/rom/MusicData'

const ROMS_DIR = resolve(__dirname, '../../roms')

interface Expectation {
  realMapCount: number
  /** Maps selecting each of the eight 3-bit slots. */
  perSlot: number[]
  /** BGM command to map count, as the level music table resolves the slots. */
  perCommand: Record<number, number>
}

/** Measured 2026-09-21 on this repo's six-cartridge corpus, one machine. */
const EXPECTED: Record<string, Expectation> = {
  'Super Mario World (USA).vanilla.sfc': {
    realMapCount: 235,
    perSlot: [44, 33, 25, 37, 36, 5, 31, 24],
    perCommand: { 0x01: 25, 0x02: 44, 0x03: 5, 0x05: 31, 0x06: 33, 0x07: 36, 0x08: 37, 0x12: 24 },
  },
  'Super Mario World (USA).magic.sfc': {
    realMapCount: 235,
    perSlot: [44, 33, 25, 37, 36, 5, 31, 24],
    perCommand: { 0x01: 25, 0x02: 44, 0x03: 5, 0x05: 31, 0x06: 33, 0x07: 36, 0x08: 37, 0x12: 24 },
  },
  'Seven_Vanilla_Levels.sfc': {
    realMapCount: 251,
    perSlot: [51, 37, 26, 40, 33, 7, 32, 25],
    perCommand: { 0x01: 26, 0x02: 51, 0x03: 7, 0x05: 32, 0x06: 37, 0x07: 33, 0x08: 40, 0x12: 25 },
  },
  // The three AddmusicK carts. Their level music table points the eight
  // slots at BGM $0A-$12, so the commands differ from stock even though the
  // per-slot counts are read exactly the same way.
  'Grand Poo World 2 1.1.sfc': {
    realMapCount: 291,
    perSlot: [100, 33, 25, 37, 36, 5, 31, 24],
    perCommand: { 0x0a: 25, 0x0b: 100, 0x0c: 5, 0x0e: 31, 0x0f: 33, 0x10: 36, 0x11: 37, 0x12: 24 },
  },
  'GrandPooWorld_V1.2.sfc': {
    realMapCount: 235,
    perSlot: [43, 33, 25, 37, 36, 5, 32, 24],
    perCommand: { 0x0a: 25, 0x0b: 43, 0x0c: 5, 0x0e: 32, 0x0f: 33, 0x10: 36, 0x11: 37, 0x12: 24 },
  },
  'Invictus 1.0.sfc': {
    realMapCount: 354,
    perSlot: [102, 40, 36, 52, 43, 8, 46, 27],
    perCommand: { 0x0a: 36, 0x0b: 102, 0x0c: 8, 0x0e: 46, 0x0f: 40, 0x10: 43, 0x11: 52, 0x12: 27 },
  },
}

describe('readLevelMusicUsage (requires test/roms/*.sfc)', () => {
  for (const [file, expected] of Object.entries(EXPECTED)) {
    const path = resolve(ROMS_DIR, file)
    // skipIf per file: with the corpus absent these must still be
    // REGISTERED and reported skipped, not silently cease to exist.
    describe.skipIf(!existsSync(path))(file, () => {
      it(`counts ${expected.realMapCount} real maps`, () => {
        expect(readLevelMusicUsage(SmwRom.open(path)).realMapCount).toBe(expected.realMapCount)
      })

      it('splits them across the eight music slots', () => {
        const usage = readLevelMusicUsage(SmwRom.open(path))

        expect(usage.mapsBySlot.map(s => s.length)).toEqual(expected.perSlot)
        // Every real map lands in exactly one slot, so the split accounts
        // for all of them. A decode that dropped maps would still match the
        // per-slot array if the expectation were updated alongside it.
        expect(usage.mapsBySlot.reduce((n, s) => n + s.length, 0)).toBe(expected.realMapCount)
      })

      it('attributes maps to BGM commands even where the bank is unreadable', () => {
        const usage = readLevelMusicUsage(SmwRom.open(path))
        const counts = Object.fromEntries(
          [...usage.mapsByCommand.entries()].map(([c, m]) => [c, m.length]),
        )

        expect(usage.tableUnavailable).toBeUndefined()
        expect(counts).toEqual(expected.perCommand)
      })
    })
  }
})
