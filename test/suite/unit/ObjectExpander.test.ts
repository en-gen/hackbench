import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { expandMap, expandObject, createGrid, readLayer3Setting, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { LevelObject, SCREEN_W, parseLevelObjects } from '../../../src/rom/LevelParser'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  DATA_0DA548_LEN,
  ADDR_EXTENDED_DISPATCH,
  ADDR_TILESET_DISPATCH,
  ADDR_TILESET0_HANDLERS,
  readByteTable, readLongPointer, readLongPointerTable,
} from '../../../src/rom/objectHandlers/romData'
import {
  makeCursor, writeTile, writeTileAdvance, nextRow,
  saveBookmark, restoreBookmark, advanceCol,
  TileGrid,
} from '../../../src/rom/objectHandlers/cursor'
import {
  handle_0DA8C3, handle_0DAA26, handle_0DAAB4, handle_0DAB0D, handle_0DAB3E,
  handle_0DB075, handle_0DB1C8, handle_0DB1D4, handle_0DB224,
  handle_0DB3BD, handle_0DB3E3,
  handle_0DB42D, handle_0DB461, handle_0DB49E, handle_0DB51F, handle_0DB547, handle_0DB571, handle_0DB5B7,
  handle_0DB73F, handle_0DB7AA,
  handle_0DB863,
  handle_0DB916, handle_0DB91E,
  handle_0DB604, handle_0DBB2C, handle_0DBB63,
  handle_0DDCEA, handle_0DDD2E, handle_0DE135,
  handle_0DED12,
  handle_0DEDB9,
  handle_0DDAF2,
} from '../../../src/rom/objectHandlers/standardHandlers'
import {
  handle_0DA57B, handle_0DA64D, handle_0DA656, handle_0DA673, handle_0DA68E, handle_0DA6D1,
  handle_0DB2CA,
  handle_0DB583, handle_0DB58B,
  handle_0DC259,
} from '../../../src/rom/objectHandlers/extendedHandlers'
import { RomFile } from '../../../src/rom/RomFile'

/** Page-1 tile IDs are stored as 0x100 | lowByte -- see cursor.ts for why. */
const P1 = (b: number) => 0x100 | b

// ── Mock ROM for unit tests ───────────────────────────────────────────────────
// We don't need a real SMW ROM to exercise the handlers; we need a RomFile whose
// reads at the relevant SNES addresses return chosen bytes. Build a minimal
// in-memory RomFile for that.

/** Build a 4 MB LoROM buffer with a valid map mode byte, allowing arbitrary patches. */
function makeMockRom(patches: Record<number, number[]> = {}): RomFile {
  // 4 MB is enough to cover bank $0D (file offset $68000..$6FFFF) with headroom.
  const buf = Buffer.alloc(0x400000, 0x00)
  // Set the LoROM map mode byte at file offset $7FD5 so RomFile picks LoROM mapping.
  buf[0x7FD5] = 0x20
  const rom = new RomFile('mock.smc', buf)
  // Apply patches by SNES LoROM address.
  for (const [snesAddrStr, bytes] of Object.entries(patches)) {
    const snesAddr = Number(snesAddrStr)
    rom.writeAt(snesAddr, bytes)
  }
  return rom
}

/**
 * Stamp a 3-byte long-operand at handlerAddr + offsetInHandler pointing to
 * targetAddr. Used to simulate an `LDA.L $targetAddr,X` instruction inside a
 * handler's body for tests that exercise handlers after the
 * "ROM-derived data tables" refactor.
 */
function stampLongOperand(rom: RomFile, handlerAddr: number, offsetInHandler: number, targetAddr: number): void {
  rom.writeAt(handlerAddr + offsetInHandler, [
    targetAddr & 0xFF,
    (targetAddr >> 8) & 0xFF,
    (targetAddr >> 16) & 0xFF,
  ])
}

/** Create a cursor with its handlerAddr pre-populated (as the dispatcher would). */
function makeCursorForHandler(
  handlerAddr: number,
  grid: TileGrid, rom: RomFile, tileset: number,
  col: number, row: number, objNo: number, size: number,
): ReturnType<typeof makeCursor> {
  const cur = makeCursor(grid, rom, tileset, col, row, objNo, size)
  cur.handlerAddr = handlerAddr
  return cur
}

/** Convenience: build a LevelObject suitable for expandObject. */
function makeObj(
  type: 'standard' | 'extended',
  objectNumber: number,
  settings: number,
  x = 0, y = 14, screen = 0,
): LevelObject {
  return {
    type,
    screen,
    x, y,
    objectNumber,
    settings,
    newScreen: screen > 0,
    highCoord: false,
    raw: [0, 0, settings],
    objectType: type === 'extended' ? 0x100 + objectNumber : objectNumber,
    param: settings,
  }
}

// ── Grid helpers ──────────────────────────────────────────────────────────────

describe('createGrid', () => {
  it('fills with TILE_EMPTY ($25)', () => {
    const grid = createGrid(1)
    expect(grid.length).toBe(27)
    expect(grid[0].length).toBe(SCREEN_W)
    expect(grid[0][0]).toBe(TILE_EMPTY)
    expect(grid[26][15]).toBe(TILE_EMPTY)
  })

  it('widens with screens', () => {
    const grid = createGrid(3)
    expect(grid[0].length).toBe(3 * SCREEN_W)
  })

  // ── Overflow screen tests (layer3Setting != 0) ──────────────────────────────
  //
  // When layer3Setting is non-zero, createGrid appends 2 extra screens beyond the
  // defined level.  CODE_00A045 (bank_00.asm) zeroes OWLayer1VramBuffer in batches:
  // $B0 bytes zeroed, then $100 bytes skipped, repeating every $1B0 bytes.
  //
  // For a level with `screens` screens, the row-major WRAM layout starts the first
  // overflow screen at offset `screens * $1B0`.  OWLayer1VramBuffer starts at $1C00.
  // A cell at (screen, row) is zeroed iff:
  //   owlBufOff = screen * $1B0 + row * $10 - $1C00 >= 0 AND
  //   (owlBufOff % $1B0) < $B0

  it('no overflow appended when layer3Setting=0', () => {
    const grid = createGrid(16, false, 0)
    // 16 screens × 16 cols = 256 cols; no overflow
    expect(grid[0].length).toBe(256)
  })

  it('appends 2 overflow screens when layer3Setting != 0', () => {
    const grid = createGrid(16, false, 1)
    // 16 defined + 2 overflow = 18 screens × 16 = 288 cols
    expect(grid[0].length).toBe(288)
  })

  it('overflow screen 16 rows 0-15 are TILE_EMPTY (before OWLayer1VramBuffer)', () => {
    // Screen 16, rows 0-15: wramOffset = 16 * 0x1B0 + row * 0x10 = 0x1B00 + row * 0x10
    // For row 15: 0x1B00 + 0xF0 = 0x1BF0 < 0x1C00 → NOT in OWLayer1VramBuffer → $025
    const grid = createGrid(16, false, 1)
    for (let r = 0; r <= 15; r++) {
      // Screen 16 cols 256-271
      for (let c = 256; c < 272; c++) {
        expect(grid[r][c]).toBe(TILE_EMPTY)
      }
    }
  })

  it('overflow screen 16 rows 16-26 are $000 (zeroed by CODE_00A045)', () => {
    // Screen 16, row 16: wramOffset = 16 * 0x1B0 + 16 * 0x10 = 0x1C00
    // owlBufOff = 0; 0 % 0x1B0 = 0 < 0xB0 → ZEROED
    const grid = createGrid(16, false, 1)
    for (let r = 16; r <= 26; r++) {
      for (let c = 256; c < 272; c++) {
        expect(grid[r][c]).toBe(0x00)
      }
    }
  })

  it('overflow screen 17 rows 0-15 are TILE_EMPTY (in CODE_00A045 skip gap)', () => {
    // Screen 17, row 0: wramOffset = 17 * 0x1B0 = 0x1CB0
    // owlBufOff = 0x1CB0 - 0x1C00 = 0xB0; 0xB0 % 0x1B0 = 0xB0, NOT < 0xB0 → $025
    // Screen 17, row 15: owlBufOff = 0xB0 + 15*0x10 = 0x1A0; 0x1A0 % 0x1B0 = 0x1A0 >= 0xB0 → $025
    const grid = createGrid(16, false, 1)
    for (let r = 0; r <= 15; r++) {
      for (let c = 272; c < 288; c++) {
        expect(grid[r][c]).toBe(TILE_EMPTY)
      }
    }
  })

  it('overflow screen 17 rows 16-26 are $000 (in CODE_00A045 batch 1)', () => {
    // Screen 17, row 16: owlBufOff = 0xB0 + 16*0x10 = 0x1B0; 0x1B0 % 0x1B0 = 0 < 0xB0 → ZEROED
    const grid = createGrid(16, false, 1)
    for (let r = 16; r <= 26; r++) {
      for (let c = 272; c < 288; c++) {
        expect(grid[r][c]).toBe(0x00)
      }
    }
  })

  it('vertical levels never append overflow screens', () => {
    const grid = createGrid(8, true, 2)
    // 8 screens × 16 rows = 128 rows, 32 cols — no horizontal overflow
    expect(grid.length).toBe(128)
    expect(grid[0].length).toBe(32)
  })
})

// ── Cursor primitives ─────────────────────────────────────────────────────────

describe('Cursor', () => {
  const rom = makeMockRom()

  it('writeTile stamps tile at (row, col) without advancing', () => {
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 5, 10, 1, 0)
    writeTile(cur, 0x42)
    expect(grid[10][5]).toBe(0x42)
    expect(cur.col).toBe(5)  // no advance
  })

  it('writeTileAdvance writes then advances column', () => {
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 3, 10, 1, 0)
    writeTileAdvance(cur, 0xAA)
    writeTileAdvance(cur, 0xBB)
    expect(grid[10][3]).toBe(0xAA)
    expect(grid[10][4]).toBe(0xBB)
    expect(cur.col).toBe(5)
  })

  it('nextRow advances row and resets col to bookmark', () => {
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 2, 10, 1, 0)
    saveBookmark(cur)
    writeTileAdvance(cur, 0x11)
    writeTileAdvance(cur, 0x12)
    nextRow(cur)
    writeTileAdvance(cur, 0x21)
    expect(grid[10][2]).toBe(0x11)
    expect(grid[10][3]).toBe(0x12)
    expect(grid[11][2]).toBe(0x21)
    expect(cur.row).toBe(11)
    expect(cur.col).toBe(3)
  })

  it('writes are clipped to grid bounds (silent)', () => {
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, -1, -1, 1, 0)
    writeTileAdvance(cur, 0x99)
    // Cursor state still updates; grid is untouched at negative index.
    expect(grid[0][0]).toBe(TILE_EMPTY)
  })

  it('restoreBookmark resets col without touching row', () => {
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 4, 10, 1, 0)
    saveBookmark(cur)
    advanceCol(cur)
    advanceCol(cur)
    restoreBookmark(cur)
    expect(cur.col).toBe(4)
    expect(cur.row).toBe(10)
  })
})

// ── ROM data readers ──────────────────────────────────────────────────────────

describe('romData readers', () => {
  it('readByteTable returns patched bytes', () => {
    const rom = makeMockRom({ [0x0DA8B4]: [0x02, 0x21, 0x23, 0x2A, 0x2B, 0x3F, 0x03] })
    const out = readByteTable(rom, 0x0DA8B4, 7)
    expect(out).toEqual([0x02, 0x21, 0x23, 0x2A, 0x2B, 0x3F, 0x03])
  })

  it('readLongPointer decodes 24-bit LE', () => {
    const rom = makeMockRom({ [0x0DA10F]: [0x12, 0xA5, 0x0D] })
    expect(readLongPointer(rom, 0x0DA10F)).toBe(0x0DA512)
  })

  it('readLongPointerTable handles a full dispatch table', () => {
    const rom = makeMockRom({
      [0x0DA10F]: [
        0x12, 0xA5, 0x0D,   // entry 0 -> 0x0DA512
        0x00, 0x00, 0x00,   // entry 1 -> 0x000000 (null)
        0x7B, 0xA5, 0x0D,   // entry 2 -> 0x0DA57B
      ],
    })
    const ptrs = readLongPointerTable(rom, 0x0DA10F, 3)
    expect(ptrs).toEqual([0x0DA512, 0x000000, 0x0DA57B])
  })
})

// ── CODE_0DA8C3 (objects 1-14 rectangular terrain) ────────────────────────────

