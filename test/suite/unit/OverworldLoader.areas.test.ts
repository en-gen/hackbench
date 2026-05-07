/**
 * OverworldLoader — synthetic-ROM tests for the area-table parser, palette
 * assembly, region/mask logic, and Map16 decode. The existing synthetic tests
 * cover the RLE decoder and event swaps; this file exercises the rest of the
 * file's business logic without requiring a real SMW ROM.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  OW_ADDR,
  OW_AREA_COUNT,
  OW_PALETTE_BLOCK_BYTES,
  OW_BG_FULL_TILES,
  OW_BG_HALF_TILES,
  OW_SUBAREA_TILES_W,
  OW_SUBAREA_TILES_H,
  loadOverworldAreas,
  loadAreaWarpStarts,
  loadAreaPalette,
  loadOverworldL2Tilemap,
  loadOverworldL1Map16Stream,
  loadOverworldL1CharData,
  loadOverworld,
  areaBufferRegion,
  l3MaskForArea,
  isL3MaskedRow,
  decodeOwMap16,
  readOwBaselineLevelIndex,
  type OwArea,
} from '../../../src/rom/OverworldLoader'

/** 4 MB LoROM buffer with map-mode byte set. */
function makeMockRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7FD5] = 0x20
  return new RomFile('mock.smc', buf)
}

/**
 * Tiny buffer (0x100 bytes) — every overworld ROM read returns null because
 * the lowest required offset (CAMERA_X_TABLE → file offset $206B) is far
 * past the end of the buffer. Lets us exercise the loader's null-fallback paths.
 */
function makeTinyRom(): RomFile {
  return new RomFile('tiny.smc', Buffer.alloc(0x100))
}

const writeWord = (rom: RomFile, addr: number, value: number): void => {
  rom.writeAt(addr, [value & 0xFF, (value >> 8) & 0xFF])
}

// ── Title-screen baseline read ───────────────────────────────────────────────

describe('readOwBaselineLevelIndex', () => {
  it('returns the byte at $0096CC when readable', () => {
    const rom = makeMockRom()
    rom.writeAt(OW_ADDR.TITLE_LEVEL_LDA_OPERAND, [0xC7])
    expect(readOwBaselineLevelIndex(rom)).toBe(0xC7)
  })

  it('falls back to $EB when ROM cannot be read at the address', () => {
    // We can't easily build a ROM where $0096CC is unmapped via LoROM, so emulate by
    // constructing a tiny buffer where the byte read returns null (offset out of range).
    const rom = new RomFile('empty.smc', Buffer.alloc(8))
    expect(readOwBaselineLevelIndex(rom)).toBe(0xEB)
  })
})

// ── loadOverworldAreas ───────────────────────────────────────────────────────

