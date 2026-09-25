/**
 * SmwRom - synthetic-ROM tests for header validation, level-pointer reads,
 * tileset lookup, and exit-graph building.
 *
 * Most production behavior here is exercised only via the integration test
 * (real ROM), which skips when the ROM file is absent. These tests pin down
 * the boundary cases without requiring the ROM.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR, LEVEL_COUNT, isOverworldLevel } from '../../../src/rom/SmwRom'

// CODE_05D8B7's sprite-pointer read (bank_05.asm:7248-7258), written from the
// 65816 encoding at an arbitrary address with a relocated table and a
// non-vanilla bank (not $05EC00/$07): this proves the pattern match, not a
// coincidence with the real ROM. findPattern locates the lead-in by shape.
const SPRITE_SITE_AT = 0x05d000
const SPRITE_TABLE_ADDR = 0x9100
const SPRITE_BANK = 0x09
const b16 = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff]
const b24 = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff]

function plantSpritePointerSite(rom: RomFile): void {
  rom.writeAt(SPRITE_SITE_AT - 9, [0xa5, 0x0e, 0x0a, 0xa8]) // index (vanilla)
  rom.writeAt(SPRITE_SITE_AT - 5, [0xa9, 0x00, 0x00, 0xe2, 0x20]) // mid (vanilla)
  rom.writeAt(SPRITE_SITE_AT, [
    0xb9,
    ...b16(SPRITE_TABLE_ADDR),
    0x85,
    0xce,
    0xb9,
    ...b16(SPRITE_TABLE_ADDR + 1),
    0x85,
    0xcf,
  ])
  rom.writeAt(SPRITE_SITE_AT + 10, [0xa9, SPRITE_BANK, 0x85, 0xd0]) // tail: fixed bank
}

// The recognized per-level sprite-bank routine (bank_05.asm:7257 hook):
// PHB/PHK/PLB, LDY LevelNumber, LDA <table>,Y, STA SpriteDataPtr+2, PLB, RTL.
function bankRoutineBytes(tableOperand: number): number[] {
  return [0x8b, 0x4b, 0xab, 0xa4, 0x0e, 0xb9, ...b16(tableOperand), 0x85, 0xd0, 0xab, 0x6b]
}

/** Plants a full sprite-pointer read whose tail JSLs to a per-level bank
 *  routine at `routineAt`, naming `tableOperand` (NOT the stock $F100). */
function plantPerLevelBankSite(rom: RomFile, routineAt: number, tableOperand: number): void {
  rom.writeAt(SPRITE_SITE_AT - 9, [0xa5, 0x0e, 0x0a, 0xa8])
  rom.writeAt(SPRITE_SITE_AT - 5, [0xa9, 0x00, 0x00, 0xe2, 0x20])
  rom.writeAt(SPRITE_SITE_AT, [
    0xb9,
    ...b16(SPRITE_TABLE_ADDR),
    0x85,
    0xce,
    0xb9,
    ...b16(SPRITE_TABLE_ADDR + 1),
    0x85,
    0xcf,
  ])
  rom.writeAt(SPRITE_SITE_AT + 10, [0x22, ...b24(routineAt)])
  rom.writeAt(routineAt, bankRoutineBytes(tableOperand))
}

function make4MbRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode
  buf.write('SUPER MARIOWORLD     ', 0x7fc0, 'ascii')
  return new RomFile('mock.smc', buf)
}

// ── Constructor / validation ─────────────────────────────────────────────────