describe('handle_0DA8C3 (rectangular terrain)', () => {
  // Set up DATA_0DA8B4 so index 0 (obj 1) = $02, index 5 (obj 6) = $3F.
  // After the "ROM-derived data tables" refactor, the handler reads DATA_0DA8B4's
  // address from an LDA.L operand at handler offset +108. We stamp both the
  // data table bytes and a synthetic LDA.L operand pointing at them.
  const HANDLER_ADDR = 0x0DA8C3
  const LDA_L_OPERAND_OFFSET = 108
  const TARGET_TABLE_ADDR = 0x0DA8B4

  function romWithStdTable(): RomFile {
    const rom = makeMockRom({
      [TARGET_TABLE_ADDR]: [0x02, 0x21, 0x23, 0x2A, 0x2B, 0x3F, 0x03, 0x13, 0x1E, 0x24, 0x2E, 0x2F, 0x30, 0x32, 0x65],
    })
    stampLongOperand(rom, HANDLER_ADDR, LDA_L_OPERAND_OFFSET, TARGET_TABLE_ADDR)
    return rom
  }

  it('1×1 fill uses DATA_0DA8B4[objNo-1]', () => {
    const grid = createGrid(1)
    const rom = romWithStdTable()
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 2, 20, 1, 0x00)
    handle_0DA8C3(cur)
    expect(grid[20][2]).toBe(0x02)
    expect(grid[20][3]).toBe(TILE_EMPTY)
  })

  it('4×3 fill writes correct rectangle', () => {
    const grid = createGrid(2)
    const rom = romWithStdTable()
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 0, 10, 1, 0x23)
    handle_0DA8C3(cur)
    for (let r = 10; r <= 12; r++) {
      for (let c = 0; c <= 3; c++) {
        expect(grid[r][c]).toBe(0x02)
      }
      expect(grid[r][4]).toBe(TILE_EMPTY)
    }
    expect(grid[9][0]).toBe(TILE_EMPTY)
  })

  it('uses a different tile ID per object number', () => {
    const grid = createGrid(1)
    const rom = romWithStdTable()
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 5, 20, 6, 0x00)
    handle_0DA8C3(cur)
    expect(grid[20][5]).toBe(0x3F)
  })

  it('fills across a screen boundary', () => {
    const grid = createGrid(2)
    const rom = romWithStdTable()
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 14, 5, 1, 0x03)
    handle_0DA8C3(cur)
    expect(grid[5][14]).toBe(0x02)
    expect(grid[5][15]).toBe(0x02)
    expect(grid[5][16]).toBe(0x02)
    expect(grid[5][17]).toBe(0x02)
    expect(grid[5][18]).toBe(TILE_EMPTY)
  })

  it('handles objNo outside the table without throwing', () => {
    const grid = createGrid(1)
    const rom = romWithStdTable()
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 0, 10, 20, 0x00)
    expect(() => handle_0DA8C3(cur)).not.toThrow()
    expect(grid[10][0]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DA57B (extended single-tile) ────────────────────────────────────────

describe('handle_0DA57B (extended single-tile)', () => {
  const HANDLER_ADDR = 0x0DA57B
  const TABLE_ADDR = 0x0DA548
  function romWithExtTable(): RomFile {
    const table = Array.from({ length: DATA_0DA548_LEN }, (_, i) => 0x10 + i)
    const rom = makeMockRom({ [TABLE_ADDR]: table })
    // LDA.L DATA_0DA548,X operand at HANDLER_ADDR + 69 (inside CODE_0DA5B1)
    stampLongOperand(rom, HANDLER_ADDR, 69, TABLE_ADDR)
    return rom
  }

  it('ext type 0x10 writes DATA_0DA548[0]', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, romWithExtTable(), 0, 3, 10, 0x10, 0)
    handle_0DA57B(cur)
    expect(grid[10][3]).toBe(0x10)
  })

  it('ext type 0x25 indexes into table correctly (page 1 for idx >= 0x13)', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, romWithExtTable(), 0, 5, 10, 0x25, 0)
    handle_0DA57B(cur)
    expect(grid[10][5]).toBe(P1(0x10 + 0x15))
  })

  it('ext type below 0x10 is a no-op (not a single-tile slot)', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, romWithExtTable(), 0, 3, 10, 0x0F, 0)
    handle_0DA57B(cur)
    expect(grid[10][3]).toBe(TILE_EMPTY)
  })

  it('ext type above table length is a no-op', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, romWithExtTable(), 0, 3, 10, 0x10 + DATA_0DA548_LEN, 0)
    handle_0DA57B(cur)
    expect(grid[10][3]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DAB0D (vertical rope/pole, object 17) ───────────────────────────────

describe('handle_0DAB0D (vertical 3-segment — page 1)', () => {
  const HANDLER_ADDR = 0x0DAB0D
  function setupRom(): RomFile {
    const rom = makeMockRom()
    rom.writeAt(HANDLER_ADDR + 13, [0x41])
    rom.writeAt(HANDLER_ADDR + 26, [0x42])
    rom.writeAt(HANDLER_ADDR + 39, [0x43])
    return rom
  }

  it('height 0 writes just the top tile ($41)', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, setupRom(), 0, 5, 10, 17, 0x00)
    handle_0DAB0D(cur)
    expect(grid[10][5]).toBe(P1(0x41))
    expect(grid[11][5]).toBe(TILE_EMPTY)
  })

  it('height 1 writes top ($41) + middle ($42)', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, setupRom(), 0, 5, 10, 17, 0x10)
    handle_0DAB0D(cur)
    expect(grid[10][5]).toBe(P1(0x41))
    expect(grid[11][5]).toBe(P1(0x42))
    expect(grid[12][5]).toBe(TILE_EMPTY)
  })

  it('height 4 writes $41 + $42 + $43×3', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, setupRom(), 0, 5, 10, 17, 0x40)
    handle_0DAB0D(cur)
    expect(grid[10][5]).toBe(P1(0x41))
    expect(grid[11][5]).toBe(P1(0x42))
    expect(grid[12][5]).toBe(P1(0x43))
    expect(grid[13][5]).toBe(P1(0x43))
    expect(grid[14][5]).toBe(P1(0x43))
    expect(grid[15][5]).toBe(TILE_EMPTY)
  })
})

// ── expandMap integration via the dispatch chain ────────────────────────────

describe('expandMap (integration)', () => {
  it('empty object list produces all-empty grid', () => {
    const rom = makeMockRom()
    const grid = expandMap([], 1, rom, 0)
    expect(grid[0][0]).toBe(TILE_EMPTY)
    expect(grid[26][15]).toBe(TILE_EMPTY)
  })

  it('dispatches standard object through ROM pointer tables', () => {
    // Wire the minimal ROM infrastructure:
    //   tileset dispatch (entry 0) -> CODE_0DA44B (0x0DA44B)
    //   tileset-0 handler table (entry 0, for objNo=1) -> CODE_0DA8C3 (0x0DA8C3)
    //   handle_0DA8C3's LDA.L operand at +108 -> DATA_0DA8B4 (0x0DA8B4)
    //   DATA_0DA8B4[0] = 0x02 (tile ID for obj 1)
    const rom = makeMockRom({
      [ADDR_TILESET_DISPATCH]: [0x4B, 0xA4, 0x0D],       // tileset 0 → 0x0DA44B
      [ADDR_TILESET0_HANDLERS]: [0xC3, 0xA8, 0x0D],       // obj 1 → 0x0DA8C3
      [0x0DA8B4]: [0x02],
    })
    stampLongOperand(rom, 0x0DA8C3, 108, 0x0DA8B4)
    const obj = makeObj('standard', 1, 0x00, /*x*/5, /*y*/20)
    const grid = expandMap([obj], 1, rom, 0)
    expect(grid[20][5]).toBe(0x02)
  })

  it('dispatches extended object through ROM pointer tables', () => {
    // Extended-dispatch entry for type 0x10 → CODE_0DA57B (0x0DA57B).
    // handle_0DA57B reads DATA_0DA548 address from LDA.L operand at +69.
    const rom = makeMockRom({
      [ADDR_EXTENDED_DISPATCH + 0x10 * 3]: [0x7B, 0xA5, 0x0D],
      [0x0DA548]: [0x1F],
    })
    stampLongOperand(rom, 0x0DA57B, 69, 0x0DA548)
    const obj = makeObj('extended', 0x10, 0, /*x*/7, /*y*/20)
    const grid = expandMap([obj], 1, rom, 0)
    expect(grid[20][7]).toBe(0x1F)
  })

  it('unmapped handler pointer yields no tile writes', () => {
    // Tileset dispatch points at CODE_0DA44B, but object handler points at an
    // unported address. Nothing should happen.
    const rom = makeMockRom({
      [ADDR_TILESET_DISPATCH]: [0x4B, 0xA4, 0x0D],
      [ADDR_TILESET0_HANDLERS]: [0xFF, 0xFF, 0x0D],       // 0x0DFFFF (not ported)
    })
    const obj = makeObj('standard', 1, 0x00, 5, 20)
    const grid = expandMap([obj], 1, rom, 0)
    expect(grid[20][5]).toBe(TILE_EMPTY)
  })

  it('unmapped tileset dispatch (non-CODE_0DA44B) yields no tile writes', () => {
    // Tileset 1 → CODE_0DC190 (not ported yet).
    const rom = makeMockRom({
      [ADDR_TILESET_DISPATCH + 3]: [0x90, 0xC1, 0x0D],
    })
    const obj = makeObj('standard', 1, 0x00, 5, 20)
    const grid = expandMap([obj], 1, rom, 1)
    expect(grid[20][5]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DAA26 + CODE_0DAAB4 regression/smoke tests ──────────────────────────

describe('handle_0DAA26 (horizontal ledge, object 15)', () => {
  const HANDLER_ADDR = 0x0DAA26

  it('runs without throwing for a small ledge', () => {
    const rom = makeMockRom({
      [0x0DAA12]: [0x33, 0x37, 0x39, 0x00, 0x00],
      [0x0DAA17]: [0x34, 0x38, 0x3A, 0x00, 0x00],
      [0x0DAA1C]: [0x00, 0x00, 0x39, 0x33, 0x37],
      [0x0DAA21]: [0x00, 0x00, 0x3A, 0x34, 0x38],
    })
    // LDA.L operands at handler offsets +26, +36, +110, +120
    stampLongOperand(rom, HANDLER_ADDR, 26, 0x0DAA12)
    stampLongOperand(rom, HANDLER_ADDR, 36, 0x0DAA17)
    stampLongOperand(rom, HANDLER_ADDR, 110, 0x0DAA1C)
    stampLongOperand(rom, HANDLER_ADDR, 120, 0x0DAA21)
    const grid = createGrid(2)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 2, 20, 15, 0x20)
    expect(() => handle_0DAA26(cur)).not.toThrow()
    expect(grid[20][2]).toBe(P1(0x33))
  })
})

describe('handle_0DAAB4 (used-block run, object 16)', () => {
  const HANDLER_ADDR = 0x0DAAB4

  it('writes a horizontal run without throwing', () => {
    const rom = makeMockRom({
      [0x0DAAA4]: [0x3B, 0x3C, 0x3B, 0x3F, 0x3B, 0x3C, 0x3B, 0x3F],
      [0x0DAAAC]: [0x3D, 0x3E, 0x3D, 0x3E, 0x3D, 0x3E, 0x3D, 0x3E],
    })
    stampLongOperand(rom, HANDLER_ADDR, 29, 0x0DAAA4)
    stampLongOperand(rom, HANDLER_ADDR, 42, 0x0DAAAC)
    const grid = createGrid(2)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 0, 20, 16, 0x03)
    expect(() => handle_0DAAB4(cur)).not.toThrow()
    expect(grid[20][0]).toBe(P1(0x3B))
  })
})

// ── CODE_0DB1D4 (object 20: water-like rectangle) ─────────────────────────────

describe('handle_0DB1D4 (grass+dirt rectangle, object 20)', () => {
  const HANDLER_ADDR = 0x0DB1D4
  // The shared CODE_0DB1E3 body lives at HANDLER_ADDR + 15. Within that body,
  // LDA #$00 immediate (grass tile) is at bodyAddr + 9; LDA #$3F (dirt) at +25.
  function setupRom(): RomFile {
    const rom = makeMockRom()
    rom.writeAt(HANDLER_ADDR + 15 + 9,  [0x00])
    rom.writeAt(HANDLER_ADDR + 15 + 25, [0x3F])
    return rom
  }

  it('top row writes $100 (page-1 grass), remaining rows write $03F (dirt)', () => {
    const rom = setupRom()
    const grid = createGrid(2)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 1, 10, 20, 0x23)
    handle_0DB1D4(cur)
    for (let c = 1; c <= 4; c++) expect(grid[10][c]).toBe(P1(0x00))
    for (let r = 11; r <= 12; r++) {
      for (let c = 1; c <= 4; c++) expect(grid[r][c]).toBe(0x3F)
    }
    expect(grid[13][1]).toBe(TILE_EMPTY)
  })

  it('1×1 size writes just the top tile (page 1)', () => {
    const rom = setupRom()
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 3, 5, 20, 0x00)
    handle_0DB1D4(cur)
    expect(grid[5][3]).toBe(P1(0x00))
    expect(grid[6][3]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DB3BD (object 23: horizontal run from DATA_0DB3BB) ──────────────────

describe('handle_0DB3BD (coin cloud, object 23)', () => {
  const HANDLER_ADDR = 0x0DB3BD
  const TABLE_ADDR = 0x0DB3BB

  it('stamps (width+1) copies of DATA_0DB3BB[H]', () => {
    const rom = makeMockRom({ [TABLE_ADDR]: [0x05, 0x06] })
    stampLongOperand(rom, HANDLER_ADDR, 19, TABLE_ADDR)  // LDA.L operand at +19
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 2, 10, 23, 0x13)
    handle_0DB3BD(cur)
    for (let c = 2; c <= 5; c++) expect(grid[10][c]).toBe(P1(0x06))
    expect(grid[10][6]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DB3E3 (objects 24-26, 34-46: two-row fill) ──────────────────────────

describe('handle_0DB3E3 (two-row fill)', () => {
  const HANDLER_ADDR = 0x0DB3E3
  const TOP_ADDR = 0x0DB3DB
  const BOT_ADDR = 0x0DB3DF

  function rom(): RomFile {
    const r = makeMockRom({
      [TOP_ADDR]: [0x00, 0x01, 0x04, 0x08],
      [BOT_ADDR]: [0x02, 0x03, 0x05, 0x0B],
    })
    stampLongOperand(r, HANDLER_ADDR, 30, TOP_ADDR)
    stampLongOperand(r, HANDLER_ADDR, 47, BOT_ADDR)
    return r
  }

  it('objNo 0x18 → top tile $00, bottom $02', () => {
    const grid = createGrid(2)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom(), 0, 0, 10, 0x18, 0x23)
    handle_0DB3E3(cur)
    for (let c = 0; c <= 3; c++) expect(grid[10][c]).toBe(0x00)
    for (let r = 11; r <= 12; r++) {
      for (let c = 0; c <= 3; c++) expect(grid[r][c]).toBe(0x02)
    }
  })

  it('objNo 0x1B uses DATA_0DB3DB[3] = $08 for top', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom(), 0, 0, 5, 0x1B, 0x00)
    handle_0DB3E3(cur)
    expect(grid[5][0]).toBe(0x08)
  })

  it('handles out-of-table X via raw ROM read (objNo 0x34)', () => {
    // X = 0x34 - 0x18 = 0x1C. Read lands at TOP_ADDR + 0x1C / BOT_ADDR + 0x1C.
    const r = makeMockRom({
      [TOP_ADDR + 0x1C]: [0xEE],
      [BOT_ADDR + 0x1C]: [0xFF],
    })
    stampLongOperand(r, HANDLER_ADDR, 30, TOP_ADDR)
    stampLongOperand(r, HANDLER_ADDR, 47, BOT_ADDR)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, r, 0, 0, 5, 0x34, 0x00)
    handle_0DB3E3(cur)
    expect(grid[5][0]).toBe(0xEE)
  })
})

// ── CODE_0DB42D (object 29: goal post) ────────────────────────────────────────

describe('handle_0DB42D (goal post)', () => {
  const HANDLER_ADDR = 0x0DB42D
  const TABLE_ADDR = 0x0DB42B

  it('row 0 on page 0 ($26), row 1 on page 1 ($144)', () => {
    const rom = makeMockRom({ [TABLE_ADDR]: [0x26, 0x44] })
    stampLongOperand(rom, HANDLER_ADDR, 26, TABLE_ADDR)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 2, 10, 29, 0x02)
    handle_0DB42D(cur)
    for (let c = 2; c <= 4; c++) {
      expect(grid[10][c]).toBe(0x26)
      expect(grid[11][c]).toBe(P1(0x44))
    }
  })
})

// ── CODE_0DB461 (object 30: rope/vine with end tile) ──────────────────────────

describe('handle_0DB461 (rope/vine)', () => {
  const HANDLER_ADDR = 0x0DB461
  it('rows of $0B followed by a final row of $0E', () => {
    const rom = makeMockRom()
    // LDA #$0B at +28, LDA #$0E at +51
    rom.writeAt(HANDLER_ADDR + 28, [0x0B])
    rom.writeAt(HANDLER_ADDR + 51, [0x0E])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 1, 10, 30, 0x21)
    handle_0DB461(cur)
    // Rows 10, 11: $0B × 2
    for (let r = 10; r <= 11; r++) {
      expect(grid[r][1]).toBe(0x0B)
      expect(grid[r][2]).toBe(0x0B)
    }
    // Row 12: $0E × 2
    expect(grid[12][1]).toBe(0x0E)
    expect(grid[12][2]).toBe(0x0E)
  })
})

// ── Extended handlers: 0DA64D, 0DA656, 0DA673, 0DA68E, 0DA6D1 ────────────────

describe('handle_0DA64D (ext 0x17 bonus tile)', () => {
  const HANDLER_ADDR = 0x0DA64D
  const CODE_0DA57B = 0x0DA57B
  const CODE_0DA57F = 0x0DA57F   // = CODE_0DA57B + 4 in vanilla
  const TABLE_ADDR  = 0x0DA548

  it('writes DATA_0DA548[0x32] = $2D on page 1', () => {
    const table = Array.from({ length: DATA_0DA548_LEN }, (_, i) => 0x10 + i)
    table[0x32] = 0x2D
    const rom = makeMockRom({ [TABLE_ADDR]: table })
    // CODE_0DA64D: LDA #$32 at +0, JMP CODE_0DA57F at +3 (3-byte JMP).
    rom.writeAt(HANDLER_ADDR + 1, [0x32])
    rom.writeAt(HANDLER_ADDR + 3, [CODE_0DA57F & 0xFF, (CODE_0DA57F >> 8) & 0xFF])
    // CODE_0DA57B's LDA.L operand (CODE_0DA57B + 69) points to DATA_0DA548.
    stampLongOperand(rom, CODE_0DA57B, 69, TABLE_ADDR)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 4, 10, 0x17, 0)
    handle_0DA64D(cur)
    expect(grid[10][4]).toBe(P1(0x2D))
  })
})

describe('handle_0DA656 (ext 0x42/0x43 horizontal pair — page 1)', () => {
  const HANDLER_ADDR = 0x0DA656
  function setupRom(): RomFile {
    const rom = makeMockRom({
      [0x0DA652]: [0xD8, 0xDB],
      [0x0DA654]: [0xDA, 0xDC],
    })
    stampLongOperand(rom, HANDLER_ADDR, 11, 0x0DA652)
    stampLongOperand(rom, HANDLER_ADDR, 18, 0x0DA654)
    return rom
  }

  it('0x42 writes DATA_0DA652[0] and DATA_0DA654[0]', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, setupRom(), 0, 5, 10, 0x42, 0)
    handle_0DA656(cur)
    expect(grid[10][5]).toBe(P1(0xD8))
    expect(grid[10][6]).toBe(P1(0xDA))
  })

  it('0x43 uses index 1 of the tables', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, setupRom(), 0, 5, 10, 0x43, 0)
    handle_0DA656(cur)
    expect(grid[10][5]).toBe(P1(0xDB))
    expect(grid[10][6]).toBe(P1(0xDC))
  })
})

