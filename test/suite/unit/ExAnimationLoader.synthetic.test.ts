/**
 * ExAnimationLoader - synthetic-ROM tests for Lunar Magic ExAnimation parsing.
 *
 * The vanilla ROM lacks LM patches, so the existing tests cover only the
 * "not installed" guard. These tests build a small in-memory ROM that
 * imitates LM's patch shape so each error path AND the happy parse paths
 * actually run.
 *
 * Reference: ExAnimationLoader.ts header comment (block layout).
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  isLmExAnimInstalled,
  loadExAnimData,
  readExAnimLevel,
} from '../../../src/rom/ExAnimationLoader'

/**
 * Hand-built LC_LZ2 stream that decompresses to 128 bytes of $42, terminated
 * by $FF. Header layout: extended cmd 1 (byte fill), length 128.
 *   H = 0xE0 | (real_cmd<<2) | ((len-1)>>8 & 3) = 0xE4
 *   E = (len-1) & 0xFF                          = 0x7F
 *   fill byte                                   = 0x42
 *   terminator                                  = 0xFF
 */
const LZ2_128_BYTES_OF_42 = [0xe4, 0x7f, 0x42, 0xff]

/** SNES addresses ExAnimationLoader watches. */
const ANIMATION_JSL_ADDR = 0x00a2a5
const ANIM_SETTINGS_TABLE = 0x03fe00
const EXANIM_LEVEL_TABLE_PTR = 0x0583ae
const EXGFX_LO_TABLE_ADDR = 0x0ff600
const EXGFX_HI_TABLE_ADDR = 0x0ff937
const EXGFX_LEVEL_LIST_PTR = 0x0ff7ff

/** Build an empty 4 MB LoROM buffer with map-mode byte set. */
function makeMockRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode → file offset for SNES $00FFD5
  return new RomFile('mock.smc', buf)
}

/** Write a 24-bit LE address into ROM at the given SNES address. */
function write3(rom: RomFile, snesAddr: number, value: number): void {
  rom.writeAt(snesAddr, [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff])
}

/** Redirect the JSL at $00A2A5 to a non-stock target. */
function installLmJsl(rom: RomFile, target: number = 0x108000): void {
  rom.writeAt(ANIMATION_JSL_ADDR, [
    0x22,
    target & 0xff,
    (target >> 8) & 0xff,
    (target >> 16) & 0xff,
  ])
}

// ── isLmExAnimInstalled ───────────────────────────────────────────────────────

describe('isLmExAnimInstalled', () => {
  // Goes red if detection by negation (any non-stock JSL target) comes back (#491).
  it('returns false when the JSL targets some other routine', () => {
    const rom = makeMockRom()
    installLmJsl(rom, 0x108000)
    expect(isLmExAnimInstalled(rom)).toBe(false)
  })
})

// ── loadExAnimData guard rails ───────────────────────────────────────────────

