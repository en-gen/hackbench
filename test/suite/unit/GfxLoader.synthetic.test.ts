/**
 * GfxLoader - synthetic-ROM tests for pointer-table reads, BPP inference,
 * the FilterSomeRAM upload variant, char lookup, and Layer 3 GFX loading.
 *
 * The ROM-dependent integration test is skipped when the vanilla SMW ROM
 * isn't present; this file pins down the boundary behavior.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  GFX_PTR_LO,
  GFX_PTR_HI,
  GFX_PTR_BANK,
  GFX_FILE_COUNT,
  GFX_FGBG_TABLE,
  GFX_SPRITE_TABLE,
  VRAM_CHAR_BASE,
  loadGfxRaw,
  loadGfxFile,
  readGfxAssignment,
  loadVram,
  getCharPixels,
  isFilterSomeRamFile,
  applyFilterSomeRamTransform,
  getLayer3GfxRange,
  loadL3Chars,
  gfxBinPath,
} from '../../../src/rom/GfxLoader'

function make4MbRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('mock.smc', buf)
  // Default L3 range to vanilla $28..$2B so file 0 in BPP-inference tests
  // doesn't get treated as a Layer-3 (2bpp) file.
  rom.writeAt(0x00a99c, [3]) // count-1
  rom.writeAt(0x00a9a0, [0x28]) // start
  return rom
}

function makeTinyRom(): RomFile {
  return new RomFile('tiny.smc', Buffer.alloc(0x100))
}

const writeAddr = (rom: RomFile, fileIndex: number, snesAddr: number): void => {
  rom.writeAt(GFX_PTR_LO + fileIndex, [snesAddr & 0xff])
  rom.writeAt(GFX_PTR_HI + fileIndex, [(snesAddr >> 8) & 0xff])
  rom.writeAt(GFX_PTR_BANK + fileIndex, [(snesAddr >> 16) & 0xff])
}

/**
 * LZ2 stream that decompresses to `len` bytes of `fillByte`. Uses the
 * extended byte-fill command so we can request lengths > 32.
 */
function lz2ByteFill(len: number, fillByte: number): number[] {
  if (len <= 32) {
    // Standard cmd 1 (byte fill): header (1<<5) | (len-1)
    return [(1 << 5) | (len - 1), fillByte, 0xff]
  }
  // Extended: H = 0xE0 | (cmd<<2) | ((len-1)>>8 & 3); E = (len-1) & 0xFF
  const h = 0xe0 | (1 << 2) | (((len - 1) >> 8) & 3)
  const e = (len - 1) & 0xff
  return [h, e, fillByte, 0xff]
}

// ── getLayer3GfxRange ────────────────────────────────────────────────────────

describe('getLayer3GfxRange', () => {
  it('returns vanilla defaults ($28..$2B) when ROM bytes are missing', () => {
    // Tiny ROM → readByte returns null → fallback to start=$28, count-1=3.
    const rom = makeTinyRom()
    expect(getLayer3GfxRange(rom)).toEqual({ start: 0x28, end: 0x2b })
  })

  it('reads start + count from the immediate operands of CODE_00A993', () => {
    const rom = make4MbRom()
    rom.writeAt(0x00a99c, [4]) // count - 1 = 4 → count 5 files
    rom.writeAt(0x00a9a0, [0x30]) // start = $30
    expect(getLayer3GfxRange(rom)).toEqual({ start: 0x30, end: 0x34 })
  })
})

// ── loadGfxRaw ───────────────────────────────────────────────────────────────

describe('loadGfxRaw', () => {
  it('returns empty for fileIndex >= GFX_FILE_COUNT', () => {
    expect(loadGfxRaw(make4MbRom(), GFX_FILE_COUNT)).toEqual(new Uint8Array(0))
  })

  it('returns empty when any pointer-table byte is unreadable (tiny ROM)', () => {
    expect(loadGfxRaw(makeTinyRom(), 0)).toEqual(new Uint8Array(0))
  })

  it('returns empty when the resolved address points to unmapped memory', () => {
    const rom = make4MbRom()
    // Pointer to bank $7E (WRAM) → loromToOffset returns null → readAt fails.
    writeAddr(rom, 0, 0x7e0000)
    expect(loadGfxRaw(rom, 0)).toEqual(new Uint8Array(0))
  })

  it('decompresses a hand-built LZ2 stream', () => {
    const rom = make4MbRom()
    writeAddr(rom, 0, 0x108000)
    rom.writeAt(0x108000, lz2ByteFill(48, 0x33))
    expect(Array.from(loadGfxRaw(rom, 0))).toEqual(new Array(48).fill(0x33))
  })
})