describe('handle_0DA673 (ext 0x44/0x45 vertical pair)', () => {
  const HANDLER_ADDR = 0x0DA673
  it('0x44 writes DATA_0DA671[0] and $EB both on page 1', () => {
    const rom = makeMockRom({ [0x0DA671]: [0xB4, 0xB5] })
    stampLongOperand(rom, HANDLER_ADDR, 8, 0x0DA671)
    rom.writeAt(HANDLER_ADDR + 20, [0xEB])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 3, 10, 0x44, 0)
    handle_0DA673(cur)
    expect(grid[10][3]).toBe(P1(0xB4))
    expect(grid[11][3]).toBe(P1(0xEB))
  })
})

describe('handle_0DA68E (ext 0x46 midway)', () => {
  const HANDLER_ADDR = 0x0DA68E
  it('stamps $35 at col-1 and $38 at col', () => {
    const rom = makeMockRom()
    rom.writeAt(HANDLER_ADDR + 23, [0x35])
    rom.writeAt(HANDLER_ADDR + 31, [0x38])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 5, 10, 0x46, 0)
    handle_0DA68E(cur)
    expect(grid[10][4]).toBe(0x35)
    expect(grid[10][5]).toBe(0x38)
  })
})

describe('handle_0DB51F (3-segment vertical, object 32 — page 1)', () => {
  const HANDLER_ADDR = 0x0DB51F
  function setupRom(): RomFile {
    const rom = makeMockRom()
    rom.writeAt(HANDLER_ADDR + 15, [0x53])
    rom.writeAt(HANDLER_ADDR + 23, [0x54])
    rom.writeAt(HANDLER_ADDR + 36, [0x55])
    return rom
  }

  it('H=2 writes $53/$54/$55 (X=2: top + 1 mid + bot = 3 rows)', () => {
    const rom = setupRom()
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 3, 10, 32, 0x20)
    handle_0DB51F(cur)
    expect(grid[10][3]).toBe(P1(0x53))
    expect(grid[11][3]).toBe(P1(0x54))
    expect(grid[12][3]).toBe(P1(0x55))
    expect(grid[13][3]).toBe(TILE_EMPTY)
  })

  it('H=3 writes $53/$54/$54/$55 (X=3: top + 2 mid + bot = 4 rows)', () => {
    const rom = setupRom()
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 3, 10, 32, 0x30)
    handle_0DB51F(cur)
    expect(grid[10][3]).toBe(P1(0x53))
    expect(grid[11][3]).toBe(P1(0x54))
    expect(grid[12][3]).toBe(P1(0x54))
    expect(grid[13][3]).toBe(P1(0x55))
    expect(grid[14][3]).toBe(TILE_EMPTY)
  })

  it('H=0 writes just $53/$55 (no middle)', () => {
    const rom = setupRom()
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 3, 10, 32, 0x00)
    handle_0DB51F(cur)
    expect(grid[10][3]).toBe(P1(0x53))
    expect(grid[11][3]).toBe(P1(0x55))
    expect(grid[12][3]).toBe(TILE_EMPTY)
  })
})

describe('handle_0DB547 (3-segment horizontal, object 33 — page 1)', () => {
  const HANDLER_ADDR = 0x0DB547
  it('W=3 writes $56/$57/$57/$58', () => {
    const rom = makeMockRom()
    rom.writeAt(HANDLER_ADDR + 11, [0x56])
    rom.writeAt(HANDLER_ADDR + 19, [0x57])
    rom.writeAt(HANDLER_ADDR + 30, [0x58])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 1, 10, 33, 0x03)
    handle_0DB547(cur)
    expect(grid[10][1]).toBe(P1(0x56))
    expect(grid[10][2]).toBe(P1(0x57))
    expect(grid[10][3]).toBe(P1(0x57))
    expect(grid[10][4]).toBe(P1(0x58))
  })
})

describe('handle_0DB571 (single-tile by size, objects 47-54)', () => {
  const HANDLER_ADDR = 0x0DB571
  const TABLE_ADDR = 0x0DB569

  it('stamps DATA_0DB569[size - $68]', () => {
    const rom = makeMockRom({
      [TABLE_ADDR]: [0x91, 0x92, 0x96, 0x97, 0x9A, 0x9B, 0x9F, 0xA0],
    })
    stampLongOperand(rom, HANDLER_ADDR, 12, TABLE_ADDR)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 3, 10, 47, 0x69)
    handle_0DB571(cur)
    expect(grid[10][3]).toBe(0x92)
  })
})

describe('handle_0DB5B7 (capped horizontal, object 63)', () => {
  const HANDLER_ADDR = 0x0DB5B7
  const LEFT_ADDR = 0x0DB5A8
  const MID_ADDR = 0x0DB5AD
  const RIGHT_ADDR = 0x0DB5B2

  it('W=3 writes leftCap + 2 middle + rightCap', () => {
    const rom = makeMockRom({
      [LEFT_ADDR]: [0x73, 0x7A, 0x85, 0x88, 0xC3],
      [MID_ADDR]:  [0x74, 0x7B, 0x86, 0x89, 0xC3],
      [RIGHT_ADDR]:[0x79, 0x80, 0x87, 0x8E, 0xC3],
    })
    stampLongOperand(rom, HANDLER_ADDR, 19, LEFT_ADDR)
    stampLongOperand(rom, HANDLER_ADDR, 29, MID_ADDR)
    stampLongOperand(rom, HANDLER_ADDR, 43, RIGHT_ADDR)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 2, 10, 63, 0x03)
    handle_0DB5B7(cur)
    expect(grid[10][2]).toBe(0x73)
    expect(grid[10][3]).toBe(0x74)
    expect(grid[10][4]).toBe(0x74)
    expect(grid[10][5]).toBe(0x79)
  })
})

describe('handle_0DA6D1 (ext 0x47/0x48 vertical pair)', () => {
  const HANDLER_ADDR = 0x0DA6D1
  function setupRom(): RomFile {
    const rom = makeMockRom({
      [0x0DA6CD]: [0x1F, 0x27],
      [0x0DA6CF]: [0x20, 0x28],
    })
    stampLongOperand(rom, HANDLER_ADDR, 11, 0x0DA6CD)
    stampLongOperand(rom, HANDLER_ADDR, 23, 0x0DA6CF)
    return rom
  }

  it('0x47 writes top then bottom from paired tables', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, setupRom(), 0, 2, 10, 0x47, 0)
    handle_0DA6D1(cur)
    expect(grid[10][2]).toBe(0x1F)
    expect(grid[11][2]).toBe(0x20)
  })

  it('0x48 uses index 1', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, setupRom(), 0, 2, 10, 0x48, 0)
    handle_0DA6D1(cur)
    expect(grid[10][2]).toBe(0x27)
    expect(grid[11][2]).toBe(0x28)
  })
})

// ── Additional standard handlers (0DB075 slope, 0DB1C8 huge ground) ──────────

describe('handle_0DB1C8 (huge ground fill, object 33)', () => {
  const HANDLER_ADDR = 0x0DB1C8
  const SHARED_BODY_ADDR = 0x0DB1E3   // CODE_0DB1E3

  function setupRom(): RomFile {
    const rom = makeMockRom()
    // LDA #$02 (height-1) immediate at +6
    rom.writeAt(HANDLER_ADDR + 6, [0x02])
    // JMP CODE_0DB1E3 operand at +10 (2-byte little-endian target in same bank)
    rom.writeAt(HANDLER_ADDR + 10, [SHARED_BODY_ADDR & 0xFF, (SHARED_BODY_ADDR >> 8) & 0xFF])
    // Shared body: LDA # immediates at body+9 ($00) and body+25 ($3F)
    rom.writeAt(SHARED_BODY_ADDR + 9,  [0x00])
    rom.writeAt(SHARED_BODY_ADDR + 25, [0x3F])
    return rom
  }

  it('size $BF produces a 192-tile grass-capped 3-tall block', () => {
    const rom = setupRom()
    const grid = createGrid(13)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 0, 24, 33, 0xBF)
    handle_0DB1C8(cur)
    for (let c = 0; c < 192; c++) expect(grid[24][c]).toBe(P1(0x00))
    for (let r = 25; r <= 26; r++) {
      for (let c = 0; c < 192; c++) expect(grid[r][c]).toBe(0x3F)
    }
    expect(grid[24][200]).toBe(TILE_EMPTY)
  })

  it('size $0 produces a 1-tile wide × 3-tall block', () => {
    const rom = setupRom()
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 5, 10, 33, 0x00)
    handle_0DB1C8(cur)
    expect(grid[10][5]).toBe(P1(0x00))
    expect(grid[11][5]).toBe(0x3F)
    expect(grid[12][5]).toBe(0x3F)
    expect(grid[13][5]).toBe(TILE_EMPTY)
  })
})

describe('handle_0DB075 (slope/vine column, object 19)', () => {
  const HANDLER_ADDR = 0x0DB075

  function setupRom(): RomFile {
    const rom = makeMockRom({
      [0x0DB039]: Array.from({ length: 15 }, (_, i) => 0x40 + i),
      [0x0DB048]: Array.from({ length: 15 }, (_, i) => 0x50 + i),
      [0x0DB057]: Array.from({ length: 15 }, (_, i) => 0x60 + i),
      [0x0DB066]: Array.from({ length: 15 }, (_, i) => 0x70 + i),
    })
    // LDA.L operands in CODE_0DB075
    stampLongOperand(rom, HANDLER_ADDR, 26, 0x0DB039)
    stampLongOperand(rom, HANDLER_ADDR, 60, 0x0DB048)
    stampLongOperand(rom, HANDLER_ADDR, 94, 0x0DB057)
    stampLongOperand(rom, HANDLER_ADDR, 117, 0x0DB066)
    // JSR CODE_0DB114 operand at +30, JSR CODE_0DB198 at +64 (2-byte same-bank)
    rom.writeAt(HANDLER_ADDR + 30, [0x14, 0xB1])
    rom.writeAt(HANDLER_ADDR + 64, [0x98, 0xB1])
    // These tests use X values (2 / 0xB) that cause the merge helpers to skip
    // their merge logic entirely (see writeTileMergeCODE_0DB114/198 skip rules),
    // so the tables inside the helpers are not read. No need to stamp them here.
    return rom
  }

  it('X=2: top + row-1 + middles, all page 0, no footer', () => {
    const rom = setupRom()
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 5, 10, 19, 0x32)
    handle_0DB075(cur)
    expect(grid[10][5]).toBe(0x42)
    expect(grid[11][5]).toBe(0x52)
    expect(grid[12][5]).toBe(0x62)
    expect(grid[13][5]).toBe(0x62)
    expect(grid[14][5]).toBe(TILE_EMPTY)
  })

  it('X=0xB appends footer tile, page 1 throughout', () => {
    const rom = setupRom()
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 5, 10, 19, 0x1B)
    handle_0DB075(cur)
    expect(grid[10][5]).toBe(P1(0x4B))
    expect(grid[11][5]).toBe(P1(0x5B))
    expect(grid[12][5]).toBe(P1(0x7B))
  })
})