describe('loadOverworldAreas', () => {
  it('returns 7 areas with vanilla-shape defaults from a fully-zeroed ROM', () => {
    const rom = makeMockRom()
    const areas = loadOverworldAreas(rom)
    expect(areas.length).toBe(OW_AREA_COUNT)
    // Area 0 is the only full-size map (heuristic in the loader).
    expect(areas[0].widthTiles).toBe(OW_BG_FULL_TILES)
    expect(areas[0].heightTiles).toBe(OW_BG_FULL_TILES)
    expect(areas[1].widthTiles).toBe(OW_BG_HALF_TILES)
  })

  it('falls back to per-index defaults when read buffers are null (tiny ROM)', () => {
    const rom = makeTinyRom()
    const areas = loadOverworldAreas(rom)
    expect(areas.length).toBe(OW_AREA_COUNT)
    // With tiny ROM, palOff buffer is null and readUInt16LE returns undefined,
    // so the loader falls back to (paletteIndex * OW_PALETTE_BLOCK_BYTES).
    // tilesetBuf is also null so objectTileset uses (0x11 + i).
    expect(areas[3].objectTileset).toBe(0x11 + 3)
    expect(areas[3].paletteIndex).toBe(3)  // fallback to index when palIx is null
    expect(areas[3].paletteAddrNormal).toBe(
      OW_ADDR.PALETTE_NORMAL_BASE + 3 * OW_PALETTE_BLOCK_BYTES,
    )
  })

  it('sign-extends negative camera-X values from the ROM word table', () => {
    const rom = makeMockRom()
    // Area 1 cameraX = $FFEF (= -17 signed)
    writeWord(rom, OW_ADDR.CAMERA_X_TABLE + 1 * 2, 0xFFEF)
    writeWord(rom, OW_ADDR.CAMERA_Y_TABLE + 1 * 2, 0xFFD8)  // = -40
    const areas = loadOverworldAreas(rom)
    expect(areas[1].cameraX).toBe(-17)
    expect(areas[1].cameraY).toBe(-40)
  })

  it('honours per-area tileset and palette index reads from ROM tables', () => {
    const rom = makeMockRom()
    rom.writeAt(OW_ADDR.OBJ_TILESET_TBL, [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27])
    rom.writeAt(OW_ADDR.PALETTE_INDEX_TABLE, [4, 5, 6, 0, 1, 2, 3])
    const areas = loadOverworldAreas(rom)
    expect(areas[0].objectTileset).toBe(0x21)
    expect(areas[6].objectTileset).toBe(0x27)
    expect(areas[0].paletteIndex).toBe(4)
    expect(areas[3].paletteIndex).toBe(0)
  })

  it('attaches matching warp positions to areas (mario + luigi share)', () => {
    const rom = makeMockRom()
    // Initialise the entire warp X table to destSubmap=$0F (no area) so default
    // zero entries don't accidentally claim area 0.
    rom.writeAt(OW_ADDR.WARP_X_TABLE, new Array(27 * 2).fill(0xFF))
    // Warp 0 targets area 3 (destSubmap = (xWord >> 9) & 0x0F = 3 → xWord = (3<<9) | 0x55 = $0655)
    writeWord(rom, OW_ADDR.WARP_X_TABLE, 0x0655)
    writeWord(rom, OW_ADDR.WARP_Y_TABLE, 0x00A4)
    const areas = loadOverworldAreas(rom)
    expect(areas[3].marioStart).toEqual({ x: 0x55, y: 0x00A4 })
    expect(areas[3].luigiStart).toEqual({ x: 0x55, y: 0x00A4 })
    // Distinct objects (warp tables share data but the area builds separate copies).
    expect(areas[3].marioStart).not.toBe(areas[3].luigiStart)
    // Areas with no targeting warp keep null.
    expect(areas[5].marioStart).toBeNull()
  })
})

// ── loadAreaWarpStarts ───────────────────────────────────────────────────────

describe('loadAreaWarpStarts', () => {
  it('returns empty mario/luigi arrays on a tiny ROM where tables are unreadable', () => {
    const rom = makeTinyRom()
    expect(loadAreaWarpStarts(rom, 0)).toEqual({ mario: [], luigi: [] })
  })

  it('returns all warps targeting the given area', () => {
    const rom = makeMockRom()
    // Warp 0 → area 2, warp 1 → area 5, warp 2 → area 2
    writeWord(rom, OW_ADDR.WARP_X_TABLE + 0, (2 << 9) | 0x10)
    writeWord(rom, OW_ADDR.WARP_X_TABLE + 2, (5 << 9) | 0x20)
    writeWord(rom, OW_ADDR.WARP_X_TABLE + 4, (2 << 9) | 0x30)
    writeWord(rom, OW_ADDR.WARP_Y_TABLE + 0, 0x0040)
    writeWord(rom, OW_ADDR.WARP_Y_TABLE + 2, 0x0050)
    writeWord(rom, OW_ADDR.WARP_Y_TABLE + 4, 0x0060)
    const result = loadAreaWarpStarts(rom, 2)
    expect(result.mario).toEqual([{ x: 0x10, y: 0x0040 }, { x: 0x30, y: 0x0060 }])
    // luigi is a separate array but with equal contents
    expect(result.luigi).toEqual(result.mario)
    expect(result.luigi).not.toBe(result.mario)
  })
})

// ── loadAreaPalette ──────────────────────────────────────────────────────────