// ── loadGfxFile BPP inference ────────────────────────────────────────────────

describe('loadGfxFile - BPP inference', () => {
  function setupGfx(rom: RomFile, fileIndex: number, bytes: number[]): void {
    writeAddr(rom, fileIndex, 0x108000 + fileIndex * 0x100)
    rom.writeAt(0x108000 + fileIndex * 0x100, bytes)
  }

  it('returns empty sheet (128 zero tiles) when fileIndex is out of range', () => {
    const sheet = loadGfxFile(make4MbRom(), GFX_FILE_COUNT)
    expect(sheet.length).toBe(128)
    expect(sheet[0].every(b => b === 0)).toBe(true)
  })

  it('returns empty sheet when decompressed data is empty', () => {
    const rom = make4MbRom()
    writeAddr(rom, 0, 0x108000)
    rom.writeAt(0x108000, [0xff]) // immediate terminator → empty data
    const sheet = loadGfxFile(rom, 0)
    expect(sheet.length).toBe(128)
  })

  it('decodes 2BPP for files in the Layer 3 range (16 bytes/tile)', () => {
    const rom = make4MbRom()
    rom.writeAt(0x00a99c, [3])
    rom.writeAt(0x00a9a0, [0x28])
    setupGfx(rom, 0x28, lz2ByteFill(16 * 4, 0x42))
    const sheet = loadGfxFile(rom, 0x28)
    expect(sheet.length).toBe(4)
    expect(sheet[0].length).toBe(64) // 8x8 tile
  })

  it('decodes 3BPP when total length is a multiple of 24 but not 32', () => {
    const rom = make4MbRom()
    setupGfx(rom, 0, lz2ByteFill(24 * 5, 0x55)) // 120 bytes
    const sheet = loadGfxFile(rom, 0)
    expect(sheet.length).toBe(5)
  })

  it('prefers 3BPP when length is divisible by both 24 and 32 (vanilla ROM convention)', () => {
    const rom = make4MbRom()
    // 96 bytes is divisible by 24 (4 tiles 3bpp) AND by 32 (3 tiles 4bpp).
    // Code prefers 3bpp.
    setupGfx(rom, 0, lz2ByteFill(96, 0x77))
    const sheet = loadGfxFile(rom, 0)
    expect(sheet.length).toBe(4)
  })

  it('decodes 4BPP when length is divisible by 32 but not 24', () => {
    const rom = make4MbRom()
    setupGfx(rom, 0, lz2ByteFill(32 * 3, 0xaa)) // 96 → divisible by both, but
    // we want NOT divisible by 24: 32*1 = 32 satisfies (not /24)
    setupGfx(rom, 1, lz2ByteFill(32, 0x33))
    const sheet = loadGfxFile(rom, 1)
    expect(sheet.length).toBe(1)
  })

  it('returns empty sheet when length is divisible by neither 24 nor 32', () => {
    const rom = make4MbRom()
    setupGfx(rom, 0, lz2ByteFill(33, 0x99)) // odd-ish length, divisible by neither
    const sheet = loadGfxFile(rom, 0)
    expect(sheet.length).toBe(128) // _emptySheet fallback
  })
})

// ── readGfxAssignment ────────────────────────────────────────────────────────

describe('readGfxAssignment', () => {
  it('returns the 4 bytes per slot from each table forward (no inversion)', () => {
    const rom = make4MbRom()
    rom.writeAt(GFX_FGBG_TABLE + 0 * 4, [0x10, 0x11, 0x12, 0x13])
    rom.writeAt(GFX_SPRITE_TABLE + 0 * 4, [0x20, 0x21, 0x22, 0x23])
    const a = readGfxAssignment(rom, 0, 0)
    expect(a.fg1).toBe(0x10)
    expect(a.fg2).toBe(0x11)
    expect(a.fg3).toBe(0x12)
    expect(a.an1).toBe(0x13)
    expect(a.sp1).toBe(0x20)
    expect(a.sp2).toBe(0x21)
    expect(a.sp3).toBe(0x22)
    expect(a.sp4).toBe(0x23)
  })

  it('falls back to 0 when buffers are unreadable (tiny ROM)', () => {
    const rom = makeTinyRom()
    const a = readGfxAssignment(rom, 0, 0)
    expect(a).toEqual({ fg1: 0, fg2: 0, fg3: 0, an1: 0, sp1: 0, sp2: 0, sp3: 0, sp4: 0 })
  })
})

// ── loadVram ─────────────────────────────────────────────────────────────────

