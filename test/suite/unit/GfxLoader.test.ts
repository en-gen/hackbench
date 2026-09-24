/**
 * Unit tests for GfxLoader against the vanilla SMW ROM.
 *
 * ROM stores GFX as 3bpp (24 bytes/tile, 128 tiles = 3072 bytes) or 4bpp
 * (32 bytes/tile). GfxLoader auto-detects and returns decoded pixel indices.
 *
 * Previously this file also compared against Lunar Magic's "Export GFX"
 * bin files at test/roms/Graphics/. That block was removed after the project
 * moved to vanilla-ROM-only testing - LM-derived reference data is no longer
 * trusted (cf. project memory on the two ROMs).
 */

import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  readGfxFile,
  loadGfxFile,
  findCreditsGfxFile,
  readGfxAssignment,
  GFX_FILE_COUNT,
} from '../../../src/rom/GfxLoader'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const ROM_PATH = romPath(VANILLA)
const romPresent = hasRom(VANILLA)

const LEVEL_104 = 0x104

describe.skipIf(!romPresent)('GfxLoader (ROM-only)', () => {
  it('returns non-empty raw bytes for GFX file 0', () => {
    const rom = SmwRom.open(ROM_PATH)
    const read = readGfxFile(rom.rom, 0)
    expect(read.ok && read.bytes.length).toBeGreaterThan(0)
  })

  it('refuses an out-of-range file index', () => {
    const rom = SmwRom.open(ROM_PATH)
    expect(readGfxFile(rom.rom, GFX_FILE_COUNT + 10).ok).toBe(false)
  })

  it('loadGfxFile decodes GFX file 0 to exactly 128 tiles of 64 pixels', () => {
    const rom = SmwRom.open(ROM_PATH)
    const sheet = loadGfxFile(rom.rom, 0)
    expect(sheet.length).toBe(128)
    for (const tile of sheet) {
      expect(tile.length).toBe(64)
    }
  })

  it('resolves the credits letters to GFX $2F, $400 bytes = 64 2BPP chars', () => {
    const rom = SmwRom.open(ROM_PATH)
    expect(findCreditsGfxFile(rom.rom)).toEqual({ fileIndex: 0x2f, byteLength: 0x400 })
  })

  it('decodes GFX $2F as 64 2BPP tiles, not 32 4BPP tiles', () => {
    const rom = SmwRom.open(ROM_PATH)
    expect(loadGfxFile(rom.rom, 0x2f).length).toBe(64)
  })

  it('readGfxAssignment returns valid file indices for level $104', () => {
    const rom = SmwRom.open(ROM_PATH)
    const rawL1 = rom.getLevelRawData(LEVEL_104)!
    const { header } = parseLevelObjects(rawL1)
    // Use header.objectTileset (header byte 4 bits 3-0) - same path MapEditorProvider
    // uses at runtime. rom.getGfxTilesetId() returns TILESETID_TABLE[spriteSet], a
    // different ROM lookup that isn't always a valid ObjectGfxList index.
    const tilesetId = header.objectTileset
    const spriteSet = header.spriteSet

    const assign = readGfxAssignment(rom.rom, tilesetId, spriteSet)
    // All assigned indices should be in range 0–GFX_FILE_COUNT
    for (const [, idx] of Object.entries(assign)) {
      if (idx !== undefined) {
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThan(GFX_FILE_COUNT)
      }
    }
  })

  // Removed: "level $104 FG1 GFX decoded pixels match VRAM dump" - the Mesen
  // VRAM dump snapshots whatever was loaded at pause time, not necessarily
  // level $104's tileset. Without a dump captured in a known, reproducible
  // game state for this specific level, the comparison isn't meaningful.
})