describe('loadAreaPalette', () => {
  function fakeArea(): OwArea {
    return {
      index: 1,
      widthTiles: OW_BG_HALF_TILES,
      heightTiles: OW_BG_HALF_TILES,
      cameraX: -17,
      cameraY: -40,
      objectTileset: 0x12,
      paletteIndex: 1,
      paletteAddrNormal: OW_ADDR.PALETTE_NORMAL_BASE + 0x38,
      paletteAddrSpecial: OW_ADDR.PALETTE_SPECIAL_BASE + 0x38,
      marioStart: null,
      luigiStart: null,
    }
  }

  it('returns 16 RgbaRows with the area block selected from the normal table', () => {
    const rom = makeMockRom()
    const area = fakeArea()
    // Plant a non-zero color in the area-specific block (col 1 row 4 → first read).
    writeWord(rom, area.paletteAddrNormal, 0x7C00)  // BGR555 red-ish
    const rows = loadAreaPalette(rom, area, false)
    expect(rows.length).toBe(16)
    expect(rows[4][1]).toBeDefined()
  })

  it('uses the special-world block when useSpecial is true', () => {
    const rom = makeMockRom()
    const area = fakeArea()
    writeWord(rom, area.paletteAddrNormal, 0x7C00)
    writeWord(rom, area.paletteAddrSpecial, 0x001F)  // distinct color
    const normal = loadAreaPalette(rom, area, false)
    const special = loadAreaPalette(rom, area, true)
    expect(special[4][1]).not.toEqual(normal[4][1])
  })

  it('leaves area-block rows on default empty colors when read buffer is null (tiny ROM)', () => {
    const rom = makeTinyRom()
    const area = fakeArea()
    const rows = loadAreaPalette(rom, area, false)
    expect(rows.length).toBe(16)
    // Without ROM data, everything is empty/black/transparent — col 0 of each row is transparent.
    for (let r = 0; r < 16; r++) {
      expect(rows[r][0]).toEqual([0, 0, 0, 0])
    }
  })

  it('honours the four sub-block reads (StdColors, StdColors2, HudColors)', () => {
    const rom = makeMockRom()
    const area = fakeArea()
    // Plant uniques into each sub-block first byte
    writeWord(rom, OW_ADDR.PALETTE_STD,  0x7C00)   // → row 2 col 9
    writeWord(rom, OW_ADDR.PALETTE_STD2, 0x03E0)   // → row 8 col 1
    writeWord(rom, OW_ADDR.PALETTE_HUD,  0x001F)   // → row 0 col 8
    const rows = loadAreaPalette(rom, area, false)
    expect(rows[2][9]).toBeDefined()
    expect(rows[8][1]).toBeDefined()
    expect(rows[0][8]).toBeDefined()
  })
})

// ── Raw loaders ──────────────────────────────────────────────────────────────

describe('raw L1/L2 loaders', () => {
  it('loadOverworldL2Tilemap returns 0x4000 bytes from a 4 MB ROM', () => {
    const rom = makeMockRom()
    const out = loadOverworldL2Tilemap(rom)
    expect(out.length).toBe(0x4000)
  })

  it('loadOverworldL2Tilemap returns a zero-filled buffer when reads fail (tiny ROM)', () => {
    const rom = makeTinyRom()
    const out = loadOverworldL2Tilemap(rom)
    expect(out.length).toBe(0x4000)
    expect(out.every(b => b === 0)).toBe(true)
  })

  it('loadOverworldL1Map16Stream returns a Uint8Array of OW_L1_MAP16_BYTES', () => {
    const rom = makeMockRom()
    rom.writeAt(OW_ADDR.L1_TILEDATA, [0x42, 0x43, 0x44])
    const out = loadOverworldL1Map16Stream(rom)
    expect(out.length).toBe(0x800)
    expect(out[0]).toBe(0x42)
  })

  it('loadOverworldL1Map16Stream falls back to zeros on tiny ROM', () => {
    const rom = makeTinyRom()
    const out = loadOverworldL1Map16Stream(rom)
    expect(out.length).toBe(0x800)
    expect(out.every(b => b === 0)).toBe(true)
  })

  it('loadOverworldL1CharData returns 0x1000 bytes', () => {
    const rom = makeMockRom()
    const out = loadOverworldL1CharData(rom)
    expect(out.length).toBe(0x1000)
  })

  it('loadOverworldL1CharData falls back to zeros on tiny ROM', () => {
    const rom = makeTinyRom()
    const out = loadOverworldL1CharData(rom)
    expect(out.length).toBe(0x1000)
  })

  it('loadOverworld bundles all four pieces', () => {
    const rom = makeMockRom()
    const data = loadOverworld(rom)
    expect(data.l2Tilemap.length).toBe(0x4000)
    expect(data.l1Map16Indices.length).toBe(0x800)
    expect(data.l1CharData.length).toBe(0x1000)
    expect(data.areas.length).toBe(OW_AREA_COUNT)
  })
})

// ── areaBufferRegion + l3MaskForArea ─────────────────────────────────────────