describe('handle_0DAB3E pipe variants (object 18)', () => {
  const DISPATCHER_ADDR = 0x0DAB3E
  const VARIANT_ADDRS = [
    0x0DAB6E, 0x0DAC21, 0x0DAC92, 0x0DAD44, 0x0DADA3,
    0x0DADEB, 0x0DAE6D, 0x0DAEFC, 0x0DAF61, 0x0DAFEA,
  ]

  /** Stamp the 10-entry dispatch table at handler+18 so the TS dispatcher
   *  resolves each variant's SNES address. Each entry is a 3-byte long ptr. */
  function stampDispatchTable(rom: RomFile): void {
    for (let i = 0; i < VARIANT_ADDRS.length; i++) {
      stampLongOperand(rom, DISPATCHER_ADDR, 18 + i * 3, VARIANT_ADDRS[i])
    }
  }

  it('variant 0: 2-wide diagonal down-left slope', () => {
    // Per CODE_0DAB6E (bank_0D:2301): 2-wide lip/body descending col-2/row+1
    // per iter, with a final straight-down body row. For size $20 (H=2):
    //   row 10 (iter 0):    lip pair at cols 4-5
    //   row 11 (iter 1):    lip pair at cols 2-3, body pair at cols 4-5
    //   row 12 (iter 2):    lip pair at cols 0-1, body pair at cols 2-3, fills at cols 4-5
    //   row 13 (final):     body pair at cols 0-1, fills at cols 2-5
    const rom = makeMockRom()
    stampDispatchTable(rom)
    rom.writeAt(0x0DAB6E + 27, [0x96])
    rom.writeAt(0x0DAB6E + 35, [0x9B])
    rom.writeAt(0x0DAB6E + 47, [0xDE])
    rom.writeAt(0x0DAB6E + 55, [0xE6])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(DISPATCHER_ADDR, grid, rom, 0, 4, 10, 18, 0x20)
    handle_0DAB3E(cur)
    // Row 10: lip pair at cols 4-5
    expect(grid[10][4]).toBe(P1(0x96)); expect(grid[10][5]).toBe(P1(0x9B))
    // Row 11: lip pair at cols 2-3, body pair at cols 4-5
    expect(grid[11][2]).toBe(P1(0x96)); expect(grid[11][3]).toBe(P1(0x9B))
    expect(grid[11][4]).toBe(P1(0xDE)); expect(grid[11][5]).toBe(P1(0xE6))
    // Row 12: lip pair at cols 0-1, body pair at cols 2-3, fills at cols 4-5
    expect(grid[12][0]).toBe(P1(0x96)); expect(grid[12][1]).toBe(P1(0x9B))
    expect(grid[12][2]).toBe(P1(0xDE)); expect(grid[12][3]).toBe(P1(0xE6))
    expect(grid[12][4]).toBe(0x3F);     expect(grid[12][5]).toBe(0x3F)
    // Row 13: body pair at cols 0-1, fills at cols 2-5
    expect(grid[13][0]).toBe(P1(0xDE)); expect(grid[13][1]).toBe(P1(0xE6))
    expect(grid[13][2]).toBe(0x3F);     expect(grid[13][3]).toBe(0x3F)
    expect(grid[13][4]).toBe(0x3F);     expect(grid[13][5]).toBe(0x3F)
  })

  it('variant 1: diagonal down-left pipe, lips form a stair', () => {
    // pipeVariant1 (CODE_0DAC21): +25 $AA (merged lip), +36 $E2 (body), +47 $3F.
    const rom = makeMockRom()
    stampDispatchTable(rom)
    rom.writeAt(0x0DAC21 + 25, [0xAA])
    rom.writeAt(0x0DAC21 + 36, [0xE2])
    rom.writeAt(0x0DAC21 + 47, [0x3F])
    const grid = createGrid(2)
    const cur = makeCursorForHandler(DISPATCHER_ADDR, grid, rom, 0, 10, 10, 18, 0x21)
    handle_0DAB3E(cur)
    expect(grid[10][10]).toBe(P1(0xAA))
    expect(grid[10][11]).toBe(TILE_EMPTY)
    expect(grid[11][9]).toBe(P1(0xAA))
    expect(grid[11][10]).toBe(P1(0xE2))
    expect(grid[12][8]).toBe(P1(0xAA))
    expect(grid[12][9]).toBe(P1(0xE2))
    expect(grid[12][10]).toBe(0x3F)
  })

  it('variant 3: diagonal down-right slope, lip shifts 2 cols per row', () => {
    // Per CODE_0DAD44 (bank_0D:2580). Size $13 -> H=1 -> rowCount=3:
    //   row 10: lip pair at cols 4-5
    //   row 11: mid pair at cols 4-5, lip pair at cols 6-7
    //   row 12 (final): 2 fills at cols 4-5, mid pair at cols 6-7 (no lip)
    const rom = makeMockRom()
    stampDispatchTable(rom)
    rom.writeAt(0x0DAD44 + 28, [0x3F])
    rom.writeAt(0x0DAD44 + 41, [0xE6])
    rom.writeAt(0x0DAD44 + 49, [0xE0])
    rom.writeAt(0x0DAD44 + 63, [0xA0])
    rom.writeAt(0x0DAD44 + 71, [0xA5])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(DISPATCHER_ADDR, grid, rom, 0, 4, 10, 18, 0x13)
    handle_0DAB3E(cur)
    // Row 10
    expect(grid[10][4]).toBe(P1(0xA0)); expect(grid[10][5]).toBe(P1(0xA5))
    // Row 11
    expect(grid[11][4]).toBe(P1(0xE6)); expect(grid[11][5]).toBe(P1(0xE0))
    expect(grid[11][6]).toBe(P1(0xA0)); expect(grid[11][7]).toBe(P1(0xA5))
    // Row 12 (final, no lip)
    expect(grid[12][4]).toBe(0x3F);     expect(grid[12][5]).toBe(0x3F)
    expect(grid[12][6]).toBe(P1(0xE6)); expect(grid[12][7]).toBe(P1(0xE0))
    expect(grid[12][8]).toBe(TILE_EMPTY)
  })

  it('variant 4: 1-wide diagonal pipe sloping up-left', () => {
    // pipeVariant4 (CODE_0DADA3): +28 $3F, +41 $E4, +53 $AF.
    const rom = makeMockRom()
    stampDispatchTable(rom)
    rom.writeAt(0x0DADA3 + 28, [0x3F])
    rom.writeAt(0x0DADA3 + 41, [0xE4])
    rom.writeAt(0x0DADA3 + 53, [0xAF])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(DISPATCHER_ADDR, grid, rom, 0, 4, 10, 18, 0x24)
    handle_0DAB3E(cur)
    expect(grid[10][4]).toBe(P1(0xAF))
    expect(grid[11][4]).toBe(P1(0xE4))
    expect(grid[11][5]).toBe(P1(0xAF))
    expect(grid[12][4]).toBe(0x3F)
    expect(grid[12][5]).toBe(P1(0xE4))
    expect(grid[12][6]).toBe(P1(0xAF))
  })

  it('variant 5: 4-wide vertical pipe', () => {
    // pipeVariant5 (CODE_0DADEB): +26 $3F, +39 $E6, +47 $E6, +55 $DB, +63 $DC,
    //                             +79 $82, +87 $87, +95 $8C, +103 $91.
    const rom = makeMockRom()
    stampDispatchTable(rom)
    rom.writeAt(0x0DADEB + 26, [0x3F])
    rom.writeAt(0x0DADEB + 39, [0xE6])
    rom.writeAt(0x0DADEB + 47, [0xE6])
    rom.writeAt(0x0DADEB + 55, [0xDB])
    rom.writeAt(0x0DADEB + 63, [0xDC])
    rom.writeAt(0x0DADEB + 79, [0x82])
    rom.writeAt(0x0DADEB + 87, [0x87])
    rom.writeAt(0x0DADEB + 95, [0x8C])
    rom.writeAt(0x0DADEB + 103, [0x91])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(DISPATCHER_ADDR, grid, rom, 0, 4, 10, 18, 0x15)
    handle_0DAB3E(cur)
    expect(grid[10][4]).toBe(P1(0x82))
    expect(grid[10][5]).toBe(P1(0x87))
    expect(grid[10][6]).toBe(P1(0x8C))
    expect(grid[10][7]).toBe(P1(0x91))
    expect(grid[11][4]).toBe(P1(0xE6))
    expect(grid[11][5]).toBe(P1(0xE6))
    expect(grid[11][6]).toBe(P1(0xDB))
    expect(grid[11][7]).toBe(P1(0xDC))
  })

  it('variant 8: diagonal slope with vertical right edge, H=3', () => {
    // pipeVariant8 (CODE_0DAF61): +32 $C4 (lip), +43 $EC (body), +54 $65 (fill).
    //
    // Size $38 -> H=3. Starting at col=5, row=10. Right edge always at col 7 (col0+H-1).
    //   Iter 0 at (5, 10): EC $65 $65           [body + H-1=2 fills]
    //   Iter 1 at (5, 11): C4 EC $65            [C4 lip + body + H-2=1 fill]
    //   Iter 2 at (6, 12): C4 EC                [C4 lip + body + H-3=0 fills]
    //   Iter 3 at (7, 13): C4                   [C4 lip only; _2==0 -> BMI skips EC]
    const rom = makeMockRom()
    stampDispatchTable(rom)
    rom.writeAt(0x0DAF61 + 32, [0xC4])
    rom.writeAt(0x0DAF61 + 43, [0xEC])
    rom.writeAt(0x0DAF61 + 54, [0x65])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(DISPATCHER_ADDR, grid, rom, 0, 5, 10, 18, 0x38)
    handle_0DAB3E(cur)
    // Row 10 (iter 0): EC at 5, fill at 6, fill at 7.
    expect(grid[10][5]).toBe(P1(0xEC))
    expect(grid[10][6]).toBe(P1(0x65))
    expect(grid[10][7]).toBe(P1(0x65))
    expect(grid[10][8]).toBe(TILE_EMPTY)
    // Row 11 (iter 1): C4 at 5, EC at 6, fill at 7.
    expect(grid[11][5]).toBe(P1(0xC4))
    expect(grid[11][6]).toBe(P1(0xEC))
    expect(grid[11][7]).toBe(P1(0x65))
    expect(grid[11][8]).toBe(TILE_EMPTY)
    // Row 12 (iter 2): C4 at 6, EC at 7.
    expect(grid[12][5]).toBe(TILE_EMPTY)
    expect(grid[12][6]).toBe(P1(0xC4))
    expect(grid[12][7]).toBe(P1(0xEC))
    expect(grid[12][8]).toBe(TILE_EMPTY)
    // Row 13 (iter 3, i==H=3): C4 at 7 only (_2==0 -> BMI skips EC).
    expect(grid[13][6]).toBe(TILE_EMPTY)
    expect(grid[13][7]).toBe(P1(0xC4))
    expect(grid[13][8]).toBe(TILE_EMPTY)
  })

  it('variant 9: diagonal slope with vertical left edge, H=3', () => {
    // pipeVariant9 (CODE_0DAFEA): +28 $65 (fill), +45 $ED (body), +57 $C5 (lip).
    //
    // Size $39 -> H=3. Starting at col=5, row=10. All rows start at col0=5.
    //   Iter 0 (X=3): $65 $65 ED at cols 5,6,7  [2 fills + body; no C5 since _1=0]
    //   Iter 1 (X=2): $65 ED C5 at cols 5,6,7   [1 fill + body + lip]
    //   Iter 2 (X=1): ED C5 at cols 5,6          [no fills + body + lip]
    //   Iter 3 (X=0): C5 at col 5 only            [X==0: skip fills+ED, just lip]
    const rom = makeMockRom()
    stampDispatchTable(rom)
    rom.writeAt(0x0DAFEA + 28, [0x65])
    rom.writeAt(0x0DAFEA + 45, [0xED])
    rom.writeAt(0x0DAFEA + 57, [0xC5])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(DISPATCHER_ADDR, grid, rom, 0, 5, 10, 18, 0x39)
    handle_0DAB3E(cur)
    // Row 10 (iter 0, X=3): fills at 5,6; ED at 7; no C5.
    expect(grid[10][5]).toBe(P1(0x65))
    expect(grid[10][6]).toBe(P1(0x65))
    expect(grid[10][7]).toBe(P1(0xED))
    expect(grid[10][8]).toBe(TILE_EMPTY)
    // Row 11 (iter 1, X=2): fill at 5; ED at 6; C5 at 7.
    expect(grid[11][5]).toBe(P1(0x65))
    expect(grid[11][6]).toBe(P1(0xED))
    expect(grid[11][7]).toBe(P1(0xC5))
    expect(grid[11][8]).toBe(TILE_EMPTY)
    // Row 12 (iter 2, X=1): ED at 5; C5 at 6.
    expect(grid[12][5]).toBe(P1(0xED))
    expect(grid[12][6]).toBe(P1(0xC5))
    expect(grid[12][7]).toBe(TILE_EMPTY)
    // Row 13 (iter 3, X=0): C5 only at 5.
    expect(grid[13][5]).toBe(P1(0xC5))
    expect(grid[13][6]).toBe(TILE_EMPTY)
  })
})

describe('handle_0DB224 (3-column framed structure, object 21)', () => {
  const HANDLER_ADDR = 0x0DB224

  function stampAllTables(rom: RomFile) {
    // See handler comment for offsets: V=0 (top/mid/bot) at +24,+66,+108;
    // V!=0 at +34,+76,+118.
    stampLongOperand(rom, HANDLER_ADDR, 24, 0x0DB212)
    stampLongOperand(rom, HANDLER_ADDR, 66, 0x0DB215)
    stampLongOperand(rom, HANDLER_ADDR, 108, 0x0DB218)
    stampLongOperand(rom, HANDLER_ADDR, 34, 0x0DB21B)
    stampLongOperand(rom, HANDLER_ADDR, 76, 0x0DB21E)
    stampLongOperand(rom, HANDLER_ADDR, 118, 0x0DB221)
  }

  it('variant 0, H=1: TOP + BOT only (no middle, H-1=0 iterations)', () => {
    const rom = makeMockRom({
      [0x0DB212]: [0x2F, 0x25, 0x32],
      [0x0DB215]: [0x30, 0x25, 0x33],
      [0x0DB218]: [0x31, 0x25, 0x34],
    })
    stampAllTables(rom)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 2, 10, 21, 0x10)
    handle_0DB224(cur)
    // H=1 → ASM's `DEC _1; BEQ CODE_0DB28F` after TOP skips the middle loop.
    // Net: row 0 = TOP, row 1 = BOT.
    expect(grid[10][2]).toBe(0x2F)
    expect(grid[11][2]).toBe(0x31)
    expect(grid[10][3]).toBe(0x25)
    expect(grid[11][3]).toBe(0x25)
    expect(grid[10][4]).toBe(0x32)
    expect(grid[11][4]).toBe(0x34)
  })

  it('variant 0, H=2: TOP + 1 middle + BOT', () => {
    const rom = makeMockRom({
      [0x0DB212]: [0x2F, 0x25, 0x32],
      [0x0DB215]: [0x30, 0x25, 0x33],
      [0x0DB218]: [0x31, 0x25, 0x34],
    })
    stampAllTables(rom)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 2, 10, 21, 0x20)
    handle_0DB224(cur)
    expect(grid[10][2]).toBe(0x2F)
    expect(grid[11][2]).toBe(0x30)
    expect(grid[12][2]).toBe(0x31)
    expect(grid[12][4]).toBe(0x34)
  })

  it('variant != 0 uses DATA_0DB21B/21E/221 triples', () => {
    const rom = makeMockRom({
      [0x0DB21B]: [0x39, 0x25, 0x3C],
      [0x0DB21E]: [0x3A, 0x25, 0x3D],
      [0x0DB221]: [0x3B, 0x25, 0x3E],
    })
    stampAllTables(rom)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 2, 10, 21, 0x11)
    handle_0DB224(cur)
    // H=1 variant-1: TOP + BOT only.
    expect(grid[10][2]).toBe(0x39)
    expect(grid[11][2]).toBe(0x3B)
    expect(grid[11][4]).toBe(0x3E)
  })
})

describe('handle_0DB2CA (dragon coin, ext 0x41)', () => {
  const HANDLER_ADDR = 0x0DB2CA
  it('writes $2D above $2E', () => {
    const rom = makeMockRom()
    rom.writeAt(HANDLER_ADDR + 94, [0x2D])
    rom.writeAt(HANDLER_ADDR + 104, [0x2E])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 3, 15, 0x30, 0)
    handle_0DB2CA(cur)
    expect(grid[15][3]).toBe(0x2D)
    expect(grid[16][3]).toBe(0x2E)
  })
})

// ── Integration: real SMW ROM, level $105 (Yoshi's Island 1) ─────────────────
// These tests require test/roms/Super Mario World (USA).vanilla.sfc to be present.
// They confirm the ported handlers produce non-empty tile grids for a known
// reference level.

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

