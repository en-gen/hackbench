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
//
// NOTE: Previously this module exported ~35 `ADDR_DATA_0DXXXX` constants - the
// vanilla-SMW addresses of each data table referenced by an object handler.
// Those have all been removed. Object handlers now read their referenced table
// addresses from LDA.L operand bytes *inside the handler's own bytecode* via
// cur.handlerAddr + offset, so a Lunar-Magic-patched ROM that relocates a data
// table (by rewriting the LDA.L's 3-byte operand) still resolves correctly.
//
// A few data-table sizes are still referenced by tests:

export const DATA_0DA548_LEN = 51 // 51 tile IDs, extended single-tile objects

// ── Dispatch table addresses ──────────────────────────────────────────────────

/**
 * Extended-object dispatch table at CODE_0DA106 (bank_0D.asm line 1056).
 * CODE_0DA106 opcodes: SEP #$30 (2) + LDA.B LvlLoadObjSize (2) + TAX (1) + JSL (4) = 9 bytes.
 * Table starts at $0DA106 + 9 = $0DA10F. 128 entries (0x00-0x7F), 3 bytes each.
 */
export const ADDR_EXTENDED_DISPATCH = 0x0da10f
/** Extended-object dispatch table size: 256 entries covering all possible
 *  `LvlLoadObjSize` values (0-0xFF). Entries 0x49-0xFF all repeat CODE_0DA6D1
 *  so the vast majority of "unknown" ext types still have a defined handler. */
export const EXTENDED_DISPATCH_COUNT = 256

/**
 * Tileset dispatch table at CODE_0DA415 (bank_0D.asm line 1324).
 * CODE_0DA415 opcodes: SEP #$30 (2) + LDA.W ObjectTileset (3) + JSL (4) = 9 bytes.
 * Table starts at $0DA415 + 9 = $0DA41E. 15 entries, 3 bytes each.
 */
export const ADDR_TILESET_DISPATCH = 0x0da41e
export const TILESET_DISPATCH_COUNT = 15

/**
 * Tileset 0 / 7 / 12 standard-object handler pointer table at CODE_0DA44B.
 * CODE_0DA44B opcodes: SEP #$30 (2) + LDX.B LvlLoadObjNo (2) + DEX (1) + TXA (1) + JSL (4) = 10 bytes.
 * Table starts at $0DA44B + 10 = $0DA455. 63 entries (objects 1-0x3F), 3 bytes each.
 */
export const ADDR_TILESET0_HANDLERS = 0x0da455
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
