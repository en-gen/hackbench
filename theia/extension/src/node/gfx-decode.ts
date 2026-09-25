/**
 * Pure GFX-decoding logic for the Graphics view: no Theia or RPC imports, so
 * it is unit-testable the same way src/rom/ is.
 *
 * Bit-depth classification and bytes-per-tile arithmetic are NOT
 * reimplemented here: both are read from GfxLoader.inferGfxBpp and
 * GraphicsDecoder.bytesPerTile, the same functions loadGfxFile itself uses,
 * so this view's reading of a file can never drift from what the game's own
 * loader would decode (review F3). The one addition is the Mode 7 file,
 * which no tileset upload reads; see inferDefaultBpp.
 */
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import {
  GFX_FILE_COUNT,
  inferGfxBpp,
  l3DepthUnknown,
  readGfxFile,
} from '../../../../src/rom/GfxLoader'
import {
  bytesPerTile,
  decodeTilesBatch,
  tilesToRgba,
  RgbaColor,
} from '../../../../src/rom/GraphicsDecoder'
import { buildLevelCgram, loadRomPalettes } from '../../../../src/rom/PaletteLoader'
import { readLevelCol1 } from '../../../../src/rom/PaletteStockTables'
import { hex2 } from '../../../../src/rom/hex'
import {
  BYTES_PER_MODE7_TILE,
  decodeMode7Tiles,
  findMode7GfxFiles,
} from '../../../../src/rom/Mode7Gfx'
import {
  GFX_FORMATS,
  GfxFormat,
  gfxFormatLabel,
  GfxFileDto,
  GfxSheetDto,
  PALETTE_ROW_COUNT,
} from '../common/gfx-protocol'

export const GFX_TILES_PER_ROW = 16

/** Row 2 is FG Layer 1 (PaletteLoader.ts), a row most GFX files actually
 * populate, so the default preview reads as tile art rather than blank. */
export const DEFAULT_PALETTE_ROW = 2

/**
 * A GFX file is not bound to a level, so there is no header to read a BG/FG/
 * sprite variant from. buildLevelCgram needs a triple regardless; this is
 * the one gfxSheet always passes, and it rides on GfxSheetDto.paletteVariant
 * so the choice is visible rather than an invisible default (review M7).
 */
const PALETTE_VARIANT = { bg: 0, fg: 0, sprite: 0 } as const

function isGfxFormat(value: unknown): value is GfxFormat {
  return (GFX_FORMATS as readonly unknown[]).includes(value)
}

function formatBytesPerTile(format: GfxFormat): number {
  return format === 'mode7' ? BYTES_PER_MODE7_TILE : bytesPerTile(format)
}

export function decodeTiles(raw: Uint8Array, format: GfxFormat): Uint8Array[] {
  return format === 'mode7' ? decodeMode7Tiles(raw) : decodeTilesBatch(raw, format)
}

/**
 * 'mode7' for a file a Mode 7 unpack routine names, when that routine is
 * readable and the length is what its loop consumes; any other named file
 * is null, never a planar guess. Kept out of GfxLoader.inferGfxBpp because
 * a tileset upload of the same file is 3bpp, which loadVram must keep.
 *
 * For every other file, which bit depth GfxLoader.loadGfxFile will decode this file at, or null
 * when the length matches none of its rules and it falls back to a blank
 * sheet instead of decoding the bytes at any depth, or when the L3 range it
 * depends on is unreadable. A ROM whose decompressor is replaced never gets
 * here: readGfxFile refuses it first.
 */
export function inferDefaultBpp(
  rom: RomFile,
  fileIndex: number,
  rawLength: number,
): GfxFormat | null {
  if (rawLength <= 0) return null
  const mode7 = findMode7GfxFiles(rom).find(f => f.fileIndex === fileIndex)
  if (mode7) return rawLength === mode7.byteLength ? 'mode7' : null
  return inferGfxBpp(rom, fileIndex, rawLength)
}

/**
 * Every GFX file the cartridge holds, with the depth and count GfxLoader
 * reports for each. `tileCount` is null wherever `defaultBpp` is: there is
 * no depth to divide the length by, and fabricating one (128, matching
 * loadGfxFile's blank-sheet placeholder) is exactly the defect this guards.
 */