describe('loadExAnimData - guard paths', () => {
  it('returns null when LM is not installed (delegates to isLmExAnimInstalled)', () => {
    const rom = makeMockRom()
    expect(loadExAnimData(rom, 0)).toBeNull()
  })

  it('returns null when level-disable bit (0x20) is set in ANIM_SETTINGS_TABLE', () => {
    const rom = makeMockRom()
    rom.writeAt(ANIM_SETTINGS_TABLE + 5, [0x20]) // level 5 has disable bit
    expect(readExAnimLevel(rom, 5)).toBeNull()
  })

  it('returns null when level-table base pointer is $FFFFFF (read3 sentinel)', () => {
    const rom = makeMockRom()
    write3(rom, EXANIM_LEVEL_TABLE_PTR, 0xffffff)
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null when blockPtrBuf[1] === 0 (sentinel for "no ExAnim for this level")', () => {
    const rom = makeMockRom()
    // level table at SNES $108000, level 0's 3-byte slot has hi-byte 0
    write3(rom, EXANIM_LEVEL_TABLE_PTR, 0x108000)
    rom.writeAt(0x108000, [0x12, 0x00, 0x10]) // hi=0 → no data
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null when blockAddr resolves to $FFFFFF', () => {
    const rom = makeMockRom()
    write3(rom, EXANIM_LEVEL_TABLE_PTR, 0x108000)
    rom.writeAt(0x108000, [0xff, 0xff, 0xff]) // all-FF → invalid
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null when blockAddr resolves to 0 (with non-zero hi to bypass earlier guard)', () => {
    const rom = makeMockRom()
    write3(rom, EXANIM_LEVEL_TABLE_PTR, 0x108000)
    // hi=0 triggers "no ExAnim for level"; can't actually hit blockAddr===0
    // through this combination - that branch protects against malformed data.
    // Use a sentinel pointer that's all zeros via the hi byte alternative:
    // a 3-byte ptr of [0xFF, 0x01, 0x00] leaves the function reading at SNES $0001FF
    // (not ROM-mapped), which makes blockFixed null.
    rom.writeAt(0x108000, [0xff, 0x01, 0x00])
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null when ExGFX source-file lookup returns null (level list ptr is $FFFFFF)', () => {
    const rom = makeMockRom()
    // Level table → block at $108100 with valid header; ExGFX list ptr is invalid
    write3(rom, EXANIM_LEVEL_TABLE_PTR, 0x108000)
    rom.writeAt(0x108000, [0x00, 0x81, 0x10]) // → block at $108100
    rom.writeAt(0x108100, [0x01, 0x00]) // SS=1 slot, EE=0
    write3(rom, EXGFX_LEVEL_LIST_PTR, 0xffffff)
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null when EE-slot in ExGFX list is $FFFF (unset)', () => {
    const rom = makeMockRom()
    write3(rom, EXANIM_LEVEL_TABLE_PTR, 0x108000)
    rom.writeAt(0x108000, [0x00, 0x81, 0x10])
    rom.writeAt(0x108100, [0x01, 0x00])
    write3(rom, EXGFX_LEVEL_LIST_PTR, 0x108200)
    rom.writeAt(0x108200, [0xff, 0xff]) // level 0, slot 0 = $FFFF → unset
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null when EE-slot value is 0 (unused)', () => {
    const rom = makeMockRom()
    write3(rom, EXANIM_LEVEL_TABLE_PTR, 0x108000)
    rom.writeAt(0x108000, [0x00, 0x81, 0x10])
    rom.writeAt(0x108100, [0x01, 0x00])
    write3(rom, EXGFX_LEVEL_LIST_PTR, 0x108200)
    rom.writeAt(0x108200, [0x00, 0x00]) // unused
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null when fileNum < 0x80 (loadExGfxFile rejects low IDs)', () => {
    const rom = makeMockRom()
    write3(rom, EXANIM_LEVEL_TABLE_PTR, 0x108000)
    rom.writeAt(0x108000, [0x00, 0x81, 0x10])
    rom.writeAt(0x108100, [0x01, 0x00])
    write3(rom, EXGFX_LEVEL_LIST_PTR, 0x108200)
    rom.writeAt(0x108200, [0x10, 0x00]) // fileNum = $0010 < $80 → null
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null when ExGFX pointer-table entry is 0 (file slot empty)', () => {
    const rom = makeMockRom()
    write3(rom, EXANIM_LEVEL_TABLE_PTR, 0x108000)
    rom.writeAt(0x108000, [0x00, 0x81, 0x10])
    rom.writeAt(0x108100, [0x01, 0x00])
    write3(rom, EXGFX_LEVEL_LIST_PTR, 0x108200)
    rom.writeAt(0x108200, [0x80, 0x00]) // fileNum = $80 → look in LO table
    write3(rom, EXGFX_LO_TABLE_ADDR + (0x80 - 0x80) * 3, 0x000000) // ptr is 0
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })
})

// ── loadExAnimData happy paths ───────────────────────────────────────────────