describe('expandMap integration (real SMW ROM)', () => {
  if (!romPresent) {
    it.skip('SMW ROM not present — integration tests skipped', () => {})
    return
  }

  const rom = SmwRom.open(ROM_PATH)

  /** Load and expand a level by translevel index (passes levelNum for layer3 overflow). */
  function expandLevelByIndex(index: number) {
    const rawL1 = rom.getLevelRawData(index)
    if (!rawL1) throw new Error(`Level $${index.toString(16)} has no data`)
    const { header, objects } = parseLevelObjects(rawL1)
    const screens = header.levelLength
    const grid = expandMap(objects, screens, rom.rom, header.objectTileset, false, header.levelMode, index)
    return { grid, header, objects, screens }
  }

  it('level $105 header parses as tileset 0', () => {
    const { header } = expandLevelByIndex(0x105)
    expect(header.objectTileset).toBeGreaterThanOrEqual(0)
    expect(header.objectTileset).toBeLessThan(15)
  })

  it('level $105 produces many non-empty tiles (ground + slopes + misc)', () => {
    const { grid } = expandLevelByIndex(0x105)
    let nonEmpty = 0
    for (const row of grid) {
      for (const t of row) {
        if (t !== TILE_EMPTY) nonEmpty++
      }
    }
    // The reference YI1 screenshot has hundreds of ground/slope tiles.
    // Stubbed expanders yielded fewer than 20; a working expander should
    // produce an order of magnitude more.
    expect(nonEmpty).toBeGreaterThan(200)
  })

  it('level $105 has a ground-like run somewhere in the lower half', () => {
    const { grid } = expandLevelByIndex(0x105)
    // Somewhere in rows 20-26 (lower half) there should be a row with 8+
    // filled tiles across the first screen — confirming CODE_0DA8C3 ran.
    let best = 0
    for (let r = 20; r < 27; r++) {
      let run = 0
      for (let c = 0; c < 16; c++) {
        if (grid[r][c] !== TILE_EMPTY) run++
      }
      if (run > best) best = run
    }
    expect(best).toBeGreaterThan(8)
  })

  it('level $105 has non-empty tiles at reasonable distribution', () => {
    const { grid } = expandLevelByIndex(0x105)
    // Count non-empty tiles per row; find the bottom-most row with content,
    // which should be well below the middle of the level.
    let deepestRow = 0
    for (let r = 0; r < 27; r++) {
      for (const t of grid[r]) {
        if (t !== TILE_EMPTY) { deepestRow = r; break }
      }
    }
    expect(deepestRow).toBeGreaterThan(15)
  })

  it('does not throw on the first 16 levels', () => {
    // Smoke-test: run the expander across many levels; if a handler has a
    // latent infinite loop or unbounded index, one of these should trip it.
    for (let i = 0x105; i < 0x115; i++) {
      expect(() => expandLevelByIndex(i)).not.toThrow()
    }
  })

  // ── Layer 3 / overflow screen tests (require ROM for DATA_05F200 read) ────────

  it('readLayer3Setting returns 2 for level $002 (byte $80 → bits 7:6 = 2)', () => {
    // DATA_05F200[$002] = $80 → (0x80 & 0xC0) >> 6 = 2
    expect(readLayer3Setting(rom.rom, 0x002)).toBe(2)
  })

  it('readLayer3Setting returns 1 for level $127 (byte $40 → bits 7:6 = 1)', () => {
    // DATA_05F200[$127] = $40 → (0x40 & 0xC0) >> 6 = 1
    expect(readLayer3Setting(rom.rom, 0x127)).toBe(1)
  })

  it('readLayer3Setting returns 0 for level $005 (no Layer 3 tide)', () => {
    // DATA_05F200[$005] = $01 → (0x01 & 0xC0) >> 6 = 0
    expect(readLayer3Setting(rom.rom, 0x005)).toBe(0)
  })

  it('level $002: grid has 2 overflow screens (18 total × 16 = 288 cols)', () => {
    // levelLength=16, Layer3Setting=2 → 16 defined + 2 overflow = 18 screens
    const { grid, header } = expandLevelByIndex(0x002)
    expect(header.levelLength).toBe(16)
    expect(grid[0].length).toBe(18 * SCREEN_W)
  })

  it('level $002: screen 16 rows 0-15 are TILE_EMPTY (before OWLayer1VramBuffer)', () => {
    const { grid } = expandLevelByIndex(0x002)
    for (let r = 0; r <= 15; r++) {
      for (let c = 256; c < 272; c++) {
        expect(grid[r][c]).toBe(TILE_EMPTY)
      }
    }
  })

  it('level $002: screen 16 rows 16-26 are $000 (zeroed by CODE_00A045)', () => {
    const { grid } = expandLevelByIndex(0x002)
    for (let r = 16; r <= 26; r++) {
      for (let c = 256; c < 272; c++) {
        expect(grid[r][c]).toBe(0x00)
      }
    }
  })

  it('level $127: screen 17 rows 0-15 are TILE_EMPTY (CODE_00A045 skip gap)', () => {
    // owlBufOff for screen 17 row 0 = 17*0x1B0 - 0x1C00 = 0xB0
    // 0xB0 % 0x1B0 = 0xB0 which is NOT < 0xB0 → not zeroed
    const { grid } = expandLevelByIndex(0x127)
    for (let r = 0; r <= 15; r++) {
      for (let c = 272; c < 288; c++) {
        expect(grid[r][c]).toBe(TILE_EMPTY)
      }
    }
  })

  it('level $127: screen 17 rows 16-26 are $000 (CODE_00A045 batch 1)', () => {
    // owlBufOff for screen 17 row 16 = 0xB0 + 16*0x10 = 0x1B0
    // 0x1B0 % 0x1B0 = 0 < 0xB0 → zeroed
    const { grid } = expandLevelByIndex(0x127)
    for (let r = 16; r <= 26; r++) {
      for (let c = 272; c < 288; c++) {
        expect(grid[r][c]).toBe(0x00)
      }
    }
  })
})

// ── Slope handlers (port sanity checks) ──────────────────────────────────────
// The slope shapes are data-dependent and intricate; these tests verify that
// the handlers don't throw, produce tiles in the expected general region of
// the grid, and advance diagonally (tile-count grows with the size parameter).

describe('handle_0DB73F (diagonal slope walker, object 57)', () => {
  const HANDLER_ADDR = 0x0DB73F
  function setupRom(): RomFile {
    const rom = makeMockRom({
      [0x0DB72F]: [0xC4, 0xC5, 0xC7, 0xEC, 0xED, 0xC6, 0xC7, 0xEE,
                   0x59, 0x5A, 0xEF, 0xC7, 0xEE, 0x59, 0x5B, 0x5C],
    })
    // LDA.L DATA_0DB72F operand at handler +27
    stampLongOperand(rom, HANDLER_ADDR, 27, 0x0DB72F)
    // LDA #$01 (initial _1) at +11, LDA #$EB (capper) at +103
    rom.writeAt(HANDLER_ADDR + 11, [0x01])
    rom.writeAt(HANDLER_ADDR + 103, [0xEB])
    return rom
  }

  it('produces tiles along a down-left diagonal starting at the cursor', () => {
    const rom = setupRom()
    const grid = createGrid(3)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 20, 10, 57, 0x20)
    expect(() => handle_0DB73F(cur)).not.toThrow()
    expect(grid[10][20]).toBe(P1(0xC4))
  })

  it('larger size produces more total tiles', () => {
    const rom = setupRom()
    function countTiles(size: number): number {
      const g = createGrid(3)
      const c = makeCursorForHandler(HANDLER_ADDR, g, rom, 0, 25, 10, 57, size)
      handle_0DB73F(c)
      let n = 0
      for (const row of g) for (const t of row) if (t !== TILE_EMPTY) n++
      return n
    }
    expect(countTiles(0x30)).toBeGreaterThan(countTiles(0x10))
  })
})

describe('handle_0DB7AA (pyramid/hill slope, object 58)', () => {
  const HANDLER_ADDR = 0x0DB7AA
  function setupRom(): RomFile {
    const rom = makeMockRom()
    // 10 inline `LDA #$XX` immediates. The operand byte follows the $A9 opcode,
    // so we stamp one byte past each opcode offset.
    rom.writeAt(HANDLER_ADDR + 29,  [0xAA])
    rom.writeAt(HANDLER_ADDR + 37,  [0xA1])
    rom.writeAt(HANDLER_ADDR + 48,  [0xAA])
    rom.writeAt(HANDLER_ADDR + 57,  [0xE2])
    rom.writeAt(HANDLER_ADDR + 68,  [0x3F])
    rom.writeAt(HANDLER_ADDR + 79,  [0xA6])
    rom.writeAt(HANDLER_ADDR + 114, [0xF7])
    rom.writeAt(HANDLER_ADDR + 125, [0xA3])
    rom.writeAt(HANDLER_ADDR + 136, [0x3F])
    rom.writeAt(HANDLER_ADDR + 147, [0xA6])
    return rom
  }

  it('produces a non-empty hill shape without throwing', () => {
    const rom = setupRom()
    const grid = createGrid(4)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 20, 10, 58, 0x22)
    expect(() => handle_0DB7AA(cur)).not.toThrow()
    let rowHasLip = false
    for (const tile of grid[10]) {
      if (tile === P1(0xAA)) { rowHasLip = true; break }
    }
    expect(rowHasLip).toBe(true)
  })

  it('larger widths create larger hills', () => {
    const rom = setupRom()
    function count(size: number): number {
      const g = createGrid(5)
      const c = makeCursorForHandler(HANDLER_ADDR, g, rom, 0, 30, 10, 58, size)
      handle_0DB7AA(c)
      let n = 0
      for (const row of g) for (const t of row) if (t !== TILE_EMPTY) n++
      return n
    }
    expect(count(0x44)).toBeGreaterThan(count(0x11))
  })
})

// ── Switch-palace blocks: all 4 colors render in their cleared (pressed) state ──
// Green/yellow are extended single-tile handlers; blue/red are standard
// rectangular handlers. All four write the page-1 Map16 tile so fixtures
// captured from Mesen (which runs with switches pressed) match byte-exact; the
// webview's `applySwitchPalaceState` re-applies the page bit per the UI toggle.

describe('handle_0DB58B (green switch-palace block, ext)', () => {
  const HANDLER_ADDR = 0x0DB58B
  const TABLE_ADDR = 0x0DB587

  it('writes $16A (green cleared) at cursor', () => {
    const rom = makeMockRom({
      [TABLE_ADDR]: [0x6A, 0x6B],          // DATA_0DB587[0]=$6A (green), [1]=$6B (yellow)
      [HANDLER_ADDR + 1]: [0x00],          // LDX #$00 immediate
    })
    stampLongOperand(rom, HANDLER_ADDR, 23, TABLE_ADDR)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 5, 10, 0, 0x87)
    handle_0DB58B(cur)
    expect(grid[10][5]).toBe(P1(0x6A))     // page 1 | $6A
  })
})

describe('handle_0DB583 (yellow switch-palace block, ext)', () => {
  const HANDLER_ADDR = 0x0DB583
  const TABLE_ADDR = 0x0DB587

  it('writes $16B (yellow cleared) at cursor', () => {
    const rom = makeMockRom({
      [TABLE_ADDR]: [0x6A, 0x6B],
      [HANDLER_ADDR + 1]: [0x01],          // LDX #$01 immediate
    })
    stampLongOperand(rom, HANDLER_ADDR, 31, TABLE_ADDR)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 5, 10, 0, 0x8E)
    handle_0DB583(cur)
    expect(grid[10][5]).toBe(P1(0x6B))
  })
})

describe('handle_0DB916 (blue switch-palace block, standard rect)', () => {
  const HANDLER_ADDR = 0x0DB916
  const TABLE_ADDR = 0x0DB91A

  function setupRom(): RomFile {
    const rom = makeMockRom({
      [TABLE_ADDR]: [0x6C, 0x6D],          // DATA_0DB91A[0]=$6C (blue), [1]=$6D (red)
      [HANDLER_ADDR + 1]: [0x00],          // LDX #$00 immediate
    })
    stampLongOperand(rom, HANDLER_ADDR, 37, TABLE_ADDR)
    return rom
  }

  it('size $00 writes a single $16C at cursor', () => {
    const rom = setupRom()
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 3, 10, 30, 0x00)
    handle_0DB916(cur)
    expect(grid[10][3]).toBe(P1(0x6C))
    // Ensure no accidental spill into neighbors.
    expect(grid[10][2]).toBe(TILE_EMPTY)
    expect(grid[10][4]).toBe(TILE_EMPTY)
    expect(grid[11][3]).toBe(TILE_EMPTY)
  })

  it('size $23 fills a 4-wide x 3-tall rect of $16C', () => {
    const rom = setupRom()
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 2, 10, 30, 0x23)
    handle_0DB916(cur)
    for (let r = 10; r <= 12; r++) {
      for (let c = 2; c <= 5; c++) {
        expect(grid[r][c]).toBe(P1(0x6C))
      }
    }
    // One past the right edge must remain empty.
    expect(grid[10][6]).toBe(TILE_EMPTY)
    expect(grid[13][2]).toBe(TILE_EMPTY)
  })

  it('restores cursor col/row after writing', () => {
    const rom = setupRom()
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 7, 10, 30, 0x12)
    handle_0DB916(cur)
    expect(cur.col).toBe(7)
    expect(cur.row).toBe(10)
  })
})

describe('handle_0DB91E (red switch-palace block, standard rect)', () => {
  const HANDLER_ADDR = 0x0DB91E
  const TABLE_ADDR = 0x0DB91A

  it('writes $16D (red cleared) — single tile at size $00', () => {
    const rom = makeMockRom({
      [TABLE_ADDR]: [0x6C, 0x6D],
      [HANDLER_ADDR + 1]: [0x01],          // LDX #$01 immediate
    })
    stampLongOperand(rom, HANDLER_ADDR, 29, TABLE_ADDR)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 8, 10, 30, 0x00)
    handle_0DB91E(cur)
    expect(grid[10][8]).toBe(P1(0x6D))
  })

  it('size $11 fills a 2x2 rect of $16D', () => {
    const rom = makeMockRom({
      [TABLE_ADDR]: [0x6C, 0x6D],
      [HANDLER_ADDR + 1]: [0x01],
    })
    stampLongOperand(rom, HANDLER_ADDR, 29, TABLE_ADDR)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 4, 12, 30, 0x11)
    handle_0DB91E(cur)
    expect(grid[12][4]).toBe(P1(0x6D))
    expect(grid[12][5]).toBe(P1(0x6D))
    expect(grid[13][4]).toBe(P1(0x6D))
    expect(grid[13][5]).toBe(P1(0x6D))
    expect(grid[12][6]).toBe(TILE_EMPTY)
    expect(grid[14][4]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DEDB9 (tileset-4 object $3B: horizontal rail/fence strip) ───────────

describe('handle_0DEDB9 (horizontal cap-body-cap strip, tileset-4 object $3B)', () => {
  const HANDLER_ADDR = 0x0DEDB9
  const LEFT_IMM_OFFSET  = 11  // LDA #$07 immediate operand
  const BODY_IMM_OFFSET  = 19  // LDA #$08 immediate operand
  const RIGHT_IMM_OFFSET = 30  // LDA #$09 immediate operand

  function romWithHandlerBytes(left: number, body: number, right: number): RomFile {
    const rom = makeMockRom({})
    rom.writeAt(HANDLER_ADDR + LEFT_IMM_OFFSET,  [left])
    rom.writeAt(HANDLER_ADDR + BODY_IMM_OFFSET,  [body])
    rom.writeAt(HANDLER_ADDR + RIGHT_IMM_OFFSET, [right])
    return rom
  }

  it('W=1 emits just the cap pair [$107, $109] (no body)', () => {
    const grid = createGrid(1)
    const rom = romWithHandlerBytes(0x07, 0x08, 0x09)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 4, 2, 10, 0x3B, 0x01)
    handle_0DEDB9(cur)
    expect(grid[10][2]).toBe(P1(0x07))
    expect(grid[10][3]).toBe(P1(0x09))
    expect(grid[10][1]).toBe(TILE_EMPTY)
    expect(grid[10][4]).toBe(TILE_EMPTY)
  })

  it('W=2 emits [$107, $108, $109]', () => {
    const grid = createGrid(1)
    const rom = romWithHandlerBytes(0x07, 0x08, 0x09)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 4, 5, 10, 0x3B, 0x02)
    handle_0DEDB9(cur)
    expect(grid[10][5]).toBe(P1(0x07))
    expect(grid[10][6]).toBe(P1(0x08))
    expect(grid[10][7]).toBe(P1(0x09))
    expect(grid[10][8]).toBe(TILE_EMPTY)
  })

  it('W=4 emits [$107, $108, $108, $108, $109] (3 body tiles)', () => {
    const grid = createGrid(1)
    const rom = romWithHandlerBytes(0x07, 0x08, 0x09)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 4, 0, 12, 0x3B, 0x04)
    handle_0DEDB9(cur)
    expect(grid[12][0]).toBe(P1(0x07))
    expect(grid[12][1]).toBe(P1(0x08))
    expect(grid[12][2]).toBe(P1(0x08))
    expect(grid[12][3]).toBe(P1(0x08))
    expect(grid[12][4]).toBe(P1(0x09))
    expect(grid[12][5]).toBe(TILE_EMPTY)
  })

  it('ignores the high nibble of the size byte', () => {
    const grid = createGrid(1)
    const rom = romWithHandlerBytes(0x07, 0x08, 0x09)
    // size = $F2 → H=15 W=2; result must match W=2 above.
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 4, 1, 8, 0x3B, 0xF2)
    handle_0DEDB9(cur)
    expect(grid[8][1]).toBe(P1(0x07))
    expect(grid[8][2]).toBe(P1(0x08))
    expect(grid[8][3]).toBe(P1(0x09))
    // No rows above/below.
    expect(grid[7][1]).toBe(TILE_EMPTY)
    expect(grid[9][1]).toBe(TILE_EMPTY)
  })

  it('resolves cap/body tiles from handler bytecode (tolerates relocated imms)', () => {
    const grid = createGrid(1)
    const rom = romWithHandlerBytes(0xAA, 0xBB, 0xCC)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 4, 0, 0, 0x3B, 0x02)
    handle_0DEDB9(cur)
    expect(grid[0][0]).toBe(P1(0xAA))
    expect(grid[0][1]).toBe(P1(0xBB))
    expect(grid[0][2]).toBe(P1(0xCC))
  })
})

