/**
 * Unit tests for the Graphics view's decode logic (theia/extension/src/node/gfx-decode.ts).
 *
 * Swept across more than one GFX file, per CLAUDE.md's rule against
 * single-case acceptance tests: a standard file, the Layer 3 range GfxLoader
 * itself reports, and the Mario 3bpp file (GfxLoader.GFX_MARIO_3BPP_INDEX).
 * A separate describe block below sweeps the ROM CORPUS rather than one
 * file at a time: vanilla's own GFX is uniformly placeable at 2/3/4bpp, so
 * only a hack with a relocated arrangement (Invictus 1.0) exercises the
 * fail-closed path at all.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  GFX_FILE_COUNT,
  GFX_MARIO_3BPP_INDEX,
  getLayer3GfxRange,
  loadGfxRaw,
} from '../../../src/rom/GfxLoader'
import { decode4bpp } from '../../../src/rom/GraphicsDecoder'
import {
  decodeGfxSheet,
  inferDefaultBpp,
  listGfxFileInfos,
  GFX_TILES_PER_ROW,
} from '../../../theia/extension/src/node/gfx-decode'

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

describe.skipIf(!romPresent)('gfx-decode (ROM-only)', () => {
  it('listGfxFileInfos returns every file GfxLoader reports, each with a real tile count', () => {
    const rom = SmwRom.open(ROM_PATH)
    const files = listGfxFileInfos(rom)

    expect(files.length).toBe(GFX_FILE_COUNT)
    expect(files[0]!.hex).toBe('00')
    expect(files[GFX_FILE_COUNT - 1]!.hex).toBe(hex2(GFX_FILE_COUNT - 1))
    for (const f of files) {
      expect(f.byteLength).toBeGreaterThan(0)
      expect(f.tileCount).toBeGreaterThan(0)
      expect([2, 3, 4, 'mode7']).toContain(f.defaultBpp)
    }
  })

  it('reads the Mode 7 file as Mode 7, and only that file', () => {
    const rom = SmwRom.open(ROM_PATH)
    const files = listGfxFileInfos(rom)
    expect(files.filter(f => f.defaultBpp === 'mode7').map(f => f.index)).toEqual([0x27])
    const sheet = decodeGfxSheet(rom, 0x27)
    expect(sheet.bpp).toBe('mode7')
    expect(sheet.tileCount).toBe(128)
  })

  it('infers 3bpp for a standard file (file 0)', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = loadGfxRaw(rom.rom, 0)
    expect(inferDefaultBpp(rom.rom, 0, raw.length)).toBe(3)
  })

  it('infers 2bpp for the Layer 3 range GfxLoader itself reports', () => {
    const rom = SmwRom.open(ROM_PATH)
    const l3 = getLayer3GfxRange(rom.rom)
    const raw = loadGfxRaw(rom.rom, l3.start)

    // The precondition inferDefaultBpp's Layer 3 branch requires. If this
    // fails the test below is not exercising the branch it claims to.
    expect(raw.length % 16).toBe(0)
    expect(inferDefaultBpp(rom.rom, l3.start, raw.length)).toBe(2)
  })

  it('infers 3bpp for the Mario sprite file (GFX20 hex)', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = loadGfxRaw(rom.rom, GFX_MARIO_3BPP_INDEX)
    expect(inferDefaultBpp(rom.rom, GFX_MARIO_3BPP_INDEX, raw.length)).toBe(3)
  })

  it('decodes file 0 to a non-uniform RGBA sheet, 16 tiles wide', () => {
    const rom = SmwRom.open(ROM_PATH)
    const sheet = decodeGfxSheet(rom, 0)

    expect(sheet.width).toBe(GFX_TILES_PER_ROW * 8)
    expect(sheet.height).toBe(Math.ceil(sheet.tileCount / GFX_TILES_PER_ROW) * 8)

    const bytes = Buffer.from(sheet.rgbaBase64, 'base64')
    expect(bytes.length).toBe(sheet.width * sheet.height * 4)
    // A flat decode (every pixel the same colour) is the failure mode this
    // guards: real GFX data has more than one colour index in a 128-tile
    // sheet under any populated palette row.
    expect(new Set(bytes).size).toBeGreaterThan(1)
  })

  it('decodes the Mario sprite file to a non-uniform sheet too', () => {
    const rom = SmwRom.open(ROM_PATH)
    const sheet = decodeGfxSheet(rom, GFX_MARIO_3BPP_INDEX)
    const bytes = Buffer.from(sheet.rgbaBase64, 'base64')
    expect(new Set(bytes).size).toBeGreaterThan(1)
  })

  it('an explicit bpp override changes the tile count, not just the label', () => {
    const rom = SmwRom.open(ROM_PATH)
    const at3 = decodeGfxSheet(rom, 0, 3)
    const at4 = decodeGfxSheet(rom, 0, 4)

    expect(at3.bpp).toBe(3)
    expect(at4.bpp).toBe(4)
    // Same raw bytes, different bytes-per-tile: the counts must differ,
    // otherwise the override is cosmetic and not actually re-decoding.
    expect(at3.tileCount).not.toBe(at4.tileCount)
  })

  it('a palette row choice is echoed back and used, not silently ignored', () => {
    const rom = SmwRom.open(ROM_PATH)
    const row0 = decodeGfxSheet(rom, 0, undefined, 0)
    const row2 = decodeGfxSheet(rom, 0, undefined, 2)

    expect(row0.paletteRow).toBe(0)
    expect(row2.paletteRow).toBe(2)
    // Different CGRAM rows colour a real tileset differently; identical
    // output bytes would mean the row parameter never reached the decode.
    expect(row0.rgbaBase64).not.toBe(row2.rgbaBase64)
  })

  it('discloses which CGRAM variant coloured the preview, not just the row', () => {
    // buildLevelCgram needs a BG/FG/sprite variant triple and a GFX file has
    // no level header to read one from, so gfxSheet fixes it at 0/0/0. That
    // choice colours half the palette rows' columns 8-15 solid black (review
    // M7); it has to be on the DTO so a caller can at least see and name it.
    const rom = SmwRom.open(ROM_PATH)
    const sheet = decodeGfxSheet(rom, 0)
    expect(sheet.paletteVariant).toEqual({ bg: 0, fg: 0, sprite: 0 })
  })

  it('throws rather than returning a blank sheet for an out-of-range index', () => {
    const rom = SmwRom.open(ROM_PATH)
    expect(() => decodeGfxSheet(rom, GFX_FILE_COUNT + 5)).toThrow()
    expect(() => decodeGfxSheet(rom, -1)).toThrow()
  })

  it('infers null, not a guessed depth, for a length that fits no rule', () => {
    const rom = SmwRom.open(ROM_PATH)
    // File 0 is outside every ROM's Layer 3 range; 100 divides evenly by
    // none of 16/24/32, the same condition under which loadGfxFile itself
    // gives up and returns a blank sheet instead of decoding the bytes.
    expect(inferDefaultBpp(rom.rom, 0, 100)).toBeNull()
  })

  it('rejects an unsupported bpp rather than silently reinterpreting it', () => {
    const rom = SmwRom.open(ROM_PATH)
    // decodeTilesBatch treats any bpp that is not 3 or 4 as 2bpp, so an
    // unchecked call here would quietly decode file 0 at the wrong depth
    // and still label the result "5bpp".
    expect(() => decodeGfxSheet(rom, 0, 5 as unknown as 2 | 3 | 4)).toThrow()
  })

  it('rejects a null bpp rather than decoding at a real depth and echoing null', () => {
    const rom = SmwRom.open(ROM_PATH)
    // JSON-RPC can turn an omitted optional argument into `null` rather than
    // `undefined`. A guard written as `bpp !== undefined` alone would let a
    // null through as "no override" while a guard that only checks falsiness
    // in the wrong place could decode anyway and still report bpp: null --
    // the exact echoed-as-requested shape review C2 flagged.
    expect(() => decodeGfxSheet(rom, 0, null as unknown as 2 | 3 | 4)).toThrow()
  })

  it('the reported bpp always matches the bytes actually decoded, not the raw request', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = loadGfxRaw(rom.rom, 0)
    for (const requested of [undefined, 2, 3, 4] as const) {
      const sheet = decodeGfxSheet(rom, 0, requested)
      const bytesPerTile = sheet.bpp === 4 ? 32 : sheet.bpp === 3 ? 24 : 16
      // Ties the label to the actual arithmetic that produced tileCount,
      // rather than trusting the field name: a decode that quietly used one
      // depth while labelling another would fail this even if bpp "looks"
      // like a plausible number.
      expect(sheet.tileCount).toBe(Math.floor(raw.length / bytesPerTile))
      if (requested !== undefined) expect(sheet.bpp).toBe(requested)
    }
  })

  it('a bit-depth override producing zero tiles is refused, not a zero-height sheet', () => {
    // Invictus file $0E is 29 bytes; forced to 4bpp (32 bytes/tile) that is
    // zero tiles. A canvas cannot be sized for a zero-height ImageData, so
    // the refusal has to happen here, not in the widget that paints it.
    const invictusPath = resolve(__dirname, '../../roms/Invictus 1.0.sfc')
    if (!existsSync(invictusPath)) return
    const rom = SmwRom.open(invictusPath)
    expect(() => decodeGfxSheet(rom, 0x0e, 4)).toThrow(/shorter than one tile/i)
  })

  /**
   * Content-pinning: hand-built 4bpp bytes with one known pixel per bitplane,
   * so a swapped bitplane pair or a row/stride error changes the decoded
   * pixel values rather than merely the count. distinctColors-style checks
   * cannot see either defect; a mutation sweep against GraphicsDecoder.ts
   * found bitplane-swap and stride mutants that undetected suites like that
   * would miss (review C2). This does not re-verify GraphicsDecoder.ts's own
   * suite, only that gfx-decode.ts's pipeline (decodeTilesBatch -> tilesToRgba)
   * preserves what it returns.
   */
  it('preserves bitplane order and row stride through decodeTilesBatch/tilesToRgba', () => {
    const tile = new Uint8Array(32)
    tile[0] = 0x80 // p0lo row0 -> plane0 (value 1) at col 0
    tile[1] = 0x40 // p0hi row0 -> plane1 (value 2) at col 1
    tile[16] = 0x20 // p1lo row0 -> plane2 (value 4) at col 2
    tile[17] = 0x10 // p1hi row0 -> plane3 (value 8) at col 3
    const px = decode4bpp(tile, 0)

    expect(Array.from(px.slice(0, 8))).toEqual([1, 2, 4, 8, 0, 0, 0, 0])
    // Every row below the first must stay zero: a stride bug leaks a
    // set bit into the wrong row instead of only the wrong column.
    for (let row = 1; row < 8; row++) {
      expect(Array.from(px.slice(row * 8, row * 8 + 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    }
  })

  it('an out-of-range palette row falls back to the default instead of being echoed as applied', () => {
    const rom = SmwRom.open(ROM_PATH)
    const atDefault = decodeGfxSheet(rom, 0, undefined, 2)
    const outOfRange = decodeGfxSheet(rom, 0, undefined, 999)

    // The DTO must report the row actually used, not the bogus request:
    // reporting 999 here would be exactly the false claim this guards.
    expect(outOfRange.paletteRow).toBe(2)
    expect(outOfRange.rgbaBase64).toBe(atDefault.rgbaBase64)
  })
})

/**
 * Corpus sweep (review M6): a single vanilla cart cannot exercise the
 * fail-closed path at all, since every one of its GFX files lands cleanly at
 * 2/3/4bpp. Six carts, four of them hacks with real GFX changes.
 */
// Declared, not discovered: the `.filter(existsSync)` this list used to carry
// removed the absent carts from the loop below, so on a clone without the
// corpus the six cases were never registered at all. Keeping every cart in
// the list and gating each one with `skipIf` makes the skip count name them.
const CORPUS = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
].map(name => ({ name, path: resolve(__dirname, '../../roms', name) }))

