/**
 * SNES address mapping for LoROM and HiROM cartridges.
 *
 * ── LoROM layout ─────────────────────────────────────────────────────────────
 *   Banks $00–$3F, addr $8000–$FFFF → ROM (32KB per bank)
 *   Banks $40–$6F, addr $0000–$7FFF → ROM extended (uncommon)
 *   Banks $70–$7D                   → SRAM (not in ROM file)
 *   Banks $7E–$7F                   → WRAM (not in ROM file)
 *   Banks $80–$FF                   → mirrors of $00–$7F
 *
 * ── HiROM layout ─────────────────────────────────────────────────────────────
 *   Banks $00–$3F, addr $8000–$FFFF → ROM upper half (64KB per bank)
 *   Banks $40–$6F, addr $0000–$FFFF → ROM full (64KB pages, same data)
 *   Banks $70–$7D                   → SRAM
 *   Banks $7E–$7F                   → WRAM
 *   Banks $80–$BF, addr $8000–$FFFF → ROM mirrors of $00–$3F upper
 *   Banks $C0–$FF, addr $0000–$FFFF → ROM full (64KB pages)
 *
 * Formulas verified against Mesen2 source (SnesMemoryManager / MemoryMappings).
 */

import { hex6 } from './hex'

export const LOROM_BANK_SIZE  = 0x8000
export const HIROM_BANK_SIZE  = 0x10000
export const COPIER_HEADER_SIZE = 512

/** Returns true if the file size suggests a 512-byte copier header. */
export function hasCopierHeader(fileSize: number): boolean {
  return (fileSize % 1024) === COPIER_HEADER_SIZE
}

/**
 * Convert a 24-bit SNES LoROM address to a ROM file byte offset.
 * Returns null for addresses not backed by ROM (WRAM, SRAM, low-page system area).
 */
export function loromToOffset(snesAddr: number, headerOffset = false): number | null {
  const bank = (snesAddr >>> 16) & 0xFF
  const addr = snesAddr & 0xFFFF
  const effectiveBank = bank & 0x7F

  let offset: number

  if (effectiveBank <= 0x3F) {
    if (addr < 0x8000) return null
    offset = effectiveBank * LOROM_BANK_SIZE + (addr - 0x8000)
  } else if (effectiveBank <= 0x6F) {
    offset = (effectiveBank - 0x40) * LOROM_BANK_SIZE * 2 + addr
  } else {
    return null // SRAM ($70–$7D) or WRAM ($7E–$7F)
  }

  return offset + (headerOffset ? COPIER_HEADER_SIZE : 0)
}

/**
 * Convert a 24-bit SNES HiROM address to a ROM file byte offset.
 * Returns null for addresses not backed by ROM (WRAM, SRAM, low-page system area).
 */
export function hiromToOffset(snesAddr: number, headerOffset = false): number | null {
  const bank = (snesAddr >>> 16) & 0xFF
  const addr = snesAddr & 0xFFFF
  const effectiveBank = bank & 0x3F

  let offset: number

  if (bank <= 0x3F || (bank >= 0x80 && bank <= 0xBF)) {
    // Banks $00–$3F and $80–$BF: ROM only at $8000–$FFFF (upper 32KB)
    if (addr < 0x8000) return null
    offset = effectiveBank * HIROM_BANK_SIZE + addr
  } else if ((bank >= 0x40 && bank <= 0x6F) || bank >= 0xC0) {
    // Banks $40–$6F and $C0–$FF: full 64KB ROM pages
    offset = effectiveBank * HIROM_BANK_SIZE + addr
  } else {
    return null // $70–$7F: SRAM or WRAM
  }

  return offset + (headerOffset ? COPIER_HEADER_SIZE : 0)
}

/** Format a SNES address as "$05E000". */
export function formatAddr(addr: number): string {
  return '$' + hex6(addr)
}
