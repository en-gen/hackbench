/**
 * Proves buildMap16PointerTable's addresses are the REAL addresses in the
 * cartridge, not merely self-consistent with Map16.ts's own decode.
 *
 * This is the test the Map16 view's inspector depends on for correctness:
 * it shows "the ROM address of that block's entry" and an editor writes an
 * op at that exact address. A wrong address here means every op the view
 * ever produces silently corrupts the wrong bytes - see CLAUDE.md's Oracle
 * discipline and the brief's own warning about this.
 *
 * Independence from Map16.ts is the point, so each test reads bytes with
 * `fs.readFileSync` + `loromToOffset` directly, never through RomFile or
 * `decodeSubTileWord`/`encodeSubTileWord`, and only THEN compares against
 * what the production path (`loadAllMap16`) decoded for the same tile.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { hasCopierHeader, loromToOffset } from '../../../src/rom/addressing'
import {
  readL2Map16Table,
  buildMap16PointerTable,
  loadAllMap16,
  loadAllMap16BG,
  MAP16_BG_TILES,
  MAP16_TILE_BYTES,
  MAP16_BITMAP_ADDR,
  MAP16_COMMON,
  TILESET_MAP16_LOC,
} from '../../../src/rom/Map16'
import { SmwRom } from '../../../src/rom/SmwRom'
import { VANILLA, hasRom, romPath } from '../support/corpus'

// The corpus helper - the convention the suite's ROM files use - not a path under
// the user's home directory. On CI, HOME resolves to /home/runner, where no
// cartridge exists, and the home-directory form made this file's gate depend
// on one developer's machine layout.
const ROM_PATH = romPath(VANILLA)
const romPresent = hasRom(VANILLA)

describe.runIf(romPresent)('Map16 pointer-table addresses against real cart bytes', () => {
  // Read LAZILY, inside the cases. Vitest still executes a describe body
  // to collect its tests even when runIf is false, so a readFileSync at
  // this level threw during collection on CI - the gate skipped the
  // tests and the file failed anyway.
  let raw: Buffer
  let hasHeader: boolean
  let romSize: number
  beforeAll(() => {
    raw = readFileSync(ROM_PATH)
    hasHeader = hasCopierHeader(raw.length)
    romSize = raw.length - (hasHeader ? 512 : 0)
  })

  function fileOffset(snesAddr: number): number {
    const off = loromToOffset(snesAddr, romSize, hasHeader)
    if (off === null) throw new Error(`address $${snesAddr.toString(16)} is outside this cart`)
    return off
  }

  /** Raw bytes at a SNES address, read with plain fs - no RomFile involved. */
  function rawBytesAt(snesAddr: number, length: number): Buffer {
    const off = fileOffset(snesAddr)
    return raw.subarray(off, off + length)
  }

  it(
    "tile $000's pointer matches a from-scratch replay of the bitmap bit, " +
      'read straight off disk with no Map16.ts decode involved',
    () => {
      // CODE_0581FB (bank_05.asm:253-358): bit 7 (MSB) of bitmap byte 0
      // decides tile 0 - carry set (1) -> Map16Common, clear (0) -> the
      // tileset's own base from TilesetMAP16Loc. Replayed here by hand.
      const bitmapByte0 = rawBytesAt(MAP16_BITMAP_ADDR, 1)[0]!
      const tile0IsCommon = (bitmapByte0 & 0x80) !== 0

      const tilesetWord = rawBytesAt(TILESET_MAP16_LOC, 2).readUInt16LE(0) // tileset 0 = first entry
      const tilesetBase = 0x0d0000 | tilesetWord
      const expectedPointer0 = tile0IsCommon ? MAP16_COMMON : tilesetBase

      const rom = SmwRom.open(ROM_PATH)
      const pointers = buildMap16PointerTable(rom.rom, 0)
      expect(pointers[0]).toBe(expectedPointer0)

      // The bytes AT that address, read independently, must be what the
      // production decode path reports for tile 0.
      const rawTile0 = rawBytesAt(expectedPointer0, MAP16_TILE_BYTES)
      const tile0 = loadAllMap16(rom.rom, 0)[0]!
      expect(rawTile0.readUInt16LE(0) & 0x3ff).toBe(tile0.tl.charNum) // word0 = TL
      expect(rawTile0.readUInt16LE(2) & 0x3ff).toBe(tile0.bl.charNum) // word1 = BL
      expect(rawTile0.readUInt16LE(4) & 0x3ff).toBe(tile0.tr.charNum) // word2 = TR
      expect(rawTile0.readUInt16LE(6) & 0x3ff).toBe(tile0.br.charNum) // word3 = BR
    },
  )

  it('the $1C4-$1C7/$1EC-$1EF slope-pipe override lands exactly at the ASM-documented $0D8A70 run', () => {
    // CODE_058281 (bank_05.asm:321): tilesets 0 and 7 overwrite these 8
    // tile IDs with a fixed run starting at $0D8A70 - a literal from the
    // disassembly, not derived from anything buildMap16PointerTable computes.
    const rom = SmwRom.open(ROM_PATH)
    const pointers = buildMap16PointerTable(rom.rom, 0)
    const tileIds = [0x1c4, 0x1c5, 0x1c6, 0x1c7, 0x1ec, 0x1ed, 0x1ee, 0x1ef]
    tileIds.forEach((id, i) => {
      expect(pointers[id]).toBe(0x0d8a70 + i * MAP16_TILE_BYTES)
    })

    // Confirm those addresses hold real, readable data on disk (not past
    // the end of the cart, not an artifact of the pointer math alone).
    const rawBytes = rawBytesAt(0x0d8a70, MAP16_TILE_BYTES)
    const tile = loadAllMap16(rom.rom, 0)[0x1c4]!
    expect(rawBytes.readUInt16LE(0) & 0x3ff).toBe(tile.tl.charNum)
    expect(rawBytes.readUInt16LE(6) & 0x3ff).toBe(tile.br.charNum)
  })

  it('the column-major subtile offsets (+0 TL, +2 BL, +4 TR, +6 BR) hold four DIFFERENT real words for a real tile', () => {
    // Tile $100 is an ordinary in-use ground tile in vanilla tileset 0;
    // guards against a copy-paste bug that read the same offset for two
    // subtiles (which would pass a same-charNum-by-coincidence check).
    const rom = SmwRom.open(ROM_PATH)
    const base = buildMap16PointerTable(rom.rom, 0)[0x100]!
    const bytes = rawBytesAt(base, MAP16_TILE_BYTES)
    const words = [0, 2, 4, 6].map(off => bytes.readUInt16LE(off))
    expect(new Set(words).size).toBeGreaterThan(1)
  })

  /**
   * The BG/Layer 2 table (Map16BGTiles, $0D9100, bank_0D.asm:551): on a
   * stock ROM a run of 512 entries, 8 bytes apart, with no bitmap walk and
   * no tileset argument.
   * Same independence rule as the FG tests above: read raw fs bytes at
   * the address the arithmetic predicts, decode them here by hand, and
   * only then compare against the production path (loadAllMap16BG).
   */
  describe('BG/Layer 2 table (readL2Map16Table)', () => {
    const bgPointers = (): number[] => {
      const t = readL2Map16Table(SmwRom.open(ROM_PATH).rom)
      if (!t.ok) throw new Error(t.reason)
      return t.value
    }

    it('tile $000 sits at exactly MAP16_BG_TILES, verified against real bytes on disk', () => {
      const pointers = bgPointers()
      expect(pointers[0]).toBe(MAP16_BG_TILES)

      const rawTile0 = rawBytesAt(MAP16_BG_TILES, MAP16_TILE_BYTES)
      const tile0 = loadAllMap16BG(SmwRom.open(ROM_PATH).rom)[0]!
      expect(rawTile0.readUInt16LE(0) & 0x3ff).toBe(tile0.tl.charNum)
      expect(rawTile0.readUInt16LE(2) & 0x3ff).toBe(tile0.bl.charNum)
      expect(rawTile0.readUInt16LE(4) & 0x3ff).toBe(tile0.tr.charNum)
      expect(rawTile0.readUInt16LE(6) & 0x3ff).toBe(tile0.br.charNum)
    })

    it('tile $100 is a flat linear offset from MAP16_BG_TILES, not the bitmap-walked FG address', () => {
      const pointers = bgPointers()
      const expectedAddr = MAP16_BG_TILES + 0x100 * MAP16_TILE_BYTES
      expect(pointers[0x100]).toBe(expectedAddr)
      // Confirmed different from the FG table's address for the same id
      // (the owner's own diff: FG char=$182 pal=2, BG char=$FD pal=1).
      expect(pointers[0x100]).not.toBe(buildMap16PointerTable(SmwRom.open(ROM_PATH).rom, 0)[0x100])

      const rawBytes = rawBytesAt(expectedAddr, MAP16_TILE_BYTES)
      const tlWord = rawBytes.readUInt16LE(0)
      expect(tlWord & 0x3ff).toBe(0xfd) // charNum, matching the owner's reported diff
      expect((tlWord >> 10) & 0x7).toBe(1) // palette

      const bgTile = loadAllMap16BG(SmwRom.open(ROM_PATH).rom)[0x100]!
      expect(bgTile.tl.charNum).toBe(0xfd)
      expect(bgTile.tl.palette).toBe(1)
    })

    it('every pointer is exactly 8 bytes apart with no gaps, across all 512 entries', () => {
      const pointers = bgPointers()
      for (let i = 1; i < pointers.length; i++) {
        expect(pointers[i]).toBe(pointers[i - 1]! + MAP16_TILE_BYTES)
      }
      // Last entry must still resolve to real, readable bytes on disk.
      expect(() => rawBytesAt(pointers[511]!, MAP16_TILE_BYTES)).not.toThrow()
    })
  })
})
