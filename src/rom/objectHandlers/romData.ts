/**
 * romData.ts -- ROM-sourced data tables and pointer-table readers for object handlers.
 *
 * All data lives at fixed SNES addresses in bank $0D / $05 of the ROM. We read
 * directly from the ROM file rather than embedding the bytes, so any ROM hack
 * (e.g. Lunar Magic) with relocated tables is still supported if the pointers
 * in the dispatch tables are updated accordingly.
 *
 * Addresses derived from SMWDisX bank_0D.asm / bank_05.asm labels. Byte offsets
 * of the dispatch tables are computed from the fixed 65816 opcode sizes preceding
 * each JSL ExecutePtrLong.
 */

import { RomFile } from '../RomFile'

// ── Data tables ───────────────────────────────────────────────────────────────

/** DATA_0DA8B4 (bank_0D.asm line 1909): 15 tile IDs for CODE_0DA8C3 (objects 1-14). */
export const ADDR_DATA_0DA8B4 = 0x0DA8B4
export const DATA_0DA8B4_LEN = 15

/** DATA_0DA548 (bank_0D.asm line 1449): 51 tile IDs for extended single-tile objects. */
export const ADDR_DATA_0DA548 = 0x0DA548
export const DATA_0DA548_LEN = 51

/** DATA_0DA8A6 (bank_0D.asm line 1901): 8-byte bitmask table for item-memory checks. */
export const ADDR_DATA_0DA8A6 = 0x0DA8A6
export const DATA_0DA8A6_LEN = 8

/** DATA_0DAA12 (bank_0D.asm line 2118): 5 tile IDs, left edge of horizontal ledge (top row). */
export const ADDR_DATA_0DAA12 = 0x0DAA12
/** DATA_0DAA17 (bank_0D.asm line 2121): 5 tile IDs, left edge of horizontal ledge (bottom row). */
export const ADDR_DATA_0DAA17 = 0x0DAA17
/** DATA_0DAA1C (bank_0D.asm line 2124): 5 tile IDs, right edge of horizontal ledge (top row). */
export const ADDR_DATA_0DAA1C = 0x0DAA1C
/** DATA_0DAA21 (bank_0D.asm line 2127): 5 tile IDs, right edge of horizontal ledge (bottom row). */
export const ADDR_DATA_0DAA21 = 0x0DAA21

/** DATA_0DAAA4 (bank_0D.asm line 2195): 8 tile IDs, used-block top row. */
export const ADDR_DATA_0DAAA4 = 0x0DAAA4
/** DATA_0DAAAC (bank_0D.asm line 2197): 8 tile IDs, used-block bottom row. */
export const ADDR_DATA_0DAAAC = 0x0DAAAC

/** DATA_0DB3BB (bank_0D.asm line 3452): 2 tile IDs, coin cloud / trampoline base. */
export const ADDR_DATA_0DB3BB = 0x0DB3BB

/** DATA_0DB3DB (bank_0D.asm line 3474): 4 tile IDs, top row for CODE_0DB3E3 two-row fill. */
export const ADDR_DATA_0DB3DB = 0x0DB3DB
/** DATA_0DB3DF (bank_0D.asm line 3477): 4 tile IDs, lower rows for CODE_0DB3E3 two-row fill. */
export const ADDR_DATA_0DB3DF = 0x0DB3DF

/** DATA_0DB42B (bank_0D.asm line 3519): 2 tile IDs for the goal-tape handler. */
export const ADDR_DATA_0DB42B = 0x0DB42B

/** DATA_0DA652 (bank_0D.asm line 1579): 2 tile IDs, ADDR_0DA656 top tile. */
export const ADDR_DATA_0DA652 = 0x0DA652
/** DATA_0DA654 (bank_0D.asm line 1582): 2 tile IDs, ADDR_0DA656 bottom tile. */
export const ADDR_DATA_0DA654 = 0x0DA654

/** DATA_0DA671 (bank_0D.asm line 1600): 2 tile IDs, CODE_0DA673 top tile. */
export const ADDR_DATA_0DA671 = 0x0DA671

/** DATA_0DA6CD (bank_0D.asm line 1654): 2 tile IDs, CODE_0DA6D1 top tile. */
export const ADDR_DATA_0DA6CD = 0x0DA6CD
/** DATA_0DA6CF (bank_0D.asm line 1657): 2 tile IDs, CODE_0DA6D1 bottom tile. */
export const ADDR_DATA_0DA6CF = 0x0DA6CF

/** DATA_0DB569 (bank_0D.asm line 3712): 8 tile IDs for ADDR_0DB571 single-tile stamps. */
export const ADDR_DATA_0DB569 = 0x0DB569