export function listGfxFileInfos(rom: SmwRom): GfxFileDto[] {
  const files: GfxFileDto[] = []
  for (let index = 0; index < GFX_FILE_COUNT; index++) {
    const read = readGfxFile(rom.rom, index)
    const raw = read.ok ? read.bytes : new Uint8Array(0)
    const bpp = inferDefaultBpp(rom.rom, index, raw.length)
    const tileCount = bpp === null ? null : Math.floor(raw.length / formatBytesPerTile(bpp))
    const file: GfxFileDto = {
      index,
      hex: hex2(index),
      byteLength: raw.length,
      defaultBpp: bpp,
      tileCount,
    }
    if (!read.ok) file.unavailable = read.reason
    files.push(file)
  }
  return files
}

/** paletteRow if it names a real CGRAM row, otherwise the default: an
 * out-of-range request is not applied, so the response must not claim it was. */
function resolvePaletteRow(paletteRow: number | undefined): number {
  if (paletteRow === undefined) return DEFAULT_PALETTE_ROW
  if (!Number.isInteger(paletteRow) || paletteRow < 0 || paletteRow >= PALETTE_ROW_COUNT) {
    return DEFAULT_PALETTE_ROW
  }
  return paletteRow
}

/**
 * Decode one GFX file to RGBA pixels, ready to paint.
 *
 * Throws rather than returning a blank sheet whenever the result would not
 * be a real decode: no data at the index, no `bpp` override on a file
 * inferDefaultBpp cannot place, or a length shorter than one tile at the
 * chosen depth (zero tiles paints nothing and a canvas cannot even be sized
 * for it). An empty or fabricated sheet looks exactly like a real one with
 * no visible tiles, which is the failure mode CLAUDE.md calls out for level
 * data and, per review C1, applies here every bit as much: emitting
 * vanilla-shaped output for a relocated arrangement is confidently wrong.
 *
 * An explicit `bpp` is still honoured even when inferDefaultBpp found no
 * depth on its own, since forcing a read is the diagnostic this override
 * exists for; it only has to produce at least one real tile.
 */
export function decodeGfxSheet(
  rom: SmwRom,
  index: number,
  bpp?: GfxFormat,
  paletteRow?: number,
): GfxSheetDto {
  if (index < 0 || index >= GFX_FILE_COUNT) {
    throw new Error(`GFX file index out of range: ${index}`)
  }
  if (bpp !== undefined && !isGfxFormat(bpp)) {
    throw new Error(`Unsupported GFX format: ${String(bpp)}`)
  }
  // Before the override: a forced depth cannot fix bytes this ROM's own
  // decompressor would never produce.
  const read = readGfxFile(rom.rom, index)
  if (!read.ok) throw new Error(`GFX file $${hex2(index)} is unavailable: ${read.reason}`)
  const raw = read.bytes
  if (raw.length === 0) {
    throw new Error(`No readable GFX data at file $${hex2(index)}`)
  }

  let actualBpp: GfxFormat
  if (bpp !== undefined) {
    actualBpp = bpp
  } else {
    const inferred = inferDefaultBpp(rom.rom, index, raw.length)
    if (inferred === null) {
      const why =
        l3DepthUnknown(rom.rom, raw.length) ??
        `${raw.length} bytes cannot be placed at 2/3/4bpp or as the Mode 7 file`
      throw new Error(`GFX file $${hex2(index)}: ${why}; pick a format explicitly to force a read`)
    }
    actualBpp = inferred
  }

  const tiles = decodeTiles(raw, actualBpp)
  if (tiles.length === 0) {
    throw new Error(
      `GFX file $${hex2(index)} is shorter than one tile as ${gfxFormatLabel(actualBpp)} (${raw.length} bytes)`,
    )
  }

  const rowIdx = resolvePaletteRow(paletteRow)
  const palettes = loadRomPalettes(rom.rom)
  const col1 = readLevelCol1(rom.rom)
  if ('reason' in col1) throw new Error(`Palette column 1 is unavailable: ${col1.reason}`)
  const cgram = buildLevelCgram(
    palettes,
    PALETTE_VARIANT.bg,
    PALETTE_VARIANT.fg,
    PALETTE_VARIANT.sprite,
    col1,
  )
  const row = cgram.rows[rowIdx] ?? []
  const { rgba, width, height } = tilesToRgba(tiles, row as RgbaColor[], GFX_TILES_PER_ROW)

  return {
    index,
    hex: hex2(index),
    bpp: actualBpp,
    tileCount: tiles.length,
    width,
    height,
    paletteRow: rowIdx,
    paletteVariant: { ...PALETTE_VARIANT },
    rgbaBase64: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).toString('base64'),
  }
}
