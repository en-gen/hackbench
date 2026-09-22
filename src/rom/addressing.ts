/**
 * SNES address mapping for LoROM and HiROM cartridges.
 *
 * LoROM: `(bank & 0x7F) * 0x8000 + (addr & 0x7FFF)`, valid for banks
 * $00-$7D/$80-$FF. Excludes banks $00-$3F/$80-$BF at addr < $8000
 * (registers/WRAM mirror) and banks $7E-$7F (WRAM; A23 does not gate
 * /WRAMSEL, so their $FE/$FF mirror is real ROM). Ceiling: 4MB (128
 * banks x 32KB). For the hardware citations, the WRAM-pinout detail
 * and the 4MB limitation see Copetti, Super Nintendo Architecture
 * (copetti.org/writings/consoles/super-nintendo/), indexed in
 * docs/references.md.
 */

import { hex6 } from './hex'

export const LOROM_BANK_SIZE = 0x8000
export const HIROM_BANK_SIZE = 0x10000
export const COPIER_HEADER_SIZE = 512

/** Returns true if the file size suggests a 512-byte copier header. */
export function hasCopierHeader(fileSize: number): boolean {
  return fileSize % 1024 === COPIER_HEADER_SIZE
}

/**
 * Convert a 24-bit SNES LoROM address to a ROM file byte offset.
 *
 * @param snesAddr    24-bit SNES address (bank << 16 | addr).
 * @param romSize     Actual ROM data length in bytes (header-stripped, i.e.
 *                    `RomFile.romSize`). Required: banks $40-$7D are ROM on
 *                    expanded carts but SRAM/unmapped on small ones, and the
 *                    only way to tell them apart is against the real size.
 * @param headerOffset  Add the 512-byte copier header to the returned offset.
 * @returns File offset, or null for WRAM ($7E-$7F, always) or any address
 *          that maps past the end of the actual ROM data.
 */
export function loromToOffset(
  snesAddr: number,
  romSize: number,
  headerOffset = false,
): number | null {
  const bank = (snesAddr >>> 16) & 0xff
  const addr = snesAddr & 0xffff

  // Check the raw bank BEFORE the & 0x7F mirror fold below - /WRAMSEL
  // decodes only the literal banks $7E/$7F, not A23, so folding first would
  // wrongly reject the $FE/$FF ROM mirror.
  if (bank === 0x7e || bank === 0x7f) return null

  const effectiveBank = bank & 0x7f // $80-$FF mirror $00-$7F
  if (effectiveBank <= 0x3f && addr < 0x8000) return null // registers / WRAM mirror

  const dataOffset = effectiveBank * LOROM_BANK_SIZE + (addr & 0x7fff)
  if (!(dataOffset < romSize)) return null // beyond real data (also rejects NaN/undefined romSize)

  return dataOffset + (headerOffset ? COPIER_HEADER_SIZE : 0)
}

/**
 * The inverse of `loromToOffset`: the SNES address a file offset is reached
 * through, in the $00-$7D half of the map.
 *
 * Needed by anything that WRITES a pointer, because a pointer table holds
 * SNES addresses and a layout is computed in file offsets. Returns null past
 * the 4MB LoROM ceiling, where no such address exists.
 */
export function loromFromOffset(fileOffset: number): number | null {
  if (!Number.isInteger(fileOffset) || fileOffset < 0) return null
  const bank = Math.floor(fileOffset / LOROM_BANK_SIZE)
  if (bank > 0x7d) return null
  return (bank << 16) | ((fileOffset % LOROM_BANK_SIZE) + 0x8000)
}

/**
 * Convert a 24-bit SNES HiROM address to a ROM file byte offset.
 * Returns null for addresses not backed by ROM (WRAM, SRAM, low-page system area).
 * Unused by any SMW pointer path (SMW ships LoROM only) and kept only for
 * completeness: its $40-$6F branch collapses to the same offsets as
 * $00-$3F rather than the "distinct 64KB pages" a real HiROM board has,
 * but nothing in this codebase exercises that branch.
 */
export function hiromToOffset(snesAddr: number, headerOffset = false): number | null {
  const bank = (snesAddr >>> 16) & 0xff
  const addr = snesAddr & 0xffff
  const effectiveBank = bank & 0x3f

  let offset: number

  if (bank <= 0x3f || (bank >= 0x80 && bank <= 0xbf)) {
    // Banks $00–$3F and $80–$BF: ROM only at $8000–$FFFF (upper 32KB)
    if (addr < 0x8000) return null
    offset = effectiveBank * HIROM_BANK_SIZE + addr
  } else if ((bank >= 0x40 && bank <= 0x6f) || bank >= 0xc0) {
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
