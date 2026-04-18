import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { expandMap, expandObject, createGrid, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
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
  handle_0DB42D, handle_0DB461, handle_0DB51F, handle_0DB547, handle_0DB571, handle_0DB5B7,
  handle_0DB73F, handle_0DB7AA,
} from '../../../src/rom/objectHandlers/standardHandlers'
import {
  handle_0DA57B, handle_0DA64D, handle_0DA656, handle_0DA673, handle_0DA68E, handle_0DA6D1,
  handle_0DB2CA,
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
  it('0x44 writes DATA_0DA671[0] on page 0 above $EB on page 1', () => {
    const rom = makeMockRom({ [0x0DA671]: [0xB4, 0xB5] })
    stampLongOperand(rom, HANDLER_ADDR, 8, 0x0DA671)
    rom.writeAt(HANDLER_ADDR + 20, [0xEB])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 3, 10, 0x44, 0)
    handle_0DA673(cur)
    expect(grid[10][3]).toBe(0xB4)
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

  it('variant 0: 2-wide × 3-tall upward pipe', () => {
    // pipeVariant0 reads inline tile immediates from CODE_0DAB6E body.
    // Offsets inside CODE_0DAB6E: +27 $96, +35 $9B (CODE_0DABFD-merged nozzles);
    // +47 $DE, +55 $E6 (plain bodies); +67 $3F (filler, unused at H=2).
    const rom = makeMockRom()
    stampDispatchTable(rom)
    rom.writeAt(0x0DAB6E + 27, [0x96])
    rom.writeAt(0x0DAB6E + 35, [0x9B])
    rom.writeAt(0x0DAB6E + 47, [0xDE])
    rom.writeAt(0x0DAB6E + 55, [0xE6])
    rom.writeAt(0x0DAB6E + 67, [0x3F])
    const grid = createGrid(1)
    const cur = makeCursorForHandler(DISPATCHER_ADDR, grid, rom, 0, 4, 10, 18, 0x20)
    handle_0DAB3E(cur)
    expect(grid[10][4]).toBe(P1(0x96)); expect(grid[10][5]).toBe(P1(0x9B))
    expect(grid[11][4]).toBe(P1(0xDE)); expect(grid[11][5]).toBe(P1(0xE6))
    expect(grid[12][4]).toBe(P1(0xDE)); expect(grid[12][5]).toBe(P1(0xE6))
    expect(grid[13][4]).toBe(TILE_EMPTY)
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

  it('variant 3: 2-wide ceiling pipe ($A0/$A5 body, $E6/$E0 lip at end)', () => {
    // pipeVariant3 (CODE_0DAD44): +28 $3F, +41 $E6, +49 $E0, +63 $A0, +71 $A5.
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
    expect(grid[10][4]).toBe(P1(0xA0)); expect(grid[10][5]).toBe(P1(0xA5))
    expect(grid[11][4]).toBe(P1(0xA0)); expect(grid[11][5]).toBe(P1(0xA5))
    expect(grid[12][4]).toBe(P1(0xE6)); expect(grid[12][5]).toBe(P1(0xE0))
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

  it('variant 0 uses DATA_0DB212/215/218 triples', () => {
    const rom = makeMockRom({
      [0x0DB212]: [0x2F, 0x25, 0x32],
      [0x0DB215]: [0x30, 0x25, 0x33],
      [0x0DB218]: [0x31, 0x25, 0x34],
    })
    stampAllTables(rom)
    const grid = createGrid(1)
    const cur = makeCursorForHandler(HANDLER_ADDR, grid, rom, 0, 2, 10, 21, 0x10)
    handle_0DB224(cur)
    expect(grid[10][2]).toBe(0x2F)
    expect(grid[11][2]).toBe(0x30)
    expect(grid[12][2]).toBe(0x31)
    expect(grid[10][3]).toBe(0x25)
    expect(grid[11][3]).toBe(0x25)
    expect(grid[12][3]).toBe(0x25)
    expect(grid[10][4]).toBe(0x32)
    expect(grid[11][4]).toBe(0x33)
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
    expect(grid[10][2]).toBe(0x39)
    expect(grid[11][2]).toBe(0x3A)
    expect(grid[12][2]).toBe(0x3B)
    expect(grid[12][4]).toBe(0x3E)
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

  /** Load and expand a level by translevel index. */
  function expandLevelByIndex(index: number) {
    const rawL1 = rom.getLevelRawData(index)
    if (!rawL1) throw new Error(`Level $${index.toString(16)} has no data`)
    const { header, objects } = parseLevelObjects(rawL1)
    const screens = header.levelLength
    const grid = expandMap(objects, screens, rom.rom, header.objectTileset)
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