/** DATA_0DB5A8 (bank_0D.asm line 3752): 5 tile IDs, CODE_0DB5B7 left cap. */
export const ADDR_DATA_0DB5A8 = 0x0DB5A8
/** DATA_0DB5AD (bank_0D.asm line 3755): 5 tile IDs, CODE_0DB5B7 middle. */
export const ADDR_DATA_0DB5AD = 0x0DB5AD
/** DATA_0DB5B2 (bank_0D.asm line 3758): 5 tile IDs, CODE_0DB5B7 right cap. */
export const ADDR_DATA_0DB5B2 = 0x0DB5B2

/** DATA_0DB039 (bank_0D.asm line 2997): 15 tile IDs, CODE_0DB075 top segment. */
export const ADDR_DATA_0DB039 = 0x0DB039
/** DATA_0DB048 (bank_0D.asm line 3001): 15 tile IDs, CODE_0DB075 row-1 segment. */
export const ADDR_DATA_0DB048 = 0x0DB048
/** DATA_0DB057 (bank_0D.asm line 3005): 15 tile IDs, CODE_0DB075 middle segment. */
export const ADDR_DATA_0DB057 = 0x0DB057
/** DATA_0DB066 (bank_0D.asm line 3009): 15 tile IDs, CODE_0DB075 optional footer. */
export const ADDR_DATA_0DB066 = 0x0DB066

/** DATA_0DB212/215/218 (bank_0D.asm lines 3216/3219/3222): 3-byte tile triples
 *  for CODE_0DB224's primary variant (top / middle / bottom of each column). */
export const ADDR_DATA_0DB212 = 0x0DB212
export const ADDR_DATA_0DB215 = 0x0DB215
export const ADDR_DATA_0DB218 = 0x0DB218
/** DATA_0DB21B/21E/221 (lines 3225/3228/3231): alt-variant triples. */
export const ADDR_DATA_0DB21B = 0x0DB21B
export const ADDR_DATA_0DB21E = 0x0DB21E
export const ADDR_DATA_0DB221 = 0x0DB221

// ── Dispatch table addresses ──────────────────────────────────────────────────

/**
 * Extended-object dispatch table at CODE_0DA106 (bank_0D.asm line 1056).
 * CODE_0DA106 opcodes: SEP #$30 (2) + LDA.B LvlLoadObjSize (2) + TAX (1) + JSL (4) = 9 bytes.
 * Table starts at $0DA106 + 9 = $0DA10F. 128 entries (0x00-0x7F), 3 bytes each.
 */
export const ADDR_EXTENDED_DISPATCH = 0x0DA10F
/** Extended-object dispatch table size: 256 entries covering all possible
 *  `LvlLoadObjSize` values (0-0xFF). Entries 0x49-0xFF all repeat CODE_0DA6D1
 *  so the vast majority of "unknown" ext types still have a defined handler. */
export const EXTENDED_DISPATCH_COUNT = 256

/**
 * Tileset dispatch table at CODE_0DA415 (bank_0D.asm line 1324).
 * CODE_0DA415 opcodes: SEP #$30 (2) + LDA.W ObjectTileset (3) + JSL (4) = 9 bytes.
 * Table starts at $0DA415 + 9 = $0DA41E. 15 entries, 3 bytes each.
 */
export const ADDR_TILESET_DISPATCH = 0x0DA41E
export const TILESET_DISPATCH_COUNT = 15

/**
 * Tileset 0 / 7 / 12 standard-object handler pointer table at CODE_0DA44B.
 * CODE_0DA44B opcodes: SEP #$30 (2) + LDX.B LvlLoadObjNo (2) + DEX (1) + TXA (1) + JSL (4) = 10 bytes.
 * Table starts at $0DA44B + 10 = $0DA455. 63 entries (objects 1-0x3F), 3 bytes each.
 */
export const ADDR_TILESET0_HANDLERS = 0x0DA455
export const STANDARD_HANDLER_COUNT = 63

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read a fixed-length byte table from ROM. Returns zero-filled array on failure. */
export function readByteTable(rom: RomFile, snesAddr: number, length: number): number[] {
  const buf = rom.readAt(snesAddr, length)
  if (!buf) return new Array(length).fill(0)
  return Array.from(buf)
}

/**
 * Read a 24-bit (long) pointer from ROM. Returns null if unreadable.
 * Layout: little-endian low, hi, bank.
 */
export function readLongPointer(rom: RomFile, snesAddr: number): number | null {
  const buf = rom.readAt(snesAddr, 3)
  if (!buf) return null
  return (buf[2] << 16) | (buf[1] << 8) | buf[0]
}

/**
 * Read an array of N 24-bit pointers starting at a ROM address.
 * Each entry is a `dl` (long pointer, 3 bytes). Null entries come through as 0.
 */
export function readLongPointerTable(rom: RomFile, snesAddr: number, count: number): number[] {
  const buf = rom.readAt(snesAddr, count * 3)
  const out: number[] = new Array(count).fill(0)
  if (!buf) return out
  for (let i = 0; i < count; i++) {
    const o = i * 3
    out[i] = (buf[o + 2] << 16) | (buf[o + 1] << 8) | buf[o]
  }
  return out
}