describe('gfx-decode corpus sweep', () => {
  for (const { name, path } of CORPUS) {
    it.skipIf(!existsSync(path))(
      `${name}: every file's availability is honest (tileCount null iff defaultBpp null)`,
      () => {
        const rom = SmwRom.open(path)
        const files = listGfxFileInfos(rom)
        expect(files.length).toBe(GFX_FILE_COUNT)
        for (const f of files) {
          if (f.defaultBpp === null) {
            expect(f.tileCount).toBeNull()
          } else {
            expect(f.tileCount).toBeGreaterThan(0)
            // 'mode7' packs 64 3-bit pixels into 24 bytes, the same as 3bpp.
            const bytesPerTile = f.defaultBpp === 4 ? 32 : f.defaultBpp === 2 ? 16 : 24
            expect(f.tileCount).toBe(Math.floor(f.byteLength / bytesPerTile))
            // The list's own arithmetic must agree with what a real decode
            // produces, not merely look plausible.
            expect(decodeGfxSheet(rom, f.index).tileCount).toBe(f.tileCount)
          }
        }
      },
    )
  }
})

describe.skipIf(!existsSync(resolve(__dirname, '../../roms/Invictus 1.0.sfc')))(
  'gfx-decode (Invictus, relocated GFX)',
  () => {
    const INVICTUS_PATH = resolve(__dirname, '../../roms/Invictus 1.0.sfc')

    it('reports most files unavailable rather than a fabricated 128-tile placeholder', () => {
      const rom = SmwRom.open(INVICTUS_PATH)
      const files = listGfxFileInfos(rom)
      const unavailable = files.filter(f => f.defaultBpp === null)
      // Measured directly on this cart: 49 of 50. Asserted as "most", not the
      // exact figure, so a harmless future re-dump does not make this brittle.
      expect(unavailable.length).toBeGreaterThan(40)
      for (const f of unavailable) {
        expect(f.tileCount).toBeNull()
        expect(f.byteLength).toBeGreaterThanOrEqual(0)
      }
    })

    it("refuses to decode an unavailable file by default rather than painting loadGfxFile's blank sheet", () => {
      const rom = SmwRom.open(INVICTUS_PATH)
      const files = listGfxFileInfos(rom)
      const target = files.find(f => f.defaultBpp === null)
      expect(target).toBeDefined()
      expect(() => decodeGfxSheet(rom, target!.index)).toThrow()
    })

    it('still honours an explicit bpp override on an unavailable file, since forcing a read is the point of it', () => {
      const rom = SmwRom.open(INVICTUS_PATH)
      const files = listGfxFileInfos(rom)
      const target = files.find(f => f.defaultBpp === null && f.byteLength >= 24)
      expect(target).toBeDefined()
      const sheet = decodeGfxSheet(rom, target!.index, 3)
      expect(sheet.bpp).toBe(3)
      expect(sheet.tileCount).toBeGreaterThan(0)
    })
  },
)

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0')
}