// ── CODE_0DDCEA (tileset 9-14, object $3D: fill + distinct bottom row) ────────

describe('handle_0DDCEA (filled rect with distinct bottom row, object $3D)', () => {
  const HANDLER_ADDR = 0x0DDCEA
  // Operand offsets inside the handler body for the body / bottom LDA #$imm.
  const BODY_IMM_OFFSET   = 29  // $A9 $65 → body tile (size = 1 byte)
  const BOTTOM_IMM_OFFSET = 52  // $A9 $4E → bottom tile

  function romWithHandlerBytes(bodyTile: number, bottomTile: number): RomFile {
    const rom = makeMockRom({})
    rom.writeAt(HANDLER_ADDR + BODY_IMM_OFFSET, [bodyTile])
    rom.writeAt(HANDLER_ADDR + BOTTOM_IMM_OFFSET, [bottomTile])
    return rom
  }

  it('H=0 draws only the bottom row (width W+1, page 1)', () => {
    const grid = createGrid(1)
    const rom = romWithHandlerBytes(0x65, 0x4E)
    // size = $06 → H=0 W=6 → single row of bottomTile, width 7.
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 9, 2, 10, 0x3D, 0x06)
    handle_0DDCEA(cur)
    for (let c = 2; c <= 8; c++) expect(grid[10][c]).toBe(P1(0x4E))
    expect(grid[10][1]).toBe(TILE_EMPTY)
    expect(grid[10][9]).toBe(TILE_EMPTY)
    expect(grid[9][2]).toBe(TILE_EMPTY)
  })

  it('H>0 draws H rows of body tile + one bottom row', () => {
    const grid = createGrid(1)
    const rom = romWithHandlerBytes(0x65, 0x4E)
    // size = $21 → H=2 W=1 → 2 rows of bodyTile + 1 row of bottomTile, width 2.
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 9, 0, 4, 0x3D, 0x21)
    handle_0DDCEA(cur)
    for (let r = 4; r <= 5; r++) {
      expect(grid[r][0]).toBe(P1(0x65))
      expect(grid[r][1]).toBe(P1(0x65))
    }
    expect(grid[6][0]).toBe(P1(0x4E))
    expect(grid[6][1]).toBe(P1(0x4E))
    expect(grid[7][0]).toBe(TILE_EMPTY)
  })

  it('resolves body/bottom tiles from handler bytecode (tolerates relocated imms)', () => {
    const grid = createGrid(1)
    // Simulate a ROM hack that used different body/bottom tiles by rewriting the
    // LDA #$imm operand bytes. Handler must pick these up.
    const rom = romWithHandlerBytes(0xAA, 0xBB)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 9, 0, 0, 0x3D, 0x10)
    handle_0DDCEA(cur)
    expect(grid[0][0]).toBe(P1(0xAA))
    expect(grid[1][0]).toBe(P1(0xBB))
  })
})

// ── CODE_0DDD2E (tileset 9-14, object $3E: vertical pillar) ───────────────────

describe('handle_0DDD2E (vertical pillar, object $3E)', () => {
  const HANDLER_ADDR = 0x0DDD2E
  const BODY_LDA_OFFSET   = 23  // LDA.L DATA_0DDD26,X operand
  const BOTTOM_LDA_OFFSET = 39  // LDA.L DATA_0DDD2A,X operand

  function romWithPillarTables(): RomFile {
    const rom = makeMockRom({})
    // Vanilla-style tables: 4 variants each.
    const addrBody   = 0x0DDD26
    const addrBottom = 0x0DDD2A
    rom.writeAt(addrBody,   [0x50, 0x50, 0x51, 0x51])
    rom.writeAt(addrBottom, [0x4D, 0x50, 0x4F, 0x51])
    stampLongOperand(rom, HANDLER_ADDR, BODY_LDA_OFFSET,   addrBody)
    stampLongOperand(rom, HANDLER_ADDR, BOTTOM_LDA_OFFSET, addrBottom)
    return rom
  }

  it('H=0 V=0 draws a single bottom tile', () => {
    const grid = createGrid(1)
    const rom = romWithPillarTables()
    // size = $00 → H=0 V=0 → 1 bottom tile at cursor row.
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 9, 3, 6, 0x3E, 0x00)
    handle_0DDD2E(cur)
    expect(grid[6][3]).toBe(P1(0x4D))
    expect(grid[7][3]).toBe(TILE_EMPTY)
  })

  it('H=3 V=2 stacks 3 body tiles above the bottom tile', () => {
    const grid = createGrid(1)
    const rom = romWithPillarTables()
    // size = $32 → H=3 V=2 → 3 body + 1 bottom.
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 9, 0, 0, 0x3E, 0x32)
    handle_0DDD2E(cur)
    expect(grid[0][0]).toBe(P1(0x51))   // body tile (variant 2 of DATA_0DDD26)
    expect(grid[1][0]).toBe(P1(0x51))
    expect(grid[2][0]).toBe(P1(0x51))
    expect(grid[3][0]).toBe(P1(0x4F))   // bottom tile (variant 2 of DATA_0DDD2A)
    expect(grid[4][0]).toBe(TILE_EMPTY)
    expect(grid[0][1]).toBe(TILE_EMPTY) // no horizontal spread
  })
})

// ── CODE_0DE135 (tileset 9-14, object $36: three-part rectangle) ──────────────

describe('handle_0DE135 (three-part rect, object $36)', () => {
  const HANDLER_ADDR = 0x0DE135
  const LEFT_LDA_OFFSET   = 29  // LDA.L DATA_0DE12C,X
  const MIDDLE_LDA_OFFSET = 42  // LDA.L DATA_0DE12F,X
  const RIGHT_LDA_OFFSET  = 56  // LDA.L DATA_0DE132,X

  function romWithBoxTables(): RomFile {
    const rom = makeMockRom({})
    const addrLeft   = 0x0DE12C
    const addrMid    = 0x0DE12F
    const addrRight  = 0x0DE132
    rom.writeAt(addrLeft,  [0x45, 0x50, 0x4D])    // top-L, mid-L, bot-L
    rom.writeAt(addrMid,   [0x00, 0xF0, 0x4E])    // top-M, mid-M, bot-M
    rom.writeAt(addrRight, [0x48, 0x51, 0x4F])    // top-R, mid-R, bot-R
    stampLongOperand(rom, HANDLER_ADDR, LEFT_LDA_OFFSET,   addrLeft)
    stampLongOperand(rom, HANDLER_ADDR, MIDDLE_LDA_OFFSET, addrMid)
    stampLongOperand(rom, HANDLER_ADDR, RIGHT_LDA_OFFSET,  addrRight)
    return rom
  }

  it('W=2 H=2 (size $22) paints a 3-wide × 3-tall framed box', () => {
    const grid = createGrid(1)
    const rom = romWithBoxTables()
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 9, 2, 4, 0x36, 0x22)
    handle_0DE135(cur)
    // Row 0 (X=0): top-L, top-M, top-R
    expect(grid[4][2]).toBe(P1(0x45))
    expect(grid[4][3]).toBe(P1(0x00))
    expect(grid[4][4]).toBe(P1(0x48))
    // Row 1 (X=1 middle): mid-L, mid-M, mid-R
    expect(grid[5][2]).toBe(P1(0x50))
    expect(grid[5][3]).toBe(P1(0xF0))
    expect(grid[5][4]).toBe(P1(0x51))
    // Row 2 (X=2 last): bot-L, bot-M, bot-R
    expect(grid[6][2]).toBe(P1(0x4D))
    expect(grid[6][3]).toBe(P1(0x4E))
    expect(grid[6][4]).toBe(P1(0x4F))
    // Bounds
    expect(grid[4][5]).toBe(TILE_EMPTY)
    expect(grid[3][2]).toBe(TILE_EMPTY)
    expect(grid[7][2]).toBe(TILE_EMPTY)
  })

  it('W=1 row emits left + right with no middle fill', () => {
    const grid = createGrid(1)
    const rom = romWithBoxTables()
    // size = $11 → W=1 H=1 → 2-wide × 2-tall box, no middle body tiles.
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 9, 0, 0, 0x36, 0x11)
    handle_0DE135(cur)
    expect(grid[0][0]).toBe(P1(0x45)) // top-L
    expect(grid[0][1]).toBe(P1(0x48)) // top-R (adjacent to left, no middle)
    expect(grid[1][0]).toBe(P1(0x4D)) // bot-L
    expect(grid[1][1]).toBe(P1(0x4F)) // bot-R
    expect(grid[0][2]).toBe(TILE_EMPTY)
  })

  it('H=0 draws a single top-row strip (no middle or bottom row)', () => {
    const grid = createGrid(1)
    const rom = romWithBoxTables()
    // size = $03 → H=0 W=3 → single top row with left + 2 middle + right (width 4).
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 9, 0, 0, 0x36, 0x03)
    handle_0DE135(cur)
    expect(grid[0][0]).toBe(P1(0x45))   // top-L
    expect(grid[0][1]).toBe(P1(0x00))   // top-M
    expect(grid[0][2]).toBe(P1(0x00))   // top-M
    expect(grid[0][3]).toBe(P1(0x48))   // top-R
    expect(grid[1][0]).toBe(TILE_EMPTY) // no row below
  })
})

// ── CODE_0DB604 (2:1 slope block, obj=$3C) ────────────────────────────────────

describe('handle_0DB604 (2:1 slope block, obj=$3C)', () => {
  const HANDLER_ADDR = 0x0DB604
  const DATA_ADDR    = 0x0DB5E8

  // DATA_0DB5E8/9/EA stream: 28 bytes matching vanilla ROM values.
  const TABLE = [
    0x07, 0x0A,                                                         // index 0,1
    0x0A, 0x08, 0x0A, 0x0A, 0x09, 0x81, 0x82, 0x83,                    // 2-9
    0x81, 0x82, 0x83, 0x81, 0x81, 0x25, 0x84, 0x81,                    // 10-17
    0x25, 0x84, 0x81, 0x81, 0x25, 0x84, 0x81, 0x25, 0x84, 0x81,        // 18-27
  ]

  function makeRom(): RomFile {
    const rom = makeMockRom({ [DATA_ADDR]: TABLE })
    // Stamp LDA.L DATA_0DB5E8,X operand at handler+$1D.
    stampLongOperand(rom, HANDLER_ADDR, 0x1D, DATA_ADDR)
    return rom
  }

  it('size=$02 (N=2) paints correct 7-wide × 4-row tile pattern', () => {
    const rom = makeRom()
    const grid = createGrid(4)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 0, 0, 0x3C, 0x02)
    handle_0DB604(cur)

    // Row 0 (page 1): indices 0-6
    expect(grid[0][0]).toBe(P1(0x07))
    expect(grid[0][1]).toBe(P1(0x0A))
    expect(grid[0][2]).toBe(P1(0x0A))
    expect(grid[0][3]).toBe(P1(0x08))
    expect(grid[0][4]).toBe(P1(0x0A))
    expect(grid[0][5]).toBe(P1(0x0A))
    expect(grid[0][6]).toBe(P1(0x09))

    // Row 1 (page 0): indices 7-13
    expect(grid[1][0]).toBe(0x81)
    expect(grid[1][1]).toBe(0x82)
    expect(grid[1][2]).toBe(0x83)
    expect(grid[1][3]).toBe(0x81)
    expect(grid[1][4]).toBe(0x82)
    expect(grid[1][5]).toBe(0x83)
    expect(grid[1][6]).toBe(0x81)

    // Row 2 (page 0): indices 14-20
    expect(grid[2][0]).toBe(0x81)
    expect(grid[2][1]).toBe(0x25)
    expect(grid[2][2]).toBe(0x84)
    expect(grid[2][3]).toBe(0x81)
    expect(grid[2][4]).toBe(0x25)
    expect(grid[2][5]).toBe(0x84)
    expect(grid[2][6]).toBe(0x81)

    // Row 3 (page 0): indices 21-27
    expect(grid[3][0]).toBe(0x81)
    expect(grid[3][1]).toBe(0x25)
    expect(grid[3][2]).toBe(0x84)
    expect(grid[3][3]).toBe(0x81)
    expect(grid[3][4]).toBe(0x25)
    expect(grid[3][5]).toBe(0x84)
    expect(grid[3][6]).toBe(0x81)

    // No spill into row 4.
    expect(grid[4]?.[0] ?? TILE_EMPTY).toBe(TILE_EMPTY)
  })

  it('size=$01 (N=1) paints a 4-wide × 4-row shape', () => {
    const rom = makeRom()
    const grid = createGrid(4)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 0, 0, 0x3C, 0x01)
    handle_0DB604(cur)
    // With N=1: first loop=3 tiles, no middle loop, cap=1 → 4 tiles per row.
    // Row 0 (page 1): TABLE[0..2], skip to TABLE[3] for cap (X+=3 after first loop).
    // But wait: N=1, _0=1. After first loop (X=0→3), DEC _2 (1→0), BEQ → skip middle.
    // CODE_0DB652: X+=3→6, write TABLE[6]=$09 (page 1). X++=7.
    expect(grid[0][0]).toBe(P1(0x07))  // TABLE[0]
    expect(grid[0][1]).toBe(P1(0x0A))  // TABLE[1]
    expect(grid[0][2]).toBe(P1(0x0A))  // TABLE[2]
    expect(grid[0][3]).toBe(P1(0x09))  // TABLE[6] (skip 3,4,5)
    expect(grid[0][4]).toBe(TILE_EMPTY)  // not written
  })
})

// ── CODE_0DBB2C (2-wide vertical slope pillar, obj=$30) ──────────────────────

