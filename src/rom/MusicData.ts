/**
 * MusicData.ts - Level music table parser for Super Mario World.
 *
 * The game selects background music via a 3-bit index stored in level header
 * byte 2, bits 6:4. This index is used to look up an SPC BGM command byte
 * from the LevelMusicTable.
 *
 * From SMWDisX bank_05.asm (CODE_0584E3, lines 576-582):
 *   LSR A (x4)        ; shift header byte 2 right by 4
 *   AND #$07           ; mask to 3 bits → music index 0-7
 *   TAX
 *   LDA LevelMusicTable,X   ; read BGM command byte
 *
 * LevelMusicTable at $0584DB (bank_05.asm line 513):
 *   8 bytes, one SPC BGM command per entry.
 *
 * The BGM command byte is written to the SPC communication port to start
 * playback. Values 0-29 select different music tracks; the exact mapping
 * depends on the N-SPC engine's track table in ARAM.
 */

import { RomFile } from './RomFile'
import { getLevelMusicBankAddr, countBankSongs } from './SpcBuilder'

// ── ROM addresses ────────────────────────────────────────────────────────────

/** LevelMusicTable: 8-byte table mapping 3-bit header index → BGM command.
 *  bank_05.asm line 513, verified at SNES $0584DB. */
export const ADDR_LEVEL_MUSIC_TABLE = 0x0584db

/** Number of entries in the LevelMusicTable (3-bit index → 8 values). */
export const LEVEL_MUSIC_COUNT = 8

// ── Types ────────────────────────────────────────────────────────────────────

export interface LevelMusicEntry {
  /** 3-bit index (0-7) from level header byte 2 bits 6:4. */
  index: number
  /** SPC BGM command byte read from LevelMusicTable[index]. */
  bgmCommand: number
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read the full LevelMusicTable from ROM.
 * Returns 8 entries mapping header index → BGM command byte.
 */
export function readLevelMusicTable(rom: RomFile): LevelMusicEntry[] {
  const buf = rom.readAt(ADDR_LEVEL_MUSIC_TABLE, LEVEL_MUSIC_COUNT)
  if (!buf) return []
  return Array.from({ length: LEVEL_MUSIC_COUNT }, (_, i) => ({
    index: i,
    bgmCommand: buf[i],
  }))
}

/**
 * Get the BGM command byte for a given 3-bit music index.
 * Returns the raw SPC command value, or 0 if the table can't be read.
 */
export function getLevelMusicBgm(rom: RomFile, musicIndex: number): number {
  if (musicIndex < 0 || musicIndex >= LEVEL_MUSIC_COUNT) return 0
  const byte = rom.readByte(ADDR_LEVEL_MUSIC_TABLE + musicIndex)
  return byte ?? 0
}

// ── Full track enumeration ───────────────────────────────────────────────────

export interface BgmTrack {
  /** 1-based BGM command number (the value sent to the SPC engine). */
  bgmCommand: number
}

/**
 * Enumerate all playable BGM tracks in the level music bank.
 * Reads the song pointer table from the music bank to determine the count.
 * Each track is identified by its BGM command number (1-based).
 */
export function getAllLevelBgmTracks(rom: RomFile): BgmTrack[] {
  const bankAddr = getLevelMusicBankAddr(rom)
  const count = countBankSongs(rom, bankAddr)
  return Array.from({ length: count }, (_, i) => ({ bgmCommand: i + 1 }))
}