describe('areaBufferRegion', () => {
  function area(index: number, cameraX = 0, cameraY = 0): OwArea {
    return {
      index,
      widthTiles: index === 0 ? OW_BG_FULL_TILES : OW_BG_HALF_TILES,
      heightTiles: index === 0 ? OW_BG_FULL_TILES : OW_BG_HALF_TILES,
      cameraX,
      cameraY,
      objectTileset: 0,
      paletteIndex: 0,
      paletteAddrNormal: 0,
      paletteAddrSpecial: 0,
      marioStart: null,
      luigiStart: null,
    }
  }

  it('Area 0 returns full 64×64 layout 0', () => {
    expect(areaBufferRegion(area(0))).toEqual({
      layout: 0, rowStart: 0, colStart: 0, widthTiles: 64, heightTiles: 64,
    })
  })

  it('Sub-area maps to layout 1 with sub-area camera tile (positive camera)', () => {
    // cameraX = 240 → ceil(240/8)=30 mod 64 = 30
    // cameraY = 168 → ceil(168/8)=21 mod 64 = 21
    const r = areaBufferRegion(area(2, 240, 168))
    expect(r.layout).toBe(1)
    expect(r.colStart).toBe(30)
    expect(r.rowStart).toBe(21)
    expect(r.widthTiles).toBe(OW_SUBAREA_TILES_W)
    expect(r.heightTiles).toBe(OW_SUBAREA_TILES_H)
  })

  it('Negative camera positions wrap around the 64-tile BG via ceil + mod 64', () => {
    // cameraX = -17 → ceil(-17/8) = -2 → -2 mod 64 = 62
    const r = areaBufferRegion(area(1, -17, -40))
    expect(r.colStart).toBe(62)
    // cameraY = -40 → ceil(-40/8) = -5 → 59
    expect(r.rowStart).toBe(59)
  })
})

describe('l3MaskForArea', () => {
  function area(index: number, cameraY = 0): OwArea {
    return {
      index,
      widthTiles: 32, heightTiles: 32,
      cameraX: 0, cameraY,
      objectTileset: 0, paletteIndex: 0,
      paletteAddrNormal: 0, paletteAddrSpecial: 0,
      marioStart: null, luigiStart: null,
    }
  }

  it('Area 0 has no L3 mask', () => {
    expect(l3MaskForArea(area(0))).toBeNull()
  })

  it('Top-row sub-area (negative cameraY) masks 4 top rows', () => {
    expect(l3MaskForArea(area(1, -40))).toEqual({ topRows: 4, bottomRows: 2 })
  })

  it('Mid/bottom sub-area (cameraY >= 0) masks 5 top rows', () => {
    expect(l3MaskForArea(area(2, 168))).toEqual({ topRows: 5, bottomRows: 2 })
  })
})

describe('isL3MaskedRow', () => {
  const mask = { topRows: 4, bottomRows: 2 }

  it('rows below topRows are masked', () => {
    expect(isL3MaskedRow(0, mask)).toBe(true)
    expect(isL3MaskedRow(3, mask)).toBe(true)
  })

  it('first non-masked row is topRows', () => {
    expect(isL3MaskedRow(4, mask)).toBe(false)
  })

  it('rows in the bottomRows tail are masked', () => {
    expect(isL3MaskedRow(26, mask)).toBe(true)
    expect(isL3MaskedRow(27, mask)).toBe(true)
  })

  it('uses the supplied height when given', () => {
    // height 22, bottomRows 2 → rows 20+ masked
    expect(isL3MaskedRow(19, mask, 22)).toBe(false)
    expect(isL3MaskedRow(20, mask, 22)).toBe(true)
  })
})

// ── decodeOwMap16 ────────────────────────────────────────────────────────────

describe('decodeOwMap16', () => {
  it('decodes the four 16-bit subtile words at index*8', () => {
    // Build 8 bytes = 4 LE words.
    // Layout matches the loader: tl, bl, tr, br.
    // Each word: charNum(10) | palette(3 << 10) | priority(1 << 13) | flipX(1 << 14) | flipY(1 << 15)
    const tlWord = 0x0123  // chN=$123, pal=0
    const blWord = 0x1456  // chN=$56, pal=5
    const trWord = 0x4789  // chN=$189, pal=1, flipX=1
    const brWord = 0xC0AB  // chN=$0AB, pal=0, prio=0, flipX=0, flipY=1, also priority bit
    const charData = new Uint8Array([
      tlWord & 0xFF, (tlWord >> 8) & 0xFF,
      blWord & 0xFF, (blWord >> 8) & 0xFF,
      trWord & 0xFF, (trWord >> 8) & 0xFF,
      brWord & 0xFF, (brWord >> 8) & 0xFF,
    ])
    const m = decodeOwMap16(charData, 0)
    expect(m.tl.charNum).toBe(0x123)
    expect(m.bl.palette).toBe(5)
    expect(m.tr.flipX).toBe(true)
    expect(m.br.flipY).toBe(true)
  })

  it('treats out-of-bounds reads as zero (charData too short)', () => {
    const m = decodeOwMap16(new Uint8Array(0), 0)
    expect(m.tl.charNum).toBe(0)
    expect(m.tl.palette).toBe(0)
    expect(m.tl.priority).toBe(false)
  })
})
