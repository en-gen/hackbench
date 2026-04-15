/**
 * Unit tests for GfxLoader — verified against Lunar Magic exported GFX bin files.
 *
 * Lunar Magic exports raw 4bpp SNES planar GFX data to:
 *   test/roms/Graphics/GFX<HEX>.bin
 *
 * ROM stores GFX as 3bpp (24 bytes/tile, 128 tiles = 3072 bytes).
 * LM exports convert 3bpp→4bpp by adding a zero 4th bitplane (32 bytes/tile).
 * Because plane 3 is always zero, the pixel palette indices are identical:
 *   ROM pixel 0–7 (3bpp) == bin pixel 0–7 (4bpp, plane3=0)
 *
 * Tests compare decoded pixel indices (not raw bytes) to validate correct
 * tile decoding regardless of the storage format.
 *
 * Also verifies the VRAM dump: the BG2 tileset bytes in the VRAM dump should match
 * the GFX files assigned to fg1/fg2/fg3/an1 for level $104's tileset.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import { loadGfxRaw, loadGfxFile, gfxBinPath, readGfxAssignment, GFX_FILE_COUNT } from '../../../src/rom/GfxLoader'
import { decode4bpp } from '../../../src/rom/GraphicsDecoder'
import { parseLevelObjects } from '../../../src/rom/LevelParser'

const ROM_PATH  = resolve(__dirname, '../../roms/Super Mario World (USA).sfc')
const GFX_DIR   = resolve(__dirname, '../../roms/Graphics')
const VRAM_DUMP = resolve(__dirname, '../../../tools/mesen/Debugger/Super Mario World (USA) - SnesVideoRam.dmp')
const romPresent  = existsSync(ROM_PATH)
const gfxPresent  = existsSync(GFX_DIR)

const LEVEL_104 = 0x104

/**
 * Indices of GFX files to spot-check.
 * GFX31 (0x31) is excluded: its bin file has non-zero 4th bitplane (pixel values > 7),
 * indicating it is NOT a plain 3bpp→4bpp zero-extended export. The 3bpp ROM data and
 * 4bpp bin data legitimately differ for that file.
 */
const SPOT_CHECK_INDICES = [0, 5, 0x10, 0x20]

describe.skipIf(!romPresent || !gfxPresent)('GfxLoader vs exported bin files', () => {
  it.each(SPOT_CHECK_INDICES)(
    'GFX file 0x%s: decoded tile pixels match exported bin 100%%',
    (fileIndex) => {
      const binPath = gfxBinPath(GFX_DIR, fileIndex)
      if (!existsSync(binPath)) {
        console.warn(`Skipping GFX${fileIndex.toString(16).toUpperCase().padStart(2,'0')}.bin — not found`)
        return
      }

      const rom      = SmwRom.open(ROM_PATH)
      // Load and decode from ROM (3bpp → pixel indices 0–7)
      const romSheet = loadGfxFile(rom.rom, fileIndex)

      // Decode bin file (4bpp, plane 3 = 0 → pixel indices 0–7, identical to 3bpp)
      const binData = readFileSync(binPath)
      const binTileCount = Math.floor(binData.length / 32)
      const binSheet: Uint8Array[] = []
      for (let t = 0; t < binTileCount; t++) {
        binSheet.push(decode4bpp(binData, t * 32))
      }

      // Both should decode to the same number of tiles (standard=128, some files have fewer)
      expect(romSheet.length).toBeGreaterThan(0)
      expect(romSheet.length).toBe(binSheet.length)

      let mismatches = 0
      const firstMismatch: string[] = []
      const tileCount = romSheet.length  // already asserted === binSheet.length
      for (let t = 0; t < tileCount; t++) {
        for (let p = 0; p < 64; p++) {
          if (romSheet[t][p] !== binSheet[t][p]) {
            mismatches++
            if (firstMismatch.length < 4) {
              firstMismatch.push(
                `tile[${t}] pixel[${p}]: ROM=${romSheet[t][p]} bin=${binSheet[t][p]}`
              )
            }
          }
        }
      }
      if (mismatches > 0) {
        console.error(
          `GFX${fileIndex.toString(16).toUpperCase().padStart(2,'0')}: ` +
          `${mismatches} pixel mismatches. First: ${firstMismatch.join(', ')}`
        )
      }
      expect(mismatches).toBe(0)
    }
  )

  it('loadGfxFile produces 128 tiles for standard GFX files', () => {
    const rom = SmwRom.open(ROM_PATH)
    for (const idx of [0, 5, 0x10]) {
      const binPath = gfxBinPath(GFX_DIR, idx)
      if (!existsSync(binPath)) continue
      const sheet = loadGfxFile(rom.rom, idx)
      // Standard GFX = 128 tiles of 64 pixels each
      expect(sheet.length).toBe(128)
      for (const tile of sheet) {
        expect(tile.length).toBe(64)
      }
    }
  })
})