describe('loadVram', () => {
  it('skips slots whose assigned fileIndex is >= GFX_FILE_COUNT', () => {
    const rom = make4MbRom()
    // Force one slot's file index out of range; others stay 0.
    rom.writeAt(GFX_FGBG_TABLE, [0xff, 0x00, 0x00, 0x00])
    const vram = loadVram(rom, 0, 0)
    expect(vram.fg1).toBeUndefined()
    expect(vram.fg2).toBeDefined() // file 0 is valid
  })

  it('applies the FilterSomeRAM transform for file $1E', () => {
    const rom = make4MbRom()
    // Place file $1E into the AN1 slot via the OBJECTGFXLIST.
    rom.writeAt(GFX_FGBG_TABLE, [0x00, 0x00, 0x00, 0x1e])
    // Set up file $1E to be empty (fast path returns 128 zero tiles).
    writeAddr(rom, 0x1e, 0x108000)
    rom.writeAt(0x108000, [0xff]) // empty after decompress
    const vram = loadVram(rom, 0, 0)
    // FilterSomeRAM was applied; even on empty sheet it doesn't error.
    expect(vram.an1).toBeDefined()
    expect(vram.an1!.length).toBe(128)
  })
})

// ── getCharPixels ────────────────────────────────────────────────────────────

describe('getCharPixels', () => {
  it('returns null when no slot covers the requested charNum', () => {
    expect(getCharPixels({}, 0x10)).toBeNull()
  })

  it('returns the indexed tile when in range of fg1 slot', () => {
    const sheet = Array.from({ length: 4 }, (_, i) => new Uint8Array(64).fill(i))
    expect(getCharPixels({ fg1: sheet }, 2)).toBe(sheet[2])
  })

  it('returns null when charNum is past the end of every loaded slot', () => {
    const sheet = [new Uint8Array(64)]
    expect(getCharPixels({ fg1: sheet }, 0x600)).toBeNull()
  })

  it('selects the correct slot for sp1 char range $400+', () => {
    const sheet = [new Uint8Array(64).fill(7)]
    const result = getCharPixels({ sp1: sheet }, VRAM_CHAR_BASE.sp1)
    expect(result?.[0]).toBe(7)
  })
})

// ── isFilterSomeRamFile ──────────────────────────────────────────────────────

describe('isFilterSomeRamFile', () => {
  it('file $1E is always FilterSomeRAM regardless of tileset', () => {
    expect(isFilterSomeRamFile(0x1e, 0)).toBe(true)
    expect(isFilterSomeRamFile(0x1e, 0x15)).toBe(true)
  })

  it('file $08 takes the path only when tileset >= $11 (overworld)', () => {
    expect(isFilterSomeRamFile(0x08, 0x10)).toBe(false)
    expect(isFilterSomeRamFile(0x08, 0x11)).toBe(true)
    expect(isFilterSomeRamFile(0x08, 0x17)).toBe(true)
  })

  it('other files never trigger FilterSomeRAM', () => {
    expect(isFilterSomeRamFile(0x00, 0)).toBe(false)
    expect(isFilterSomeRamFile(0x10, 0x15)).toBe(false)
  })
})

// ── applyFilterSomeRamTransform ──────────────────────────────────────────────

describe('applyFilterSomeRamTransform', () => {
  it('OR-bits 0x08 onto every non-zero pixel; leaves zeros alone', () => {
    const tile = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
    const transformed = applyFilterSomeRamTransform([tile])
    expect(Array.from(transformed[0])).toEqual([0, 9, 10, 11, 12, 13, 14, 15])
  })

  it('returns a fresh sheet (does not mutate input)', () => {
    const tile = new Uint8Array([0, 5])
    const sheet = [tile]
    applyFilterSomeRamTransform(sheet)
    expect(Array.from(tile)).toEqual([0, 5]) // unchanged
  })
})

// ── loadL3Chars ──────────────────────────────────────────────────────────────

describe('loadL3Chars', () => {
  it('returns one sheet per file in the L3 range', () => {
    const rom = make4MbRom()
    rom.writeAt(0x00a99c, [2]) // count - 1 = 2 → 3 files
    rom.writeAt(0x00a9a0, [0x28])
    const sheets = loadL3Chars(rom)
    expect(sheets.length).toBe(3)
  })
})

// ── gfxBinPath ──────────────────────────────────────────────────────────────

describe('gfxBinPath', () => {
  it('zero-pads the hex file index to 2 digits', () => {
    expect(gfxBinPath('/dir', 0x05)).toMatch(/GFX05\.bin$/)
    expect(gfxBinPath('/dir', 0x1a)).toMatch(/GFX1A\.bin$/)
  })
})
