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
import { SmwRom } from './SmwRom'
import { buildLevelCatalog } from './LevelCatalog'
import { BytePattern, WILD, findPattern } from './BytePattern'
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

// ── Gated read ───────────────────────────────────────────────────────────────

/**
 * TXA : LSR A x4 : AND #$07 : TAX : LDA.L table,X   (bank_05.asm:576-582)
 *
 * The three wildcards are the table's 24-bit address, which is an OPERAND
 * rather than a constant we supply. Reading it is how a relocated table is
 * still found, and it is the reason this does not hardcode
 * ADDR_LEVEL_MUSIC_TABLE the way `readLevelMusicTable` above does.
 *
 * The mask is part of the pattern, not a wildcard. Two instructions further
 * on, the same routine decodes the tileset with AND #$1F : TAX : LDA.L
 * (bank_05.asm:594); wildcarding the mask would match both and the site
 * would read as ambiguous.
 */
const MUSIC_DECODE: BytePattern = [
  0x8a,
  0x4a,
  0x4a,
  0x4a,
  0x4a,
  0x29,
  0x07,
  0xaa,
  0xbf,
  WILD,
  WILD,
  WILD,
]

/** Where the 24-bit operand sits inside MUSIC_DECODE. */
const TABLE_OPERAND_OFF = 9

/** Uniqueness is the verdict; counting past a couple is wasted work. */
const MATCH_LIMIT = 4

export interface LevelMusicTableRead {
  /** SNES address the LDA.L operand names. */
  address: number
  /** The 8 BGM commands, indexed by level header byte 2 bits 6:4. */
  commands: number[]
  /** SNES address of the decode site, so a reader can check the citation. */
  foundAt: number
}

export type LevelMusicTableResult =
  { status: 'ok'; table: LevelMusicTableRead } | { status: 'unavailable'; reason: string }

/** LoROM file offset back to the SNES address it was read from. */
function snesAddress(offset: number): number {
  return ((offset >> 15) << 16) | ((offset & 0x7fff) | 0x8000)
}

/**
 * The level music table, or a refusal saying why it could not be read.
 *
 * Differs from `readLevelMusicTable` in two ways that matter on a hack.
 * It finds the table through the instruction that reads it rather than at
 * a fixed address, so relocation is covered. And it REFUSES rather than
 * returning eight plausible bytes when the decode is not there: the stock
 * address holds something on every cartridge, and reporting whatever that
 * is as the level music table is the confidently-wrong answer this exists
 * to avoid.
 *
 * Measured across this repo's six-cartridge corpus: exactly one match on
 * all six, always naming $0584DB. The table does not move, but its CONTENTS
 * differ - the two stock carts read `02 06 01 08 07 03 05 12` and all four
 * edited ones read `0B 0F 0A 11 10 0C 0E 12`. That the address held on six
 * carts is an observation, not a guarantee, which is why it is still read
 * from the operand.
 */
export function readLevelMusicTableIfReadable(rom: RomFile): LevelMusicTableResult {
  const hits = findPattern(rom, MUSIC_DECODE, MATCH_LIMIT)
  if (hits.length === 0) {
    return {
      status: 'unavailable',
      reason: 'The level music decode was not found on this ROM',
    }
  }
  if (hits.length > 1) {
    return {
      status: 'unavailable',
      reason: `${hits.length} candidate level music decode sites; cannot say which one runs`,
    }
  }

  const site = hits[0]
  const operand = rom.readAtFileOffset(site + TABLE_OPERAND_OFF, 3)
  if (!operand) {
    return {
      status: 'unavailable',
      reason: 'The level music decode runs off the end of the ROM',
    }
  }
  const address = operand[0] | (operand[1] << 8) | (operand[2] << 16)

  const bytes = rom.readAt(address, LEVEL_MUSIC_COUNT)
  if (!bytes) {
    return {
      status: 'unavailable',
      reason: `The level music table at $${address.toString(16).toUpperCase().padStart(6, '0')} is outside the ROM`,
    }
  }

  return {
    status: 'ok',
    table: { address, commands: Array.from(bytes), foundAt: snesAddress(site) },
  }
}

// ── Which maps play which track ──────────────────────────────────────────────

/** Header byte 2 holds the music index in bits 6:4 (bank_05.asm:577-581). */
const MUSIC_INDEX_SHIFT = 4

export interface LevelMusicUsage {
  /** Real (non-filler) map slots counted. */
  realMapCount: number
  /** By 3-bit slot (0-7): the real map slots selecting it, ascending. */
  mapsBySlot: number[][]
  /**
   * BGM command to the real map slots that play it, ascending.
   *
   * Empty when the level music table could not be read: without it a slot
   * names no command, and inventing the stock mapping is exactly the
   * fallback this module exists to avoid. `tableUnavailable` says why.
   */
  mapsByCommand: Map<number, number[]>
  /** Why `mapsByCommand` is empty, when it is. Absent on success. */
  tableUnavailable?: string
}

/**
 * Attribute every real map to the track it plays.
 *
 * This is the part of the music panel that works on any cartridge. The
 * level-header decode survives AddmusicK on all six carts in this repo's
 * corpus, so a track can be attributed to its maps even where the bank
 * holding the song data cannot be located.
 *
 * FILLER SLOTS ARE EXCLUDED. The pointer table has 512 entries and 277 of
 * vanilla's share the filler pointer; counting them would report the filler
 * slot's music index 277 times and bury every real answer.
 *
 * Reads five bytes per slot rather than going through getLevelRawData,
 * which fetches up to 8 KB and copies it - 512 of those to read one byte
 * each is work for nothing.
 */
export function readLevelMusicUsage(smw: SmwRom): LevelMusicUsage {
  const catalog = buildLevelCatalog(smw)
  const mapsBySlot: number[][] = Array.from({ length: LEVEL_MUSIC_COUNT }, () => [])
  let realMapCount = 0

  // Ascending because catalog.entries is, which is what lets the panel list
  // a track's maps in slot order without sorting again.
  for (const entry of catalog.entries) {
    if (!entry.isReal) continue
    const header = smw.rom.readAt(entry.l1Pointer, 5)
    if (!header) continue
    realMapCount++
    mapsBySlot[(header[2] >> MUSIC_INDEX_SHIFT) & 0x07].push(entry.index)
  }

  const table = readLevelMusicTableIfReadable(smw.rom)
  if (table.status !== 'ok') {
    return { realMapCount, mapsBySlot, mapsByCommand: new Map(), tableUnavailable: table.reason }
  }

  // Two slots may name one command - a hack is free to point several of the
  // eight at one track - so these merge rather than overwrite.
  const mapsByCommand = new Map<number, number[]>()
  table.table.commands.forEach((command, slot) => {
    if (mapsBySlot[slot].length === 0) return
    const merged = [...(mapsByCommand.get(command) ?? []), ...mapsBySlot[slot]]
    mapsByCommand.set(
      command,
      merged.sort((a, b) => a - b),
    )
  })

  return { realMapCount, mapsBySlot, mapsByCommand }
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