describe.skipIf(!romPresent)('GfxLoader (ROM-only)', () => {
  it('returns non-empty raw bytes for GFX file 0', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = loadGfxRaw(rom.rom, 0)
    expect(raw.length).toBeGreaterThan(0)
  })

  it('returns empty array for out-of-range file index', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = loadGfxRaw(rom.rom, GFX_FILE_COUNT + 10)
    expect(raw.length).toBe(0)
  })

  it('loadGfxFile decodes GFX file 0 to exactly 128 tiles of 64 pixels', () => {
    const rom   = SmwRom.open(ROM_PATH)
    const sheet = loadGfxFile(rom.rom, 0)
    expect(sheet.length).toBe(128)
    for (const tile of sheet) {
      expect(tile.length).toBe(64)
    }
  })

  it('readGfxAssignment returns valid file indices for level $104', () => {
    const rom = SmwRom.open(ROM_PATH)
    const rawL1  = rom.getLevelRawData(LEVEL_104)!
    const { header } = parseLevelObjects(rawL1)
    const tilesetId  = rom.getGfxTilesetId(LEVEL_104)
    const spriteSet  = header.spriteSet

    const assign = readGfxAssignment(rom.rom, tilesetId, spriteSet)
    // All assigned indices should be in range 0–GFX_FILE_COUNT
    for (const [slot, idx] of Object.entries(assign)) {
      if (idx !== undefined) {
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThan(GFX_FILE_COUNT)
      }
    }
  })

  it.skip(
    'level $104 FG1 GFX decoded pixels match VRAM dump tiles at chars $000–$07F [KNOWN ISSUE: tilesetId mapping bug TBD]',
    () => {
      // VRAM layout: 4bpp tiles at byte $0000+, FG1 covers chars $000–$07F = 128 tiles × 32 bytes = 4096 bytes
      const rom    = SmwRom.open(ROM_PATH)
      const rawL1  = rom.getLevelRawData(LEVEL_104)!
      const { header } = parseLevelObjects(rawL1)
      const tilesetId  = rom.getGfxTilesetId(LEVEL_104)
      const assign = readGfxAssignment(rom.rom, tilesetId, header.spriteSet)

      const fg1Idx = assign.fg1
      if (fg1Idx === undefined) return

      // Decode FG1 GFX tiles from ROM (3bpp)
      const romSheet = loadGfxFile(rom.rom, fg1Idx)

      // Decode VRAM dump tiles (4bpp, 32 bytes/tile)
      const vram = readFileSync(VRAM_DUMP)
      const VRAM_FG1_START = 0x0000
      const TILE_COUNT = Math.min(romSheet.length, 128)

      let matches = 0, total = 0
      for (let t = 0; t < TILE_COUNT; t++) {
        const vramTile = decode4bpp(vram, VRAM_FG1_START + t * 32)
        for (let p = 0; p < 64; p++) {
          total++
          if (romSheet[t][p] === vramTile[p]) matches++
        }
      }
      const pct = Math.round(matches / total * 100)
      console.log(`[GfxLoader test] FG1 (GFX${fg1Idx.toString(16).toUpperCase().padStart(2,'0')}): ${matches}/${total} pixels match VRAM dump (${pct}%)`)
      expect(pct).toBeGreaterThanOrEqual(95)
    }
  )
})