describe('new SmwRom - map-mode validation', () => {
  it('accepts $20 (slow LoROM)', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    expect(() => new SmwRom(rom)).not.toThrow()
  })

  it('accepts $30 (fast LoROM)', () => {
    const buf = Buffer.alloc(0x400000)
    buf[0x7fd5] = 0x30
    expect(() => new SmwRom(new RomFile('fast.smc', buf))).not.toThrow()
  })

  it('throws on unknown map-mode byte', () => {
    const buf = Buffer.alloc(0x400000)
    buf[0x7fd5] = 0x21 // HiROM, not LoROM - SmwRom rejects this
    expect(() => new SmwRom(new RomFile('hirom.smc', buf))).toThrow(/Unexpected ROM map mode/)
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
    expect(isOverworldLevel(0x13b)).toBe(true)
  })

  it('above $13B is sub-area', () => {
    expect(isOverworldLevel(0x13c)).toBe(false)
    expect(isOverworldLevel(0x1ff)).toBe(false)
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
    rom.writeAt(ADDR.LEVEL_L2_PTR + 5 * 3, [0x12, 0x34, 0xff])
    const smw = new SmwRom(rom)
    expect(smw.getLevelL2Pointer(5)).toBe(0xff3412)
  })

  it('sprite pointer table and bank are read from CODE_05D8B7 own operands', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    plantSpritePointerSite(rom)
    rom.writeAt((0x05 << 16) | (SPRITE_TABLE_ADDR + 3 * 2), [0xab, 0xcd])
    const smw = new SmwRom(rom)
    expect(smw.getLevelSpritePointer(3)).toBe((SPRITE_BANK << 16) | 0xcdab)
  })

  // Distinct banks at consecutive levels: reading at index*2 instead of
  // index (level 1 would see table[2]) or ignoring the table for a
  // hardcoded $07 both stay green against a single repeated bank; only
  // DIFFERENT banks per level expose either mutation.
  it('reads a distinct per-level bank for each of several levels', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    const routineAt = 0x0ef300
    const tableOperand = 0xf100
    plantPerLevelBankSite(rom, routineAt, tableOperand)
    const bankTableAddr = (routineAt & 0xff0000) | tableOperand
    rom.writeAt(bankTableAddr, [0x09, 0x0a, 0x0b, 0x0c])
    rom.writeAt((0x05 << 16) | (SPRITE_TABLE_ADDR + 0 * 2), [0x00, 0x80])
    rom.writeAt((0x05 << 16) | (SPRITE_TABLE_ADDR + 1 * 2), [0x00, 0x81])
    rom.writeAt((0x05 << 16) | (SPRITE_TABLE_ADDR + 2 * 2), [0x00, 0x82])
    rom.writeAt((0x05 << 16) | (SPRITE_TABLE_ADDR + 3 * 2), [0x00, 0x83])
    const smw = new SmwRom(rom)
    expect(smw.getLevelSpritePointer(0)).toBe(0x098000)
    expect(smw.getLevelSpritePointer(1)).toBe(0x0a8100)
    expect(smw.getLevelSpritePointer(2)).toBe(0x0b8200)
    expect(smw.getLevelSpritePointer(3)).toBe(0x0c8300)
  })

  // The routine and its table operand are both NOT at their stock addresses
  // ($0EF300 / $F100): only reading them dynamically, rather than assuming
  // either, resolves this correctly.
  it('reads the per-level bank table from a relocated routine and operand', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    const routineAt = 0x0ca100
    const tableOperand = 0x9200
    plantPerLevelBankSite(rom, routineAt, tableOperand)
    const bankTableAddr = (routineAt & 0xff0000) | tableOperand
    rom.writeAt(bankTableAddr + 5, [0x11])
    rom.writeAt((0x05 << 16) | (SPRITE_TABLE_ADDR + 5 * 2), [0x34, 0x12])
    const smw = new SmwRom(rom)
    expect(smw.getLevelSpritePointer(5)).toBe(0x111234)
  })

  it('sprite pointer is null when the read is not present on this ROM', () => {
    const rom = make4MbRom()
    rom.writeAt(ADDR.ROM_SPEED_MAP, [0x20])
    const smw = new SmwRom(rom)
    expect(smw.getLevelSpritePointer(3)).toBeNull()
  })

  it('returns null when reads fall outside ROM bounds', () => {
    // Build a tiny ROM that still passes _validateOrWarn but where pointer reads fail.
    // We can write the speed-map byte at LoROM $00FFD5 = file offset $7FD5;
    // that means buffer must be ≥ 0x7FD6 bytes.
    const buf = Buffer.alloc(0x8000)
    buf[0x7fd5] = 0x20
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
    rom.writeAt(0x068000, [0x00, 0x00, 0x0a, 0x00, 0x00])
    // Tileset table entry for spriteSet $0A → $77
    rom.writeAt(ADDR.TILESETID_TABLE + 0x0a, [0x77])
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
    const smw = setupLevel(rom, [0x00, 0x1f, 0x00, 0x00, 0x00, 0x00])
    expect(smw.levelHasObjects(0)).toBe(false)
  })

  it('false when first object byte is the immediate $FF terminator', () => {
    const rom = make4MbRom()
    const smw = setupLevel(rom, [0x00, 0x00, 0x00, 0x00, 0x00, 0xff])
    expect(smw.levelHasObjects(0)).toBe(false)
  })

  it('true when valid mode + at least one non-terminator object byte', () => {
    const rom = make4MbRom()
    const smw = setupLevel(rom, [0x00, 0x00, 0x00, 0x00, 0x00, 0x42, 0xff])
    expect(smw.levelHasObjects(0)).toBe(true)
  })
})