describe('handle_0DBB2C (2-wide vertical pillar, obj=$30)', () => {
  it('size=$00 (X=0) draws only header row ($161, $162), no body', () => {
    const rom = makeMockRom()
    const grid = createGrid(3)
    const cur = makeCursorForHandler(0x0DBB2C, grid, rom, 0, 2, 5, 0x30, 0x00)
    handle_0DBB2C(cur)
    expect(grid[5][2]).toBe(P1(0x61))  // header left
    expect(grid[5][3]).toBe(P1(0x62))  // header right
    expect(grid[6][2]).toBe(TILE_EMPTY)  // no body rows (X=0, loop runs 0 times)
    expect(grid[6][3]).toBe(TILE_EMPTY)
  })

  it('size=$20 (X=2) draws header + 2 body rows', () => {
    const rom = makeMockRom()
    const grid = createGrid(5)
    const cur = makeCursorForHandler(0x0DBB2C, grid, rom, 0, 0, 0, 0x30, 0x20)
    handle_0DBB2C(cur)
    // Header row (row 0):
    expect(grid[0][0]).toBe(P1(0x61))
    expect(grid[0][1]).toBe(P1(0x62))
    // Body row 1:
    expect(grid[1][0]).toBe(P1(0x63))
    expect(grid[1][1]).toBe(P1(0x64))
    // Body row 2:
    expect(grid[2][0]).toBe(P1(0x63))
    expect(grid[2][1]).toBe(P1(0x64))
    // No body row 3:
    expect(grid[3][0]).toBe(TILE_EMPTY)
  })

  it('size=$80 (X=8) draws header + 8 body rows (9 total rows)', () => {
    const rom = makeMockRom()
    const grid = createGrid(15)
    const cur = makeCursorForHandler(0x0DBB2C, grid, rom, 0, 0, 0, 0x30, 0x80)
    handle_0DBB2C(cur)
    expect(grid[0][0]).toBe(P1(0x61))  // header
    for (let r = 1; r <= 8; r++) {
      expect(grid[r][0]).toBe(P1(0x63))  // body left
      expect(grid[r][1]).toBe(P1(0x64))  // body right
    }
    expect(grid[9][0]).toBe(TILE_EMPTY)  // no more rows
  })
})

// ── CODE_0DBB63 (obj=$31: rect fill with DATA_0DA8B4[14]=$65, page 1) ────────

describe('handle_0DBB63 (rectangular fill using tile slot 14, obj=$31)', () => {
  // handle_0DBB63 reads DATA_0DA8B4 via CODE_0DA8C3's LDA.L operand at $0DA92F.
  const TABLE_ADDR = 0x0DA8B4  // vanilla location of DATA_0DA8B4
  const TILE_AT_14 = 0x65      // DATA_0DA8B4[14]

  function makeRom(): RomFile {
    // 15-entry table; index 14 = $65.
    const table = [0x02, 0x21, 0x23, 0x2A, 0x2B, 0x3F, 0x03, 0x13,
                   0x1E, 0x24, 0x2E, 0x2F, 0x30, 0x32, TILE_AT_14]
    const rom = makeMockRom({ [TABLE_ADDR]: table })
    // Stamp the LDA.L operand inside CODE_0DA8C3 at 0x0DA8C3 + 0x6C = 0x0DA92F.
    stampLongOperand(rom, 0x0DA8C3, 0x6C, TABLE_ADDR)
    return rom
  }

  it('size=$00 writes a single $165 at the cursor', () => {
    const rom = makeRom()
    const grid = createGrid(2)
    const cur = makeCursorForHandler(0x0DBB63, grid, rom, 0, 3, 5, 0x31, 0x00)
    handle_0DBB63(cur)
    expect(grid[5][3]).toBe(P1(TILE_AT_14))  // $165
    expect(grid[5][4]).toBe(TILE_EMPTY)
    expect(grid[6][3]).toBe(TILE_EMPTY)
  })

  it('size=$03 fills a 4-wide × 1-tall row of $165', () => {
    const rom = makeRom()
    const grid = createGrid(2)
    const cur = makeCursorForHandler(0x0DBB63, grid, rom, 0, 0, 0, 0x31, 0x03)
    handle_0DBB63(cur)
    for (let c = 0; c < 4; c++) expect(grid[0][c]).toBe(P1(TILE_AT_14))
    expect(grid[0][4]).toBe(TILE_EMPTY)
    expect(grid[1][0]).toBe(TILE_EMPTY)
  })

  it('size=$10 fills a 1-wide × 2-tall column of $165', () => {
    const rom = makeRom()
    const grid = createGrid(3)
    const cur = makeCursorForHandler(0x0DBB63, grid, rom, 0, 2, 0, 0x31, 0x10)
    handle_0DBB63(cur)
    expect(grid[0][2]).toBe(P1(TILE_AT_14))
    expect(grid[1][2]).toBe(P1(TILE_AT_14))
    expect(grid[2][2]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DC259 (ext $4B/$4C: coin block variant, missing handler) ────────────

describe('handle_0DC259 (coin block variant, ext $4B/$4C)', () => {
  // DATA_0DC257 = [$07, $08], immediately before CODE_0DC259.
  // LDA.L DATA_0DC257,X opcode at handler+11; 3-byte operand at handler+12.
  const HANDLER_ADDR = 0x0DC259
  const DATA_ADDR    = 0x0DC257   // DATA_0DC257 = [$07, $08]

  function setupRom(): RomFile {
    const rom = makeMockRom({ [DATA_ADDR]: [0x07, 0x08] })
    stampLongOperand(rom, HANDLER_ADDR, 12, DATA_ADDR)
    return rom
  }

  it('ext $4B writes $107 (page-1 tile $07) at cursor', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, setupRom(), 0, 5, 10, 0x4B, 0x4B)
    handle_0DC259(cur)
    expect(grid[10][5]).toBe(P1(0x07))
    expect(grid[10][6]).toBe(TILE_EMPTY)   // no advance
    expect(grid[11][5]).toBe(TILE_EMPTY)   // single tile, no row change
  })

  it('ext $4C writes $108 (page-1 tile $08) at cursor', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, setupRom(), 0, 3, 20, 0x4C, 0x4C)
    handle_0DC259(cur)
    expect(grid[20][3]).toBe(P1(0x08))
    expect(grid[20][4]).toBe(TILE_EMPTY)
  })

  it('out-of-range ext type emits nothing', () => {
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, setupRom(), 0, 0, 0, 0x4A, 0x4A)
    handle_0DC259(cur)
    expect(grid[0][0]).toBe(TILE_EMPTY)
  })
})

// ── handle_0DB49E (vertical pipe): pipe-bottom-meets-rope context merge ────────

describe('handle_0DB49E (vertical pipe) bottom-merge fix', () => {
  // Vanilla SNES addresses:
  //   CODE_0DB49E  $0DB49E  -- handler
  //   DATA_0DB49C  $0DB49C  -- pipe tile table [$0A, $0C]
  //   CODE_0DB4D9  $0DB4D9  -- top merge helper
  //   CODE_0DB4C0  $0DB4C0  -- body loop (JMP target from handler+22)
  //   CODE_0DB4FE  $0DB4FE  -- bottom merge helper (JMP target from CODE_0DB4C0+18)
  //   DATA_0DB4D5  $0DB4D5  -- top-merge table1 [$07, $09]
  //   DATA_0DB4D7  $0DB4D7  -- top-merge table2 [$1A, $19]
  //   DATA_0DB4FA  $0DB4FA  -- bottom-merge table1 [$0D, $0F]
  //   DATA_0DB4FC  $0DB4FC  -- bottom-merge table2 [$1C, $1B]
  const HANDLER   = 0x0DB49E
  const DATA_49C  = 0x0DB49C
  const TOP_MERGE = 0x0DB4D9
  const BODY_LOOP = 0x0DB4C0
  const BOT_MERGE = 0x0DB4FE
  const DATA_4D5  = 0x0DB4D5
  const DATA_4D7  = 0x0DB4D7
  const DATA_4FA  = 0x0DB4FA
  const DATA_4FC  = 0x0DB4FC

  function buildPipeRom(): RomFile {
    const rom = makeMockRom()

    // DATA_0DB49C = [$0A, $0C]
    rom.writeAt(DATA_49C, [0x0A, 0x0C])
    stampLongOperand(rom, HANDLER, 16, DATA_49C)

    // JSR CODE_0DB4D9 at handler+19: stamp 2-byte target in same bank ($0D)
    rom.writeAt(HANDLER + 20, [TOP_MERGE & 0xFF, (TOP_MERGE >> 8) & 0xFF])

    // JMP CODE_0DB4C0 at handler+22: 2-byte target
    rom.writeAt(HANDLER + 23, [BODY_LOOP & 0xFF, (BODY_LOOP >> 8) & 0xFF])

    // CODE_0DB4C0 layout (18 bytes before JMP CODE_0DB4FE):
    //   TYA CLC ADC#$10 TAY BCC(+2) JSR_CODE_0DA987 DEC_0 BNE LDA.L JMP
    // We only need to stamp:
    //   JMP CODE_0DB4FE at BODY_LOOP+18 (opcode $4C), operand at +19..+20
    rom.writeAt(BODY_LOOP + 19, [BOT_MERGE & 0xFF, (BOT_MERGE >> 8) & 0xFF])

    // Top merge helper CODE_0DB4D9:
    //   trigger1 = $08 at +5, table1 = DATA_0DB4D5 at +9..+11
    //   trigger2 = $0E at +16, table2 = DATA_0DB4D7 at +20..+22
    rom.writeAt(TOP_MERGE + 5, [0x08])
    stampLongOperand(rom, TOP_MERGE, 9, DATA_4D5)
    rom.writeAt(TOP_MERGE + 16, [0x0E])
    stampLongOperand(rom, TOP_MERGE, 20, DATA_4D7)
    rom.writeAt(DATA_4D5, [0x07, 0x09])
    rom.writeAt(DATA_4D7, [0x1A, 0x19])

    // Bottom merge helper CODE_0DB4FE:
    //   trigger1 = $0E at +5, table1 = DATA_0DB4FA at +9..+11
    //   trigger2 = $08 at +16, table2 = DATA_0DB4FC at +20..+22
    rom.writeAt(BOT_MERGE + 5, [0x0E])
    stampLongOperand(rom, BOT_MERGE, 9, DATA_4FA)
    rom.writeAt(BOT_MERGE + 16, [0x08])
    stampLongOperand(rom, BOT_MERGE, 20, DATA_4FC)
    rom.writeAt(DATA_4FA, [0x0D, 0x0F])
    rom.writeAt(DATA_4FC, [0x1C, 0x1B])

    return rom
  }

  it('plain pipe: no existing tile -- top and bottom both write base tile $0A', () => {
    // middleCount = 2, X = 0 → pipe tile = $0A. Rows: top=10, body=11, bottom=12.
    const grid = createGrid(1)
    const rom = buildPipeRom()
    const cur = makeCursorForHandler(HANDLER, grid, rom, 1, 5, 10, 31, 0x20)
    handle_0DB49E(cur)
    expect(grid[10][5]).toBe(0x0A)   // top (no existing → base tile, page 0)
    expect(grid[11][5]).toBe(0x0A)   // middle body row
    expect(grid[12][5]).toBe(0x0A)   // bottom (no existing → base tile, page 0)
    expect(grid[13][5]).toBe(TILE_EMPTY)
  })

  it('bottom merge: rope end ($0E) below pipe → produces merged tile $0D', () => {
    // Place a rope end tile at the pipe's bottom position, then run the pipe.
    // settings = 0x60 → middleCount=6, X=0 → pipe from row 14 to row 20.
    // Rope end tile $0E pre-written at (row=20, col=0).
    const grid = createGrid(1)
    grid[20][0] = 0x0E   // rope end tile at bottom of pipe
    const rom = buildPipeRom()
    const cur = makeCursorForHandler(HANDLER, grid, rom, 1, 0, 14, 31, 0x60)
    handle_0DB49E(cur)
    // Bottom at row 20: existing=$0E → trigger1 match → DATA_0DB4FA[0]=$0D
    expect(grid[20][0]).toBe(0x0D)
    // Top at row 14: no existing → base tile $0A
    expect(grid[14][0]).toBe(0x0A)
    // Middle row 15-19: base tile $0A
    for (let r = 15; r <= 19; r++) expect(grid[r][0]).toBe(0x0A)
  })

  it('top merge: existing $08 below pipe top → produces merged tile $07 (X=0)', () => {
    const grid = createGrid(1)
    grid[10][5] = 0x08   // existing $08 at top position
    const rom = buildPipeRom()
    // middleCount=1, X=0 → size=$10
    const cur = makeCursorForHandler(HANDLER, grid, rom, 1, 5, 10, 31, 0x10)
    handle_0DB49E(cur)
    // Top merge: existing=$08 → trigger1 match → DATA_0DB4D5[0]=$07
    expect(grid[10][5]).toBe(0x07)
  })
})

// ── CODE_0DED12 (ghost-house horizontal strip, tileset-5 object $37) ──────────
//
// Writes W+1 tiles: start + (W-1) body + end.  Tile IDs come from three 3-entry
// tables indexed by the high nibble X of the size byte.
// Identical LDA.L operand layout to handle_0DB5B7, plus the X-indexed lookup.

