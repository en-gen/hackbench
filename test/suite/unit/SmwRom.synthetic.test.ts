/**
 * SmwRom — synthetic-ROM tests for header validation, level-pointer reads,
 * tileset lookup, exit-graph building, and screen-trigger detection.
 *
 * Most production behavior here is exercised only via the integration test
 * (real ROM), which skips when the ROM file is absent. These tests pin down
 * the boundary cases without requiring the ROM.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  SmwRom,
  ADDR,
  LEVEL_COUNT,
  isOverworldLevel,
  screenHasExitTrigger,
} from '../../../src/rom/SmwRom'
import { TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { SCREEN_W, SCREEN_H } from '../../../src/rom/LevelParser'

function make4MbRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7FD5] = 0x20  // LoROM map mode
  buf.write('SUPER MARIOWORLD     ', 0x7FC0, 'ascii')
  return new RomFile('mock.smc', buf)
}

// ── Constructor / validation ─────────────────────────────────────────────────

describe('new SmwRom — map-mode validation', () => {
  it('accepts $20 (slow LoROM)', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    expect(() => new SmwRom(rom)).not.toThrow()
  })

  it('accepts $30 (fast LoROM)', () => {
    const buf = Buffer.alloc(0x400000)
    buf[0x7FD5] = 0x30
    expect(() => new SmwRom(new RomFile('fast.smc', buf))).not.toThrow()
  })

  it('throws on unknown map-mode byte', () => {
    const buf = Buffer.alloc(0x400000)
    buf[0x7FD5] = 0x21  // HiROM, not LoROM — SmwRom rejects this
    expect(() => new SmwRom(new RomFile('hirom.smc', buf))).toThrow(
      /Unexpected ROM map mode/,
    )
  })
})

// ── isOverworldLevel ─────────────────────────────────────────────────────────

describe('isOverworldLevel', () => {
  it('main map range $000-$024 is overworld', () => {
    expect(isOverworldLevel(0x000)).toBe(true)
    expect(isOverworldLevel(0x024)).toBe(true)
  })

  it('first sub-area $025 is NOT in either overworld range', () => {
    expect(isOverworldLevel(0x025)).toBe(false)
    expect(isOverworldLevel(0x100)).toBe(false)
  })

  it('submap range $101-$13B is overworld', () => {
    expect(isOverworldLevel(0x101)).toBe(true)
    expect(isOverworldLevel(0x13B)).toBe(true)
  })

  it('above $13B is sub-area', () => {
    expect(isOverworldLevel(0x13C)).toBe(false)
    expect(isOverworldLevel(0x1FF)).toBe(false)
  })
})

// ── Pointer reads ────────────────────────────────────────────────────────────

describe('getLevel*Pointer', () => {
  it('decodes interleaved 3-byte L1 entries', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    // Level 7's L1 pointer = $063456 (lo=$56, hi=$34, bank=$06)
    rom.writeAt(ADDR.LEVEL_L1_PTR + 7 * 3, [0x56, 0x34, 0x06])
    const smw = new SmwRom(rom)
    expect(smw.getLevelL1Pointer(7)).toBe(0x063456)
  })

  it('decodes L2 pointer with bank $FF (preset background sentinel)', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    rom.writeAt(ADDR.LEVEL_L2_PTR + 5 * 3, [0x12, 0x34, 0xFF])
    const smw = new SmwRom(rom)
    expect(smw.getLevelL2Pointer(5)).toBe(0xFF3412)
  })

  it('sprite pointer is 2 bytes; bank is implicit $07', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    rom.writeAt(ADDR.LEVEL_SPR_PTR + 3 * 2, [0xAB, 0xCD])
    const smw = new SmwRom(rom)
    expect(smw.getLevelSpritePointer(3)).toBe(0x07CDAB)
  })

  it('returns null when reads fall outside ROM bounds', () => {
    // Build a tiny ROM that still passes _validateOrWarn but where pointer reads fail.
    // We can write the speed-map byte at LoROM $00FFD5 = file offset $7FD5;
    // that means buffer must be ≥ 0x7FD6 bytes.
    const buf = Buffer.alloc(0x8000)
    buf[0x7FD5] = 0x20
    const smw = new SmwRom(new RomFile('mini.smc', buf))
    // LEVEL_L1_PTR file offset = $05E000 ≫ buffer.length → all reads null
    expect(smw.getLevelL1Pointer(0)).toBeNull()
    expect(smw.getLevelL2Pointer(0)).toBeNull()
    expect(smw.getLevelSpritePointer(0)).toBeNull()
  })
})

describe('getAllLevelPointers', () => {
  it('returns LEVEL_COUNT entries, each with the original index', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    const smw = new SmwRom(rom)
    const all = smw.getAllLevelPointers()
    expect(all.length).toBe(LEVEL_COUNT)
    expect(all[0].index).toBe(0)
    expect(all[LEVEL_COUNT - 1].index).toBe(LEVEL_COUNT - 1)
  })
})

// ── getLevelRawData ──────────────────────────────────────────────────────────

describe('getLevelRawData', () => {
  it('returns null when the L1 pointer is 0', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    rom.writeAt(ADDR.LEVEL_L1_PTR + 0 * 3, [0x00, 0x00, 0x00])
    const smw = new SmwRom(rom)
    expect(smw.getLevelRawData(0)).toBeNull()
  })

  it('returns the read buffer when pointer is valid', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    // Point level 0 at SNES $068000 (a valid LoROM region in our 4 MB buffer).
    rom.writeAt(ADDR.LEVEL_L1_PTR, [0x00, 0x80, 0x06])
    rom.writeAt(0x068000, [0x42])
    const smw = new SmwRom(rom)
    const data = smw.getLevelRawData(0)
    expect(data).not.toBeNull()
    expect(data![0]).toBe(0x42)
  })
})

// ── getGfxTilesetId / levelHasObjects ────────────────────────────────────────

describe('getGfxTilesetId', () => {
  it('looks up tileset table using header byte 2 sprite-set nibble', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    // L1 pointer → SNES $068000
    rom.writeAt(ADDR.LEVEL_L1_PTR, [0x00, 0x80, 0x06])
    // 5-byte L1 header: [_, _, sprite-set=$0A, _, _]
    rom.writeAt(0x068000, [0x00, 0x00, 0x0A, 0x00, 0x00])
    // Tileset table entry for spriteSet $0A → $77
    rom.writeAt(ADDR.TILESETID_TABLE + 0x0A, [0x77])
    const smw = new SmwRom(rom)
    expect(smw.getGfxTilesetId(0)).toBe(0x77)
  })

  it('returns 0 when L1 pointer is 0 (no level data)', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    rom.writeAt(ADDR.LEVEL_L1_PTR, [0x00, 0x00, 0x00])
    const smw = new SmwRom(rom)
    expect(smw.getGfxTilesetId(0)).toBe(0)
  })
})

describe('levelHasObjects', () => {
  function setupLevel(rom: RomFile, raw: number[]): SmwRom {
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    rom.writeAt(ADDR.LEVEL_L1_PTR, [0x00, 0x80, 0x06])
    rom.writeAt(0x068000, raw)
    return new SmwRom(rom)
  }

  it('false when level data is too short', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    rom.writeAt(ADDR.LEVEL_L1_PTR, [0x00, 0x00, 0x00])
    expect(new SmwRom(rom).levelHasObjects(0)).toBe(false)
  })

  it('false when level mode > 20 (invalid)', () => {
    const rom = make4MbRom()
    // Level mode = 31 (raw[1] & 0x1F)
    const smw = setupLevel(rom, [0x00, 0x1F, 0x00, 0x00, 0x00, 0x00])
    expect(smw.levelHasObjects(0)).toBe(false)
  })

  it('false when first object byte is the immediate $FF terminator', () => {
    const rom = make4MbRom()
    const smw = setupLevel(rom, [0x00, 0x00, 0x00, 0x00, 0x00, 0xFF])
    expect(smw.levelHasObjects(0)).toBe(false)
  })

  it('true when valid mode + at least one non-terminator object byte', () => {
    const rom = make4MbRom()
    const smw = setupLevel(rom, [0x00, 0x00, 0x00, 0x00, 0x00, 0x42, 0xFF])
    expect(smw.levelHasObjects(0)).toBe(true)
  })
})

// ── screenHasExitTrigger ─────────────────────────────────────────────────────

describe('screenHasExitTrigger', () => {
  function emptyHorizontalGrid(): number[][] {
    // Wide enough for at least 2 screens.
    return Array.from({ length: SCREEN_H }, () =>
      new Array(SCREEN_W * 2).fill(0x100),  // arbitrary non-trigger filler tile
    )
  }

  it('open bottom row signals a pit (trigger)', () => {
    const grid = emptyHorizontalGrid()
    grid[SCREEN_H - 1][3] = TILE_EMPTY
    expect(screenHasExitTrigger(grid, 0, false)).toBe(true)
  })

  it('pipe body tile $0A counts as a trigger', () => {
    const grid = emptyHorizontalGrid()
    // Seal the bottom row so the pit-detector doesn't fire.
    for (let c = 0; c < SCREEN_W; c++) grid[SCREEN_H - 1][c] = 0x100
    grid[5][7] = 0x0A
    expect(screenHasExitTrigger(grid, 0, false)).toBe(true)
  })

  it('page-1 pipe range $180-$1FF triggers', () => {
    const grid = emptyHorizontalGrid()
    for (let c = 0; c < SCREEN_W; c++) grid[SCREEN_H - 1][c] = 0x100
    grid[5][7] = 0x180
    expect(screenHasExitTrigger(grid, 0, false)).toBe(true)
    grid[5][7] = 0x1FF
    expect(screenHasExitTrigger(grid, 0, false)).toBe(true)
  })

  it('door tile $7C triggers', () => {
    const grid = emptyHorizontalGrid()
    for (let c = 0; c < SCREEN_W; c++) grid[SCREEN_H - 1][c] = 0x100
    grid[3][2] = 0x7C
    expect(screenHasExitTrigger(grid, 0, false)).toBe(true)
  })

  it('returns false when screen has none of pipe/door/pit', () => {
    const grid = emptyHorizontalGrid()
    for (let c = 0; c < SCREEN_W; c++) grid[SCREEN_H - 1][c] = 0x100
    expect(screenHasExitTrigger(grid, 0, false)).toBe(false)
  })

  it('honors screenIndex offset: trigger on screen 1 not seen by screen 0 query', () => {
    const grid = emptyHorizontalGrid()
    for (let c = 0; c < SCREEN_W * 2; c++) grid[SCREEN_H - 1][c] = 0x100
    grid[3][SCREEN_W + 5] = 0x0A  // screen 1 has the pipe
    expect(screenHasExitTrigger(grid, 0, false)).toBe(false)
    expect(screenHasExitTrigger(grid, 1, false)).toBe(true)
  })
})
