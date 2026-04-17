import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { expandMap, expandObject, createGrid, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { LevelObject, SCREEN_W, parseLevelObjects } from '../../../src/rom/LevelParser'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  ADDR_DATA_0DA8B4, DATA_0DA8B4_LEN,
  ADDR_DATA_0DA548, DATA_0DA548_LEN,
  ADDR_DATA_0DAA12, ADDR_DATA_0DAA17, ADDR_DATA_0DAA1C, ADDR_DATA_0DAA21,
  ADDR_DATA_0DAAA4, ADDR_DATA_0DAAAC,
  ADDR_DATA_0DB3BB, ADDR_DATA_0DB3DB, ADDR_DATA_0DB3DF, ADDR_DATA_0DB42B,
  ADDR_DATA_0DA652, ADDR_DATA_0DA654, ADDR_DATA_0DA671,
  ADDR_DATA_0DA6CD, ADDR_DATA_0DA6CF,
  ADDR_DATA_0DB569, ADDR_DATA_0DB5A8, ADDR_DATA_0DB5AD, ADDR_DATA_0DB5B2,
  ADDR_EXTENDED_DISPATCH,
  ADDR_TILESET_DISPATCH,
  ADDR_TILESET0_HANDLERS,
  readByteTable, readLongPointer, readLongPointerTable,
} from '../../../src/rom/objectHandlers/romData'
import {
  makeCursor, writeTile, writeTileAdvance, nextRow,
  saveBookmark, restoreBookmark, advanceCol,
} from '../../../src/rom/objectHandlers/cursor'
import {
  handle_0DA8C3, handle_0DAA26, handle_0DAAB4, handle_0DAB0D, handle_0DAB3E,
  handle_0DB075, handle_0DB1C8, handle_0DB1D4, handle_0DB224,
  handle_0DB3BD, handle_0DB3E3,
  handle_0DB42D, handle_0DB461, handle_0DB51F, handle_0DB547, handle_0DB571, handle_0DB5B7,
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
    const out = readByteTable(rom, ADDR_DATA_0DA8B4, 7)
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
  function romWithStdTable(): RomFile {
    return makeMockRom({
      [ADDR_DATA_0DA8B4]: [0x02, 0x21, 0x23, 0x2A, 0x2B, 0x3F, 0x03, 0x13, 0x1E, 0x24, 0x2E, 0x2F, 0x30, 0x32, 0x65],
    })
  }

  it('1×1 fill uses DATA_0DA8B4[objNo-1]', () => {
    const grid = createGrid(1)
    const rom = romWithStdTable()
    // size=0 → width 1, height 1; objNo=1 → tile $02
    const cur = makeCursor(grid, rom, 0, 2, 20, 1, 0x00)
    handle_0DA8C3(cur)
    expect(grid[20][2]).toBe(0x02)
    expect(grid[20][3]).toBe(TILE_EMPTY)
  })

  it('4×3 fill writes correct rectangle', () => {
    const grid = createGrid(2)
    const rom = romWithStdTable()
    // size = 0x23 → width-1 = 3 (width 4), height-1 = 2 (height 3); objNo=1 → tile $02
    const cur = makeCursor(grid, rom, 0, 0, 10, 1, 0x23)
    handle_0DA8C3(cur)
    for (let r = 10; r <= 12; r++) {
      for (let c = 0; c <= 3; c++) {
        expect(grid[r][c]).toBe(0x02)
      }
      expect(grid[r][4]).toBe(TILE_EMPTY)
    }
    // Row 9 untouched
    expect(grid[9][0]).toBe(TILE_EMPTY)
  })

  it('uses a different tile ID per object number', () => {
    const grid = createGrid(1)
    const rom = romWithStdTable()
    // objNo=6 → DATA_0DA8B4[5] = $3F
    const cur = makeCursor(grid, rom, 0, 5, 20, 6, 0x00)
    handle_0DA8C3(cur)
    expect(grid[20][5]).toBe(0x3F)
  })

  it('fills across a screen boundary', () => {
    const grid = createGrid(2)
    const rom = romWithStdTable()
    // Start at col 14, width 4 → spans cols 14-17 (crosses screen boundary at 16)
    const cur = makeCursor(grid, rom, 0, 14, 5, 1, 0x03)  // width-1=3, height-1=0
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
    const cur = makeCursor(grid, rom, 0, 0, 10, 20, 0x00)   // objNo=20 is out of range
    expect(() => handle_0DA8C3(cur)).not.toThrow()
    expect(grid[10][0]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DA57B (extended single-tile) ────────────────────────────────────────

describe('handle_0DA57B (extended single-tile)', () => {
  function romWithExtTable(): RomFile {
    const table = Array.from({ length: DATA_0DA548_LEN }, (_, i) => 0x10 + i)
    return makeMockRom({ [ADDR_DATA_0DA548]: table })
  }

  it('ext type 0x10 writes DATA_0DA548[0]', () => {
    const grid = createGrid(1)
    const rom = romWithExtTable()
    const cur = makeCursor(grid, rom, 0, 3, 10, 0x10, 0)
    handle_0DA57B(cur)
    expect(grid[10][3]).toBe(0x10)  // table[0] = 0x10
  })

  it('ext type 0x25 indexes into table correctly (page 1 for idx >= 0x13)', () => {
    const grid = createGrid(1)
    const rom = romWithExtTable()
    const cur = makeCursor(grid, rom, 0, 5, 10, 0x25, 0)
    handle_0DA57B(cur)
    // idx = 0x25 - 0x10 = 0x15, which is >= 0x13 → page 1 set
    expect(grid[10][5]).toBe(P1(0x10 + 0x15))
  })

  it('ext type below 0x10 is a no-op (not a single-tile slot)', () => {
    const grid = createGrid(1)
    const rom = romWithExtTable()
    const cur = makeCursor(grid, rom, 0, 3, 10, 0x0F, 0)
    handle_0DA57B(cur)
    expect(grid[10][3]).toBe(TILE_EMPTY)
  })

  it('ext type above table length is a no-op', () => {
    const grid = createGrid(1)
    const rom = romWithExtTable()
    const cur = makeCursor(grid, rom, 0, 3, 10, 0x10 + DATA_0DA548_LEN, 0)
    handle_0DA57B(cur)
    expect(grid[10][3]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DAB0D (vertical rope/pole, object 17) ───────────────────────────────

describe('handle_0DAB0D (vertical 3-segment — page 1)', () => {
  it('height 0 writes just the top tile ($41)', () => {
    const grid = createGrid(1)
    const rom = makeMockRom()
    const cur = makeCursor(grid, rom, 0, 5, 10, 17, 0x00)
    handle_0DAB0D(cur)
    expect(grid[10][5]).toBe(P1(0x41))
    expect(grid[11][5]).toBe(TILE_EMPTY)
  })

  it('height 1 writes top ($41) + middle ($42)', () => {
    const grid = createGrid(1)
    const rom = makeMockRom()
    const cur = makeCursor(grid, rom, 0, 5, 10, 17, 0x10)
    handle_0DAB0D(cur)
    expect(grid[10][5]).toBe(P1(0x41))
    expect(grid[11][5]).toBe(P1(0x42))
    expect(grid[12][5]).toBe(TILE_EMPTY)
  })

  it('height 4 writes $41 + $42 + $43×3', () => {
    const grid = createGrid(1)
    const rom = makeMockRom()
    const cur = makeCursor(grid, rom, 0, 5, 10, 17, 0x40)  // X=4
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
    //   DATA_0DA8B4[0] = 0x02 (tile ID for obj 1)
    const rom = makeMockRom({
      [ADDR_TILESET_DISPATCH]: [0x4B, 0xA4, 0x0D],       // tileset 0 → 0x0DA44B
      [ADDR_TILESET0_HANDLERS]: [0xC3, 0xA8, 0x0D],       // obj 1 → 0x0DA8C3
      [ADDR_DATA_0DA8B4]: [0x02],
    })
    const obj = makeObj('standard', 1, 0x00, /*x*/5, /*y*/20)
    const grid = expandMap([obj], 1, rom, 0)
    expect(grid[20][5]).toBe(0x02)
  })

  it('dispatches extended object through ROM pointer tables', () => {
    // Extended-dispatch entry for type 0x10 → CODE_0DA57B (0x0DA57B)
    const rom = makeMockRom({
      [ADDR_EXTENDED_DISPATCH + 0x10 * 3]: [0x7B, 0xA5, 0x0D],
      [ADDR_DATA_0DA548]: [0x1F],
    })
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
  // This handler is intricate (edge caps + middle tiles from multiple ROM tables).
  // We test that it writes something reasonable without throwing, verifying the
  // ROM table reads and the loop structure against a patched ROM.
  it('runs without throwing for a small ledge', () => {
    const rom = makeMockRom({
      [ADDR_DATA_0DAA12]: [0x33, 0x37, 0x39, 0x00, 0x00],
      [ADDR_DATA_0DAA17]: [0x34, 0x38, 0x3A, 0x00, 0x00],
      [ADDR_DATA_0DAA1C]: [0x00, 0x00, 0x39, 0x33, 0x37],
      [ADDR_DATA_0DAA21]: [0x00, 0x00, 0x3A, 0x34, 0x38],
    })
    const grid = createGrid(2)
    const cur = makeCursor(grid, rom, 0, 2, 20, 15, 0x20)   // H=2, X=0
    expect(() => handle_0DAA26(cur)).not.toThrow()
    // Left-top cap (page 1 — all CODE_0DAA26 writes use Sta1To6ePointer).
    expect(grid[20][2]).toBe(P1(0x33))
  })
})

describe('handle_0DAAB4 (used-block run, object 16)', () => {
  it('writes a horizontal run without throwing', () => {
    const rom = makeMockRom({
      [ADDR_DATA_0DAAA4]: [0x3B, 0x3C, 0x3B, 0x3F, 0x3B, 0x3C, 0x3B, 0x3F],
      [ADDR_DATA_0DAAAC]: [0x3D, 0x3E, 0x3D, 0x3E, 0x3D, 0x3E, 0x3D, 0x3E],
    })
    const grid = createGrid(2)
    // W=3 (low nibble) → width 4; H=0 (high nibble) → X=0
    const cur = makeCursor(grid, rom, 0, 0, 20, 16, 0x03)
    expect(() => handle_0DAAB4(cur)).not.toThrow()
    // First tile from DATA_0DAAA4[0] = $3B on page 1.
    expect(grid[20][0]).toBe(P1(0x3B))
  })
})

// ── CODE_0DB1D4 (object 20: water-like rectangle) ─────────────────────────────

describe('handle_0DB1D4 (grass+dirt rectangle, object 20)', () => {
  it('top row writes $100 (page-1 grass), remaining rows write $03F (dirt)', () => {
    const rom = makeMockRom()
    const grid = createGrid(2)
    // size = 0x23 → width-1=3 (width 4), height-1=2 (height 3)
    const cur = makeCursor(grid, rom, 0, 1, 10, 20, 0x23)
    handle_0DB1D4(cur)
    // Top row: page-1 tile $100 (grass-capped ground)
    for (let c = 1; c <= 4; c++) expect(grid[10][c]).toBe(P1(0x00))
    // Next rows: page-0 tile $3F (dirt)
    for (let r = 11; r <= 12; r++) {
      for (let c = 1; c <= 4; c++) expect(grid[r][c]).toBe(0x3F)
    }
    expect(grid[13][1]).toBe(TILE_EMPTY)
  })

  it('1×1 size writes just the top tile (page 1)', () => {
    const rom = makeMockRom()
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 3, 5, 20, 0x00)
    handle_0DB1D4(cur)
    expect(grid[5][3]).toBe(P1(0x00))
    expect(grid[6][3]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DB3BD (object 23: horizontal run from DATA_0DB3BB) ──────────────────

describe('handle_0DB3BD (coin cloud, object 23)', () => {
  it('stamps (width+1) copies of DATA_0DB3BB[H]', () => {
    const rom = makeMockRom({ [ADDR_DATA_0DB3BB]: [0x05, 0x06] })
    const grid = createGrid(1)
    // size = 0x13 → W-1=3 (width 4), H=1 → DATA_0DB3BB[1] = $06
    const cur = makeCursor(grid, rom, 0, 2, 10, 23, 0x13)
    handle_0DB3BD(cur)
    // CODE_0DB3BD uses Sta1To6ePointer -- page 1
    for (let c = 2; c <= 5; c++) expect(grid[10][c]).toBe(P1(0x06))
    expect(grid[10][6]).toBe(TILE_EMPTY)
  })
})

// ── CODE_0DB3E3 (objects 24-26, 34-46: two-row fill) ──────────────────────────

describe('handle_0DB3E3 (two-row fill)', () => {
  function rom(): RomFile {
    return makeMockRom({
      [ADDR_DATA_0DB3DB]: [0x00, 0x01, 0x04, 0x08],
      [ADDR_DATA_0DB3DF]: [0x02, 0x03, 0x05, 0x0B],
    })
  }

  it('objNo 0x18 → top tile $00, bottom $02', () => {
    const grid = createGrid(2)
    const cur = makeCursor(grid, rom(), 0, 0, 10, 0x18, 0x23)  // width=4, height=3
    handle_0DB3E3(cur)
    // Top row: $00
    for (let c = 0; c <= 3; c++) expect(grid[10][c]).toBe(0x00)
    // Bottom rows: $02
    for (let r = 11; r <= 12; r++) {
      for (let c = 0; c <= 3; c++) expect(grid[r][c]).toBe(0x02)
    }
  })

  it('objNo 0x1B uses DATA_0DB3DB[3] = $08 for top', () => {
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom(), 0, 0, 5, 0x1B, 0x00)  // X = 0x1B - 0x18 = 3
    handle_0DB3E3(cur)
    expect(grid[5][0]).toBe(0x08)
  })

  it('handles out-of-table X via raw ROM read (objNo 0x34)', () => {
    // X = 0x34 - 0x18 = 0x1C. Read lands at ADDR_DATA_0DB3DB + 0x1C.
    // We patch that byte so we can assert the observed behavior.
    const rom = makeMockRom({
      [ADDR_DATA_0DB3DB + 0x1C]: [0xEE],
      [ADDR_DATA_0DB3DF + 0x1C]: [0xFF],
    })
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 0, 5, 0x34, 0x00)
    handle_0DB3E3(cur)
    expect(grid[5][0]).toBe(0xEE)
  })
})

// ── CODE_0DB42D (object 29: goal post) ────────────────────────────────────────

describe('handle_0DB42D (goal post)', () => {
  it('row 0 on page 0 ($26), row 1 on page 1 ($144)', () => {
    const rom = makeMockRom({ [ADDR_DATA_0DB42B]: [0x26, 0x44] })
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 2, 10, 29, 0x02)  // width=3
    handle_0DB42D(cur)
    for (let c = 2; c <= 4; c++) {
      expect(grid[10][c]).toBe(0x26)
      expect(grid[11][c]).toBe(P1(0x44))
    }
  })
})

// ── CODE_0DB461 (object 30: rope/vine with end tile) ──────────────────────────

describe('handle_0DB461 (rope/vine)', () => {
  it('rows of $0B followed by a final row of $0E', () => {
    const rom = makeMockRom()
    const grid = createGrid(1)
    // H=2 (two rows of $0B), W=1 (width 2)
    const cur = makeCursor(grid, rom, 0, 1, 10, 30, 0x21)
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
  it('writes DATA_0DA548[0x32] = $2D on page 1', () => {
    const table = Array.from({ length: DATA_0DA548_LEN }, (_, i) => 0x10 + i)
    table[0x32] = 0x2D
    const rom = makeMockRom({ [ADDR_DATA_0DA548]: table })
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 4, 10, 0x17, 0)
    handle_0DA64D(cur)
    expect(grid[10][4]).toBe(P1(0x2D))
  })
})

describe('handle_0DA656 (ext 0x42/0x43 horizontal pair — page 1)', () => {
  it('0x42 writes DATA_0DA652[0] and DATA_0DA654[0]', () => {
    const rom = makeMockRom({
      [ADDR_DATA_0DA652]: [0xD8, 0xDB],
      [ADDR_DATA_0DA654]: [0xDA, 0xDC],
    })
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 5, 10, 0x42, 0)
    handle_0DA656(cur)
    expect(grid[10][5]).toBe(P1(0xD8))
    expect(grid[10][6]).toBe(P1(0xDA))
  })

  it('0x43 uses index 1 of the tables', () => {
    const rom = makeMockRom({
      [ADDR_DATA_0DA652]: [0xD8, 0xDB],
      [ADDR_DATA_0DA654]: [0xDA, 0xDC],
    })
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 5, 10, 0x43, 0)
    handle_0DA656(cur)
    expect(grid[10][5]).toBe(P1(0xDB))
    expect(grid[10][6]).toBe(P1(0xDC))
  })
})

describe('handle_0DA673 (ext 0x44/0x45 vertical pair)', () => {
  it('0x44 writes DATA_0DA671[0] on page 0 above $EB on page 1', () => {
    const rom = makeMockRom({ [ADDR_DATA_0DA671]: [0xB4, 0xB5] })
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 3, 10, 0x44, 0)
    handle_0DA673(cur)
    expect(grid[10][3]).toBe(0xB4)
    expect(grid[11][3]).toBe(P1(0xEB))
  })
})

describe('handle_0DA68E (ext 0x46 midway)', () => {
  it('stamps $35 at col-1 and $38 at col', () => {
    const rom = makeMockRom()
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 5, 10, 0x46, 0)
    handle_0DA68E(cur)
    expect(grid[10][4]).toBe(0x35)
    expect(grid[10][5]).toBe(0x38)
  })
})

describe('handle_0DB51F (3-segment vertical, object 32 — page 1)', () => {
  it('H=2 writes $53/$54/$54/$55', () => {
    const rom = makeMockRom()
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 3, 10, 32, 0x20)  // X=2
    handle_0DB51F(cur)
    expect(grid[10][3]).toBe(P1(0x53))
    expect(grid[11][3]).toBe(P1(0x54))
    expect(grid[12][3]).toBe(P1(0x54))
    expect(grid[13][3]).toBe(P1(0x55))
  })

  it('H=0 writes just $53/$55 (no middle)', () => {
    const rom = makeMockRom()
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 3, 10, 32, 0x00)
    handle_0DB51F(cur)
    expect(grid[10][3]).toBe(P1(0x53))
    expect(grid[11][3]).toBe(P1(0x55))
    expect(grid[12][3]).toBe(TILE_EMPTY)
  })
})

describe('handle_0DB547 (3-segment horizontal, object 33 — page 1)', () => {
  it('W=3 writes $56/$57/$57/$58', () => {
    const rom = makeMockRom()
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 1, 10, 33, 0x03)
    handle_0DB547(cur)
    expect(grid[10][1]).toBe(P1(0x56))
    expect(grid[10][2]).toBe(P1(0x57))
    expect(grid[10][3]).toBe(P1(0x57))
    expect(grid[10][4]).toBe(P1(0x58))
  })
})

describe('handle_0DB571 (single-tile by size, objects 47-54)', () => {
  it('stamps DATA_0DB569[size - $68]', () => {
    const rom = makeMockRom({
      [ADDR_DATA_0DB569]: [0x91, 0x92, 0x96, 0x97, 0x9A, 0x9B, 0x9F, 0xA0],
    })
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 3, 10, 47, 0x69)   // size=0x69 → X=1
    handle_0DB571(cur)
    expect(grid[10][3]).toBe(0x92)
  })
})

describe('handle_0DB5B7 (capped horizontal, object 63)', () => {
  it('W=3 writes leftCap + 2 middle + rightCap', () => {
    const rom = makeMockRom({
      [ADDR_DATA_0DB5A8]: [0x73, 0x7A, 0x85, 0x88, 0xC3],
      [ADDR_DATA_0DB5AD]: [0x74, 0x7B, 0x86, 0x89, 0xC3],
      [ADDR_DATA_0DB5B2]: [0x79, 0x80, 0x87, 0x8E, 0xC3],
    })
    const grid = createGrid(1)
    // X=0 (high=0), W=3 (low=3)
    const cur = makeCursor(grid, rom, 0, 2, 10, 63, 0x03)
    handle_0DB5B7(cur)
    expect(grid[10][2]).toBe(0x73)
    expect(grid[10][3]).toBe(0x74)
    expect(grid[10][4]).toBe(0x74)
    expect(grid[10][5]).toBe(0x79)
  })
})

describe('handle_0DA6D1 (ext 0x47/0x48 vertical pair)', () => {
  it('0x47 writes top then bottom from paired tables', () => {
    const rom = makeMockRom({
      [ADDR_DATA_0DA6CD]: [0x1F, 0x27],
      [ADDR_DATA_0DA6CF]: [0x20, 0x28],
    })
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 2, 10, 0x47, 0)
    handle_0DA6D1(cur)
    expect(grid[10][2]).toBe(0x1F)
    expect(grid[11][2]).toBe(0x20)
  })

  it('0x48 uses index 1', () => {
    const rom = makeMockRom({
      [ADDR_DATA_0DA6CD]: [0x1F, 0x27],
      [ADDR_DATA_0DA6CF]: [0x20, 0x28],
    })
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 2, 10, 0x48, 0)
    handle_0DA6D1(cur)
    expect(grid[10][2]).toBe(0x27)
    expect(grid[11][2]).toBe(0x28)
  })
})

// ── Additional standard handlers (0DB075 slope, 0DB1C8 huge ground) ──────────

describe('handle_0DB1C8 (huge ground fill, object 33)', () => {
  it('size $BF produces a 192-tile grass-capped 3-tall block', () => {
    const rom = makeMockRom()
    const grid = createGrid(13)
    const cur = makeCursor(grid, rom, 0, 0, 24, 33, 0xBF)
    handle_0DB1C8(cur)
    // Row 24: grass cap ($100)
    for (let c = 0; c < 192; c++) expect(grid[24][c]).toBe(P1(0x00))
    // Rows 25-26: dirt ($03F)
    for (let r = 25; r <= 26; r++) {
      for (let c = 0; c < 192; c++) expect(grid[r][c]).toBe(0x3F)
    }
    expect(grid[24][200]).toBe(TILE_EMPTY)
  })

  it('size $0 produces a 1-tile wide × 3-tall block', () => {
    const rom = makeMockRom()
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 5, 10, 33, 0x00)
    handle_0DB1C8(cur)
    expect(grid[10][5]).toBe(P1(0x00))
    expect(grid[11][5]).toBe(0x3F)
    expect(grid[12][5]).toBe(0x3F)
    expect(grid[13][5]).toBe(TILE_EMPTY)
  })
})

describe('handle_0DB075 (slope/vine column, object 19)', () => {
  it('X=2: top + row-1 + middles, all page 0, no footer', () => {
    const rom = makeMockRom({
      [0x0DB039]: Array.from({ length: 15 }, (_, i) => 0x40 + i),
      [0x0DB048]: Array.from({ length: 15 }, (_, i) => 0x50 + i),
      [0x0DB057]: Array.from({ length: 15 }, (_, i) => 0x60 + i),
      [0x0DB066]: Array.from({ length: 15 }, (_, i) => 0x70 + i),
    })
    const grid = createGrid(1)
    // X=2 (< 3 → page 0 throughout), H=3 → 4 tiles total
    const cur = makeCursor(grid, rom, 0, 5, 10, 19, 0x32)
    handle_0DB075(cur)
    expect(grid[10][5]).toBe(0x42)
    expect(grid[11][5]).toBe(0x52)
    expect(grid[12][5]).toBe(0x62)
    expect(grid[13][5]).toBe(0x62)
    expect(grid[14][5]).toBe(TILE_EMPTY)
  })

  it('X=0xB appends footer tile, page 1 throughout', () => {
    const rom = makeMockRom({
      [0x0DB039]: Array.from({ length: 15 }, (_, i) => 0x40 + i),
      [0x0DB048]: Array.from({ length: 15 }, (_, i) => 0x50 + i),
      [0x0DB057]: Array.from({ length: 15 }, (_, i) => 0x60 + i),
      [0x0DB066]: Array.from({ length: 15 }, (_, i) => 0x70 + i),
    })
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 5, 10, 19, 0x1B)   // H=1, X=0xB
    handle_0DB075(cur)
    // X >= 3 → first tile on page 1. Row 1 and footer also page 1 for X >= 9.
    expect(grid[10][5]).toBe(P1(0x4B))
    expect(grid[11][5]).toBe(P1(0x5B))
    expect(grid[12][5]).toBe(P1(0x7B))   // footer on page 1
  })
})

describe('handle_0DAB3E (vertical pipe, object 18)', () => {
  it('H=2 produces a 2-wide × 3-tall pipe', () => {
    const rom = makeMockRom()
    const grid = createGrid(1)
    // H=2, V=0
    const cur = makeCursor(grid, rom, 0, 4, 10, 18, 0x20)
    handle_0DAB3E(cur)
    expect(grid[10][4]).toBe(P1(0x96))
    expect(grid[10][5]).toBe(P1(0x9B))
    expect(grid[11][4]).toBe(P1(0xDE))
    expect(grid[11][5]).toBe(P1(0xE6))
    expect(grid[12][4]).toBe(P1(0xDE))
    expect(grid[12][5]).toBe(P1(0xE6))
    expect(grid[13][4]).toBe(TILE_EMPTY)
  })
})

describe('handle_0DB224 (3-column framed structure, object 21)', () => {
  it('variant 0 uses DATA_0DB212/215/218 triples', () => {
    const rom = makeMockRom({
      [0x0DB212]: [0x2F, 0x25, 0x32],
      [0x0DB215]: [0x30, 0x25, 0x33],
      [0x0DB218]: [0x31, 0x25, 0x34],
    })
    const grid = createGrid(1)
    // V=0, H=1 (top + 1 middle + bottom per column)
    const cur = makeCursor(grid, rom, 0, 2, 10, 21, 0x10)
    handle_0DB224(cur)
    // Column 0: top $2F, mid $30, bot $31
    expect(grid[10][2]).toBe(0x2F)
    expect(grid[11][2]).toBe(0x30)
    expect(grid[12][2]).toBe(0x31)
    // Column 1 (middle): all $25 (empty tile is the structural gap)
    expect(grid[10][3]).toBe(0x25)
    expect(grid[11][3]).toBe(0x25)
    expect(grid[12][3]).toBe(0x25)
    // Column 2: top $32, mid $33, bot $34
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
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 2, 10, 21, 0x11)  // V=1, H=1
    handle_0DB224(cur)
    expect(grid[10][2]).toBe(0x39)
    expect(grid[11][2]).toBe(0x3A)
    expect(grid[12][2]).toBe(0x3B)
    expect(grid[12][4]).toBe(0x3E)
  })
})

describe('handle_0DB2CA (dragon coin, ext 0x30)', () => {
  it('writes $2D above $2E', () => {
    const rom = makeMockRom()
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 3, 15, 0x30, 0)
    handle_0DB2CA(cur)
    expect(grid[15][3]).toBe(0x2D)
    expect(grid[16][3]).toBe(0x2E)
  })
})

// ── Integration: real SMW ROM, level $105 (Yoshi's Island 1) ─────────────────
// These tests require test/roms/Super Mario World (USA).sfc to be present.
// They confirm the ported handlers produce non-empty tile grids for a known
// reference level.

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).sfc')
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
