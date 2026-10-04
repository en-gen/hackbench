/**
 * L2Loader - synthetic-ROM tests for the preset-BG and object-stream L2 paths,
 * scroll-range computation, and the per-level Layer2YPos initialization.
 *
 * Existing L2Loader tests are gated on the vanilla SMW ROM and skip when it's
 * absent. These tests pin down the boundary cases without that dependency.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  readL2Pointer,
  isPresetPtr,
  loadL2Preset,
  loadL2Objects,
  readInitialLayer2YPos,
  enumerateL2Presets,
  findLevelScrollSprite,
  findLevelScrollSpriteFull,
  readL2ScrollBounds,
  computeL2ScrollRange,
  L2_POINTER_TABLE,
  L2_BG_BANK,
  L2_TILEMAP_COLS,
  L2_TILEMAP_ROWS,
  L2_EMPTY_TILE,
  SCROLL_SPRITE_BASE,
} from '../../../src/rom/L2Loader'
import type { LevelSprite } from '../../../src/rom/LevelParser'

function make4MbRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  return new RomFile('mock.smc', buf)
}

function makeTinyRom(): RomFile {
  return new RomFile('tiny.smc', Buffer.alloc(0x100))
}

// ── readL2Pointer ────────────────────────────────────────────────────────────

describe('readL2Pointer', () => {
  it('returns null when ROM reads fail (tiny ROM)', () => {
    expect(readL2Pointer(makeTinyRom(), 0)).toBeNull()
  })

  it('packs lo/hi/bank into a 24-bit value', () => {
    const rom = make4MbRom()
    rom.writeAt(L2_POINTER_TABLE + 5 * 3, [0xab, 0xcd, 0xff])
    expect(readL2Pointer(rom, 5)).toBe(0xffcdab)
  })
})

// ── isPresetPtr ──────────────────────────────────────────────────────────────

describe('isPresetPtr', () => {
  it('true when bank byte is $FF', () => {
    expect(isPresetPtr(0xff1234)).toBe(true)
  })

  it('false when bank byte is anything else', () => {
    expect(isPresetPtr(0x0e1234)).toBe(false)
    expect(isPresetPtr(0x000000)).toBe(false)
  })
})

// ── loadL2Preset ─────────────────────────────────────────────────────────────

describe('loadL2Preset', () => {
  it('returns null when bank byte is not $FF', () => {
    const rom = make4MbRom()
    expect(loadL2Preset(rom, 0x0e1234)).toBeNull()
  })

  it('returns null when raw data read fails', () => {
    const rom = makeTinyRom()
    // Pointer = $FF8000 but the ROM is too small to read at $0C:8000.
    expect(loadL2Preset(rom, 0xff8000)).toBeNull()
  })

  it('builds a 32x27 grid filled with (page<<8 | $25) when stream is empty', () => {
    const rom = make4MbRom()
    // Pointer with low word < threshold → page 0.
    // Stream at SNES $0C:8000 starts with the LC_RLE1 terminator $FF $FF.
    rom.writeAt(0x0c8000, [0xff, 0xff])
    const result = loadL2Preset(rom, 0xff8000)
    expect(result).not.toBeNull()
    expect(result!.page).toBe(0)
    expect(result!.dataAddr).toBe((L2_BG_BANK << 16) | 0x8000)
    expect(result!.grid.length).toBe(L2_TILEMAP_ROWS)
    expect(result!.grid[0].length).toBe(L2_TILEMAP_COLS)
    // Empty stream → every cell stays at the pre-init value (page=0 → 0x25).
    expect(result!.grid[0][0]).toBe(L2_EMPTY_TILE)
  })

  it('selects page 1 when the low-word address >= L2_PAGE_THRESHOLD', () => {
    const rom = make4MbRom()
    // Pointer = $FF:E900 → low word = $E900 >= $E8FE
    rom.writeAt(0x0ce900, [0xff, 0xff])
    const result = loadL2Preset(rom, 0xffe900)
    expect(result!.page).toBe(1)
    expect(result!.grid[0][0]).toBe((1 << 8) | L2_EMPTY_TILE)
  })

  it('decompressed bytes overwrite cells with (page<<8 | byte)', () => {
    const rom = make4MbRom()
    // LC_RLE1 stream that emits a single fill of $77 for 16 bytes, then terminates.
    // Refer to LcRle1.ts for the exact format; use a simple cmd byte.
    // (Format simplification: write the bytes that decompressRle1 should emit
    // by giving it those bytes verbatim through the literal-mode cmd.)
    // Use the cmd $0F (literal length 16) followed by 16 bytes of $77, then $FF $FF.
    const stream = [0x0f, ...new Array(16).fill(0x77), 0xff, 0xff]
    rom.writeAt(0x0c8000, stream)
    const result = loadL2Preset(rom, 0xff8000)
    expect(result).not.toBeNull()
    // First 16 bytes go to row 0 cols 0-15 of left screen.
    for (let c = 0; c < 16; c++) {
      expect(result!.grid[0][c]).toBe((0 << 8) | 0x77)
    }
  })
})

// ── loadL2Objects ────────────────────────────────────────────────────────────

describe('loadL2Objects', () => {
  it('returns null for preset-BG pointers', () => {
    const rom = make4MbRom()
    expect(loadL2Objects(rom, 0xff8000, 8, 0, false)).toBeNull()
  })

  it('returns null when object-stream data is unreadable (tiny ROM)', () => {
    const rom = makeTinyRom()
    expect(loadL2Objects(rom, 0x078000, 8, 0, false)).toBeNull()
  })

  it('returns a grid for empty L2 streams (5-byte header + $FF terminator)', () => {
    const rom = make4MbRom()
    rom.writeAt(0x078000, [0, 0, 0, 0, 0, 0xff])
    const result = loadL2Objects(rom, 0x078000, 1, 0, false)
    expect(result).not.toBeNull()
    expect(result!.grid.length).toBeGreaterThan(0)
  })
})

// ── readInitialLayer2YPos ────────────────────────────────────────────────────

describe('readInitialLayer2YPos', () => {
  const DATA_05F400 = 0x05f400
  const DATA_05D70C = 0x05d70c
  const DATA_05F600 = 0x05f600

  it('main level reads DATA_05F400 bits 1:0 → DATA_05D70C[idx]', () => {
    const rom = make4MbRom()
    rom.writeAt(DATA_05F400 + 5, [0x02]) // bits 1:0 = 2
    rom.writeAt(DATA_05D70C + 2, [0xc0])
    expect(readInitialLayer2YPos(rom, 5, false)).toBe(0xc0)
  })

  it('vertical level appends high byte from DATA_05F600 & 0x1F', () => {
    const rom = make4MbRom()
    rom.writeAt(DATA_05F400 + 5, [0x01])
    rom.writeAt(DATA_05D70C + 1, [0x90])
    rom.writeAt(DATA_05F600 + 5, [0x1f])
    expect(readInitialLayer2YPos(rom, 5, true)).toBe((0x1f << 8) | 0x90)
  })

  it('VertLayer2Setting 3 (DATA_05D710) leaves the high byte at 0', () => {
    const rom = make4MbRom()
    rom.writeAt(DATA_05F400 + 5, [0x01])
    rom.writeAt(DATA_05D70C + 1, [0x90])
    rom.writeAt(DATA_05F600 + 5, [0x03])
    rom.writeAt(0x05f000 + 5, [0x10]) // index 1 of DATA_05D710: not 3, so the high byte is written
    rom.writeAt(0x05d710 + 1, [0x01])
    expect(readInitialLayer2YPos(rom, 5, true)).toBe(0x0390)
    rom.writeAt(0x05f000 + 5, [0x00]) // index 0
    rom.writeAt(0x05d710, [0x03]) // the vanilla value for index 0
    expect(readInitialLayer2YPos(rom, 5, true)).toBe(0x90)
  })

  it('sublevel without targeting entrance falls back to primary F400 path', () => {
    const rom = make4MbRom()
    // $111 has no targeting entrance in our zeroed ROM.
    rom.writeAt(DATA_05F400 + 0x111, [0x02])
    rom.writeAt(DATA_05D70C + 2, [0xc0])
    expect(readInitialLayer2YPos(rom, 0x111, false)).toBe(0xc0)
  })
})

// ── enumerateL2Presets ───────────────────────────────────────────────────────

describe('enumerateL2Presets', () => {
  it('returns an empty array when no preset pointers exist', () => {
    const rom = make4MbRom()
    expect(enumerateL2Presets(rom, 4)).toEqual([])
  })

  it('groups levels that share the same preset pointer', () => {
    const rom = make4MbRom()
    rom.writeAt(L2_POINTER_TABLE + 0 * 3, [0x00, 0x80, 0xff]) // preset $FF8000
    rom.writeAt(L2_POINTER_TABLE + 1 * 3, [0x00, 0x80, 0xff]) // same preset
    rom.writeAt(L2_POINTER_TABLE + 2 * 3, [0x00, 0x90, 0xff]) // different preset
    rom.writeAt(L2_POINTER_TABLE + 3 * 3, [0x00, 0x80, 0x07]) // not preset (bank != $FF)
    const result = enumerateL2Presets(rom, 4)
    expect(result.length).toBe(2)
    const first = result.find(r => (r.ptr & 0xffff) === 0x8000)!
    expect(first.levels).toEqual([0, 1])
  })

  it('sorts entries by low-word address', () => {
    const rom = make4MbRom()
    rom.writeAt(L2_POINTER_TABLE + 0 * 3, [0x00, 0xc0, 0xff])
    rom.writeAt(L2_POINTER_TABLE + 1 * 3, [0x00, 0x80, 0xff])
    const result = enumerateL2Presets(rom, 2)
    expect(result[0].ptr & 0xffff).toBe(0x8000)
    expect(result[1].ptr & 0xffff).toBe(0xc000)
  })
})

// ── Scroll-sprite helpers ────────────────────────────────────────────────────

function fakeSprite(spriteId: number, b0 = 0): LevelSprite {
  return { screen: 0, x: 0, y: 0, spriteId, extraBit: false, raw: [b0, 0, spriteId] }
}

describe('findLevelScrollSprite', () => {
  it('returns null when no sprite has id >= $E7', () => {
    expect(findLevelScrollSprite([fakeSprite(0x10), fakeSprite(0x80)])).toBeNull()
  })

  it('returns (id - $E7) for the first scroll sprite encountered', () => {
    expect(
      findLevelScrollSprite([
        fakeSprite(0x10),
        fakeSprite(SCROLL_SPRITE_BASE + 0x05),
        fakeSprite(SCROLL_SPRITE_BASE + 0x07), // ignored - first wins
      ]),
    ).toBe(0x05)
  })
})

describe('findLevelScrollSpriteFull', () => {
  it('also returns the raw byte 0', () => {
    const result = findLevelScrollSpriteFull([fakeSprite(SCROLL_SPRITE_BASE + 0x02, 0xab)])
    expect(result).toEqual({ spriteId: SCROLL_SPRITE_BASE + 0x02, b0: 0xab })
  })

  it('returns null when no scroll sprite present', () => {
    expect(findLevelScrollSpriteFull([fakeSprite(0x10)])).toBeNull()
  })
})

// ── readL2ScrollBounds ───────────────────────────────────────────────────────

describe('readL2ScrollBounds', () => {
  const DATA_05C71B = 0x05c71b
  it('returns null for unmapped scroll cmds (most cmds)', () => {
    expect(readL2ScrollBounds(make4MbRom(), 0x00)).toBeNull()
    expect(readL2ScrollBounds(make4MbRom(), null)).toBeNull()
    expect(readL2ScrollBounds(make4MbRom(), 0x0e)).toBeNull()
  })

  it('returns {min,max} from DATA_05C71B for cmd $0B', () => {
    const rom = make4MbRom()
    rom.writeAt(DATA_05C71B + 0, [0x20]) // target 0
    rom.writeAt(DATA_05C71B + 2, [0xc0]) // target 1
    expect(readL2ScrollBounds(rom, 0x0b)).toEqual({ min: 0x20, max: 0xc0 })
  })

  it('returns null when targets are equal (max not > min)', () => {
    const rom = make4MbRom()
    rom.writeAt(DATA_05C71B + 0, [0x40])
    rom.writeAt(DATA_05C71B + 2, [0x40])
    expect(readL2ScrollBounds(rom, 0x0b)).toBeNull()
  })
})

// ── computeL2ScrollRange ─────────────────────────────────────────────────────

describe('computeL2ScrollRange', () => {
  it('returns kind=none for an empty grid', () => {
    const result = computeL2ScrollRange({
      grid: [],
      initialLayer2YPx: 0,
      initialCameraYPx: 0,
      levelPixelW: 256,
      layer1ScrollCmd: null,
    })
    expect(result.kind).toBe('none')
  })

  it('returns kind=fixed with shifted bounds when grid has data', () => {
    // 3-row grid, only row 1 has a non-null cell.
    const grid: (number | null)[][] = [
      [null, null],
      [42, null],
      [null, null],
    ]
    const result = computeL2ScrollRange({
      grid,
      initialLayer2YPx: 16,
      initialCameraYPx: 0,
      levelPixelW: 256,
      layer1ScrollCmd: 0x0b,
    })
    // dy = 0 - 16 = -16; first/last row both = 1; yMin = 1*16 + dy = 0; yMax = 2*16 + dy = 16.
    expect(result.kind).toBe('fixed')
    expect(result.xMin).toBe(0)
    expect(result.xMax).toBe(256)
    expect(result.yMin).toBe(0)
    expect(result.yMax).toBe(16)
    expect(result.layer1ScrollCmd).toBe(0x0b)
  })
})