describe('loadExAnimData - happy paths', () => {
  /**
   * Build a minimal valid ExAnim block with one GFX slot whose 4 tiles are
   * solid colors taken from a 4-tile decompressed ExGFX buffer.
   *
   * Block layout: SS=1, EE=0, CC IIii MMmm (no manual flags), one DDdd offset,
   * one slot AA=0 (GFX), TT=0, FF=0 (1 frame), DDdd vram word addr=$0040
   * (charBase = 4), one frame at RAM addr $AD00 (buffer offset 0).
   */
  function buildExAnimRom(
    opts: {
      fileNum?: number // default $80
      paletteOnly?: boolean // first slot has bit 7 set
      slotCount?: number
      badSlotCount?: boolean
      streamBytes?: number[]
    } = {},
  ): RomFile {
    const fileNum = opts.fileNum ?? 0x80
    const paletteOnly = opts.paletteOnly ?? false
    const slotCount = opts.slotCount ?? 1

    const rom = makeMockRom()
    installLmJsl(rom)

    // Level table → per-level entry
    write3(rom, EXANIM_LEVEL_TABLE_PTR, 0x108000)
    rom.writeAt(0x108000, [0x00, 0x81, 0x10]) // → $108100

    // ExAnim block at $108100
    // Fixed header (8 bytes): SS EE CCcc IIii MMmm
    const ss = opts.badSlotCount ? 0xff : slotCount
    rom.writeAt(0x108100, [ss, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

    // DDdd array starts at +8, with `slotCount` × 2-byte offsets to slot data.
    // Place each slot at offset 0x10 (relative to ddddArrayStart), 0x20, ...
    for (let s = 0; s < slotCount; s++) {
      const rel = 0x10 + s * 0x20
      rom.writeAt(0x108100 + 8 + s * 2, [rel & 0xff, (rel >> 8) & 0xff])
    }

    // Slot data: AA TT FF DDdd MMmm (1 frame, vram word addr = $0040 → charBase 4)
    for (let s = 0; s < slotCount; s++) {
      const rel = 0x10 + s * 0x20
      const slotAddr = 0x108100 + 8 + rel
      const aa = s === 0 && paletteOnly ? 0x80 : 0x00
      // 1 frame (FF=0), DDdd=$0040, frame ramAddr=$AD00 (buffer offset 0)
      rom.writeAt(slotAddr, [aa, 0x00, 0x00, 0x40, 0x00, 0x00, 0xad])
    }

    // ExGFX list: level 0 slot 0 → fileNum
    write3(rom, EXGFX_LEVEL_LIST_PTR, 0x108300)
    rom.writeAt(0x108300, [fileNum & 0xff, (fileNum >> 8) & 0xff])

    // Stamp a hand-built LZ2 stream that decompresses to 128 bytes (4 tiles).
    rom.writeAt(0x10a000, opts.streamBytes ?? LZ2_128_BYTES_OF_42)

    // Point the ExGFX pointer-table entry to the compressed buffer.
    const tableAddr =
      fileNum >= 0x100
        ? EXGFX_HI_TABLE_ADDR + (fileNum - 0x100) * 3
        : EXGFX_LO_TABLE_ADDR + (fileNum - 0x80) * 3
    write3(rom, tableAddr, 0x10a000)

    return rom
  }

  it('returns AnimationData with one frame for a single GFX slot', () => {
    const rom = buildExAnimRom({ fileNum: 0x80 })
    const data = readExAnimLevel(rom, 0)
    expect(data).not.toBeNull()
    expect(data!.frameCount).toBe(1)
    expect(data!.frames.length).toBe(1)
    expect(data!.frames[0].length).toBe(1)
    expect(data!.frames[0][0].charBase).toBe(4) // vramWord $0040 >> 4
    expect(data!.frames[0][0].tiles.length).toBe(4) // EXANIM_TILES_PER_SLOT
    // A parseable block behind a redirected JSL is still not installed.
    expect(loadExAnimData(rom, 0)).toBeNull()
  })

  it('handles fileNum >= $100 via the HI table (different lookup branch)', () => {
    const rom = buildExAnimRom({ fileNum: 0x108 })
    const data = readExAnimLevel(rom, 0)
    expect(data).not.toBeNull()
    expect(data!.frameCount).toBe(1)
  })

  it('returns null when the only slot is a palette slot (filtered out)', () => {
    const rom = buildExAnimRom({ paletteOnly: true })
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null when block header has SS = 0', () => {
    const rom = buildExAnimRom({ slotCount: 0 })
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null when block header has SS > 64 (corrupt)', () => {
    const rom = buildExAnimRom({ badSlotCount: true })
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })

  it('returns null rather than throwing or garbage tiles when the ExGFX stream fails to decompress', () => {
    // Same 4-byte stream with its $FF terminator dropped.
    const rom = buildExAnimRom({ streamBytes: LZ2_128_BYTES_OF_42.slice(0, -1) })
    expect(readExAnimLevel(rom, 0)).toBeNull()
  })
})