describe('handle_0DED12 (ghost-house horizontal strip, object $37)', () => {
  const HANDLER_ADDR = 0x0DED12
  // Place data tables well away from the handler body to avoid overlap with the
  // stampLongOperand patches at offsets +19, +29, +43 (0x0DED25–0x0DED45).
  const START_ADDR = 0x0DEE00   // DATA_0DED09 (test alias)
  const BODY_ADDR  = 0x0DEE10   // DATA_0DED0C (test alias)
  const END_ADDR   = 0x0DEE20   // DATA_0DED0F (test alias)

  function setupRom(startBytes: number[], bodyBytes: number[], endBytes: number[]): RomFile {
    const rom = makeMockRom({
      [START_ADDR]: startBytes,
      [BODY_ADDR]:  bodyBytes,
      [END_ADDR]:   endBytes,
    })
    stampLongOperand(rom, HANDLER_ADDR, 19, START_ADDR)
    stampLongOperand(rom, HANDLER_ADDR, 29, BODY_ADDR)
    stampLongOperand(rom, HANDLER_ADDR, 43, END_ADDR)
    return rom
  }

  // Tables have 3 entries (X=0,1,2). Use distinct values for clarity.
  const START = [0x82, 0x89, 0x88]
  const BODY  = [0x82, 0x8A, 0x88]
  const END   = [0x82, 0x8B, 0x88]

  it('W=3 X=0: writes start + 2 body + end from variant 0', () => {
    // size = 0x03 → W=3, X=0
    const rom = setupRom(START, BODY, END)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 5, 2, 10, 0x37, 0x03)
    handle_0DED12(cur)
    expect(grid[10][2]).toBe(0x82)   // start[0] = $82
    expect(grid[10][3]).toBe(0x82)   // body[0]  = $82
    expect(grid[10][4]).toBe(0x82)   // body[0]  = $82
    expect(grid[10][5]).toBe(0x82)   // end[0]   = $82
    expect(grid[10][6]).toBe(TILE_EMPTY)
  })

  it('W=1 X=1: writes start + end only (no body tiles)', () => {
    // size = 0x11 → W=1, X=1
    const rom = setupRom(START, BODY, END)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 5, 0, 5, 0x37, 0x11)
    handle_0DED12(cur)
    expect(grid[5][0]).toBe(0x89)    // start[1] = $89
    expect(grid[5][1]).toBe(0x8B)    // end[1]   = $8B
    expect(grid[5][2]).toBe(TILE_EMPTY)
  })

  it('W=2 X=2: uses variant 2 tile IDs', () => {
    // size = 0x22 → W=2, X=2
    const rom = setupRom(START, BODY, END)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 5, 4, 15, 0x37, 0x22)
    handle_0DED12(cur)
    expect(grid[15][4]).toBe(0x88)   // start[2] = $88
    expect(grid[15][5]).toBe(0x88)   // body[2]  = $88 (1 body tile)
    expect(grid[15][6]).toBe(0x88)   // end[2]   = $88
    expect(grid[15][7]).toBe(TILE_EMPTY)
  })

  it('does not write to adjacent rows', () => {
    const rom = setupRom(START, BODY, END)
    const grid = createGrid(2)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 5, 2, 10, 0x37, 0x03)
    handle_0DED12(cur)
    expect(grid[9][2]).toBe(TILE_EMPTY)
    expect(grid[11][2]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DB863 (diagonal staircase left-descending, tileset-5 object $3B) ────
//
// Two-phase diagonal staircase descending down-left. Phase 1 expands width; phase
// 2 continues as a constant-width tail. Smoke-tested for non-throw and for
// structural invariants (tile count grows with width/height).

describe('handle_0DB863 (diagonal staircase, object $3B)', () => {
  const HANDLER_ADDR = 0x0DB863

  function setupRom(): RomFile {
    const rom = makeMockRom()
    // 12 inline LDA #$XX immediates. Stamp a recognisable value at each offset.
    rom.writeAt(HANDLER_ADDR + 29,  [0xAF])   // tAF1 first-row slope
    rom.writeAt(HANDLER_ADDR + 37,  [0xAF])   // tAF2 first-row pipe
    rom.writeAt(HANDLER_ADDR + 48,  [0xA9])   // tA9a main-loop slope
    rom.writeAt(HANDLER_ADDR + 59,  [0x3F])   // t3Fa main-loop fill
    rom.writeAt(HANDLER_ADDR + 72,  [0xE4])   // tE4  main-loop E4
    rom.writeAt(HANDLER_ADDR + 80,  [0xAF])   // tAFb main-loop pipe
    rom.writeAt(HANDLER_ADDR + 107, [0xA9])   // tA9b phase1-end slope
    rom.writeAt(HANDLER_ADDR + 118, [0x3F])   // t3Fb phase1-end fill
    rom.writeAt(HANDLER_ADDR + 129, [0xF9])   // tF9  phase1-end cap
    rom.writeAt(HANDLER_ADDR + 140, [0xA9])   // tA9c phase2 slope
    rom.writeAt(HANDLER_ADDR + 151, [0x3F])   // t3Fc phase2 fill
    rom.writeAt(HANDLER_ADDR + 162, [0xAC])   // tAC  phase2 cap
    return rom
  }

  it('produces a non-empty staircase shape without throwing', () => {
    const rom = setupRom()
    const grid = createGrid(5)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 5, 40, 5, 0x3B, 0x22)
    expect(() => handle_0DB863(cur)).not.toThrow()
    let count = 0
    for (const row of grid) for (const t of row) if (t !== TILE_EMPTY) count++
    expect(count).toBeGreaterThan(0)
  })

  it('first row always starts with tAF1 (page 0)', () => {
    // The very first tile written is the first-row slope (tAF1).
    const rom = setupRom()
    const grid = createGrid(5)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 5, 30, 4, 0x3B, 0x11)
    handle_0DB863(cur)
    // The first tile is at the initial cursor position.
    expect(grid[4][30]).toBe(0xAF)
  })

  it('larger width produces more total tiles', () => {
    const rom = setupRom()
    function countTiles(size: number): number {
      const g = createGrid(6)
      const c = makeCursorForHandler(HANDLER_ADDR, g, rom, 5, 40, 3, 0x3B, size)
      handle_0DB863(c)
      let n = 0
      for (const row of g) for (const t of row) if (t !== TILE_EMPTY) n++
      return n
    }
    expect(countTiles(0x23)).toBeGreaterThan(countTiles(0x11))
  })

  it('each diagonal step is one row lower than the last', () => {
    // The last tile written to row R means row R+1 must have at least one tile.
    // Specifically, col descends so tiles spread across multiple rows.
    const rom = setupRom()
    const grid = createGrid(5)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 5, 40, 3, 0x3B, 0x21)
    handle_0DB863(cur)
    const rowsWithTiles = grid.filter(row => row.some(t => t !== TILE_EMPTY)).length
    expect(rowsWithTiles).toBeGreaterThan(1)
  })
})

describe('handle_0DDAF2 (diagonal cliff staircase dispatcher, object $39)', () => {
  const HANDLER_ADDR = 0x0DDAF2

  function makeCur(size: number, col = 10, row = 2): ReturnType<typeof makeCursorForHandler> {
    const rom = makeMockRom()
    const grid = createGrid(5)
    return makeCursorForHandler(HANDLER_ADDR, grid, rom, 3, col, row, 0x39, size)
  }

  // ── Variant dispatch ──────────────────────────────────────────────────────

  it('variant 00 (bits 00): first tile is page-1 $D2 at origin', () => {
    const cur = makeCur(0x10)   // low 2 bits = 0x00
    handle_0DDAF2(cur)
    // First tile written is p1:$D2 at (col=10, row=2).
    expect(cur.grid[2][10]).toBe(P1(0xD2))
  })

  it('variant 01 (bits 01): first tile is page-1 $D6 at origin', () => {
    const cur = makeCur(0x11)   // low 2 bits = 0x01
    handle_0DDAF2(cur)
    expect(cur.grid[2][10]).toBe(P1(0xD6))
  })

  it('variant 10 (bits 10): first tile is page-1 $D4 at origin', () => {
    const cur = makeCur(0x12)   // low 2 bits = 0x02
    handle_0DDAF2(cur)
    expect(cur.grid[2][10]).toBe(P1(0xD4))
  })

  it('variant 11 (bits 11): first tile is page-1 $D7 at origin', () => {
    const cur = makeCur(0x13)   // low 2 bits = 0x03
    handle_0DDAF2(cur)
    expect(cur.grid[2][10]).toBe(P1(0xD7))
  })

  // ── Variant 00 (CODE_0DDB06) ──────────────────────────────────────────────

  describe('variant 00 (CODE_0DDB06): 2-wide left-descending staircase', () => {
    it('row 0 is only 2 tiles: $D2 and $D3', () => {
      // _0 = (size>>4)+1 = 1+1 = 2, so there are enough rows to test.
      // With size=0x10 (_0=2), rows: row 0 has $D2/$D3, row 1 is diagonal step.
      const cur = makeCur(0x10, 10, 0)
      handle_0DDAF2(cur)
      // Row 0: expect $D2 at col 10, $D3 at col 11, nothing at col 12.
      expect(cur.grid[0][10]).toBe(P1(0xD2))
      expect(cur.grid[0][11]).toBe(P1(0xD3))
      expect(cur.grid[0][12]).toBe(TILE_EMPTY)
    })

    it('row 1 starts 2 cols left of origin (diagonal -2 step)', () => {
      // After the diagonal step (col-=2, row+=1), iteration 2 starts at col 8.
      const cur = makeCur(0x20, 10, 0)   // _0=3: 3 main rows + final row
      handle_0DDAF2(cur)
      // Row 1: should have tiles starting at col 8.
      expect(cur.grid[1][8]).toBe(P1(0xD2))
      expect(cur.grid[1][9]).toBe(P1(0xD3))
    })

    it('BEQ final row written at diagCol (same as origin when _0=1)', () => {
      // With _0=1 (size>>4=0): only 1 main-loop iteration (row 0), then BEQ fires.
      // BEQ path: row++, write $FB/$FF fill at diagCol=10 (no diagonal step taken).
      const cur = makeCur(0x00, 10, 0)   // _0 = (0)+1 = 1
      handle_0DDAF2(cur)
      // Row 0: $D2/$D3 at col 10.
      expect(cur.grid[0][10]).toBe(P1(0xD2))
      expect(cur.grid[0][11]).toBe(P1(0xD3))
      // Row 1 (BEQ final row at bookmarkCol=10): _2=3 at this point, xFinal=1.
      // CODE_0DDB31 with xFinal=1: $FB, $FF, DEX→0; CODE_0DDB4D: DEX→-1 stop.
      expect(cur.grid[1][10]).toBe(P1(0xFB))
      expect(cur.grid[1][11]).toBe(P1(0xFF))
    })

    it('larger height produces more rows', () => {
      function rowCount(sizeH: number): number {
        const c = makeCur((sizeH << 4) | 0x00, 20, 0)
        handle_0DDAF2(c)
        return c.grid.filter(r => r.some(t => t !== TILE_EMPTY)).length
      }
      expect(rowCount(2)).toBeGreaterThan(rowCount(1))
    })
  })

  // ── Variant 01 (CODE_0DDB8F) ──────────────────────────────────────────────

  describe('variant 01 (CODE_0DDB8F): 1-wide left-descending staircase', () => {
    it('row 0 is only 1 tile: $D6', () => {
      // _2 starts at 0; iteration 0 writes $D6 then CODE_0DDBAE: DEX→-1 → BMI.
      const cur = makeCur(0x11, 10, 0)   // _0=2, variant 01
      handle_0DDAF2(cur)
      expect(cur.grid[0][10]).toBe(P1(0xD6))
      expect(cur.grid[0][11]).toBe(TILE_EMPTY)
    })

    it('row 1 starts 1 col left of origin (diagonal -1 step)', () => {
      const cur = makeCur(0x21, 10, 0)   // _0=3
      handle_0DDAF2(cur)
      expect(cur.grid[1][9]).toBe(P1(0xD6))
    })

    it('row 1 has D6 + FD (fill tile)', () => {
      // After diagonal step to col 9: _2=1, X=1 after DEX → not BMI.
      // Writes $FD, then DEX→0, CODE_0DDBC4: DEX→-1, stop.
      const cur = makeCur(0x11, 10, 0)   // _0=2
      handle_0DDAF2(cur)
      // Row 1 starts at col 9 (10 - 1 step).
      expect(cur.grid[1][9]).toBe(P1(0xD6))
      expect(cur.grid[1][10]).toBe(P1(0xFD))
    })

    it('BEQ final row: writes fill at diagCol (same as origin when _0=1)', () => {
      // _0=1: 1 main loop iteration → BEQ CODE_0DDBF9.
      // CODE_0DDBF9: X=_2=1, row++, JMP CODE_0DDBAE: DEX→0 (not BMI).
      // Writes $FD at diagCol=10 (no diagonal step taken for _0=1).
      const cur = makeCur(0x01, 10, 0)   // low2=01, size>>4=0 → _0=1
      handle_0DDAF2(cur)
      expect(cur.grid[0][10]).toBe(P1(0xD6))
      expect(cur.grid[1][10]).toBe(P1(0xFD))
    })
  })

  // ── Variant 10 (ADDR_0DDC02) ─────────────────────────────────────────────

  describe('variant 10 (ADDR_0DDC02): 2-wide right-growing staircase', () => {
    it('_0=1: row 0 gets $D4/$D5, row 1 gets $FF/$FC', () => {
      // size=0x02 → low2=10, size>>4=0 → _0=1.
      // ADDR_0DDC3D: write $D4(C0), $D5(C0+1), restoreBookmark, row++, _2=3, DEC _0→0, BPL→ADDR_0DDC23.
      // ADDR_0DDC23 (X=3): no loop, write $FF(C0), $FC(C0+1). _0=0→return.
      const cur = makeCur(0x02, 10, 0)
      handle_0DDAF2(cur)
      expect(cur.grid[0][10]).toBe(P1(0xD4))
      expect(cur.grid[0][11]).toBe(P1(0xD5))
      expect(cur.grid[1][10]).toBe(P1(0xFF))
      expect(cur.grid[1][11]).toBe(P1(0xFC))
      expect(cur.grid[1][12]).toBe(TILE_EMPTY)
    })

    it('_0=2: each row extends 2 tiles rightward', () => {
      // size=0x12 → _0=2.
      // Row 0: $D4(10), $D5(11). Row 1: $FF(10), $FC(11), $D4(12), $D5(13). Row 2: $FF(10), $FF(11), $FF(12), $FC(13).
      const cur = makeCur(0x12, 10, 0)
      handle_0DDAF2(cur)
      expect(cur.grid[0][10]).toBe(P1(0xD4))
      expect(cur.grid[0][11]).toBe(P1(0xD5))
      expect(cur.grid[1][10]).toBe(P1(0xFF))
      expect(cur.grid[1][11]).toBe(P1(0xFC))
      expect(cur.grid[1][12]).toBe(P1(0xD4))
      expect(cur.grid[1][13]).toBe(P1(0xD5))
      expect(cur.grid[2][10]).toBe(P1(0xFF))
      expect(cur.grid[2][11]).toBe(P1(0xFF))
      expect(cur.grid[2][12]).toBe(P1(0xFF))
      expect(cur.grid[2][13]).toBe(P1(0xFC))
    })
  })

  // ── Variant 11 (CODE_0DDC61) ─────────────────────────────────────────────

  describe('variant 11 (CODE_0DDC61): 1-wide right-growing staircase', () => {
    it('_0=1: row 0 gets $D7, row 1 gets $FE', () => {
      // size=0x03 → _0=1.
      // CODE_0DDC8E: _0=1≠0, write $D7(10,R0), restoreBookmark, row++, _2=1, X=1, DEC _0→0, BPL.
      // CODE_0DDC82: X=1, no $FF, write $FE(10,R1). Fall through to CODE_0DDC8E: _0=0 → return.
      const cur = makeCur(0x03, 10, 0)
      handle_0DDAF2(cur)
      expect(cur.grid[0][10]).toBe(P1(0xD7))
      expect(cur.grid[1][10]).toBe(P1(0xFE))
      expect(cur.grid[1][11]).toBe(TILE_EMPTY)
    })

    it('_0=2: row 1 has $FE+$D7, row 2 has $FF+$FE', () => {
      // size=0x13 → _0=2.
      // Row 0: $D7(10,R0). Row 1: $FE(10,R1), $D7(11,R1). Row 2: $FF(10,R2), $FE(11,R2). _0=0→return.
      const cur = makeCur(0x13, 10, 0)
      handle_0DDAF2(cur)
      expect(cur.grid[0][10]).toBe(P1(0xD7))
      expect(cur.grid[1][10]).toBe(P1(0xFE))
      expect(cur.grid[1][11]).toBe(P1(0xD7))
      expect(cur.grid[2][10]).toBe(P1(0xFF))
      expect(cur.grid[2][11]).toBe(P1(0xFE))
      expect(cur.grid[2][12]).toBe(TILE_EMPTY)
    })

    it('_0=3: row 2 has $FF+$FE+$D7, row 3 has $FF+$FF+$FE', () => {
      const cur = makeCur(0x23, 10, 0)
      handle_0DDAF2(cur)
      expect(cur.grid[2][10]).toBe(P1(0xFF))
      expect(cur.grid[2][11]).toBe(P1(0xFE))
      expect(cur.grid[2][12]).toBe(P1(0xD7))
      expect(cur.grid[3][10]).toBe(P1(0xFF))
      expect(cur.grid[3][11]).toBe(P1(0xFF))
      expect(cur.grid[3][12]).toBe(P1(0xFE))
      expect(cur.grid[3][13]).toBe(TILE_EMPTY)
    })
  })
})
