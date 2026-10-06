/**
 * The GFX service, as seen from both sides.
 *
 * Decoding a GFX file needs the ROM on disk, which only the backend can read.
 * This is a backend service the frontend calls over JSON-RPC, and this file
 * is the contract both ends compile against. Mirrors project-protocol.ts in
 * shape but stays a separate file and a separate RPC path, so the graphics
 * view can change without touching the maps view or its siblings.
 */
import { RomIdentityDto } from './project-protocol'

/** Where the frontend reaches the backend. Must match the backend binding. */
export const GFX_SERVICE_PATH = '/services/hackbench-gfx'

export const GfxService = Symbol('GfxService')

export type GfxBpp = 2 | 3 | 4

/**
 * How a sheet's bytes are read: a planar bit depth, or 'mode7' for the file
 * the game unpacks as packed 3-bit Mode 7 pixels (src/rom/Mode7Gfx.ts).
 */
export type GfxFormat = GfxBpp | 'mode7'

export const GFX_FORMATS: readonly GfxFormat[] = [2, 3, 4, 'mode7']

export function gfxFormatLabel(format: GfxFormat): string {
  return format === 'mode7' ? 'Mode 7' : `${format}bpp`
}

/** CGRAM is 16 rows of 16 colours on real hardware, not a per-ROM fact. */
export const PALETTE_ROW_COUNT = 16

/** One GFX file the cartridge holds, as GfxLoader reads it. */
export interface GfxFileDto {
  index: number
  /** Two-digit hex file id, e.g. "00".."31" for vanilla's 50 files. */
  hex: string
  /** Decompressed byte length, before any bit-depth decode. */
  byteLength: number
  /**
   * Format this file is read in: 'mode7' for the file CODE_00AB42 unpacks
   * (Mode7Gfx.findMode7GfxFile), otherwise the depth GfxLoader infers - 2bpp
   * for the Layer 3 range read from CODE_00A993, else loadGfxFile's size rule.
   * Null when the length is zero or fits none of those rules: a relocated
   * GFX arrangement (observed on real hacks, not only a corrupt ROM) that
   * this build cannot place at any depth. gfxSheet refuses to decode such a
   * file without an explicit `bpp`, per CLAUDE.md's fail-closed rule.
   */
  defaultBpp: GfxFormat | null
  /** Tile count at defaultBpp. Null exactly when defaultBpp is null: there
   * is no real count to report, and reporting one anyway is the defect. */
  tileCount: number | null
  /** Why the file cannot be read at all (the GFX read gate's reason), for the
   * explorer to show. Absent on a readable file. */
  unavailable?: string
}

/**
 * Why listing GFX files is a result rather than a throw.
 *
 * Mirrors LoadMapsResult: a project names its cartridge by hash and never by
 * path, so not finding it on this machine is an ordinary first-run state,
 * answered by asking the user to locate it.
 */
export type LoadGfxFilesResult =
  { status: 'ok'; files: GfxFileDto[] } | { status: 'rom-not-located'; baseRom: RomIdentityDto }

/**
 * Which CGRAM configuration coloured a preview.
 *
 * A GFX file is not bound to a level, so there is no level header to read
 * these from; buildLevelCgram needs them regardless, and gfxSheet always
 * passes 0/0/0. Carried on the DTO so that choice is visible and
 * reproducible rather than an invisible default the user cannot see or name.
 */
export interface PaletteVariantDto {
  bg: number
  fg: number
  sprite: number
}

/**
 * A decoded tile sheet, ready to paint.
 *
 * `bpp` and `paletteRow` report what was actually USED to produce
 * `rgbaBase64`, never the raw request: an out-of-range `paletteRow` falls
 * back to the default row rather than being echoed back as if it had been
 * applied.
 */
export interface GfxSheetDto {
  index: number
  hex: string
  bpp: GfxFormat
  tileCount: number
  width: number
  height: number
  /** Which of the 16 CGRAM rows actually coloured this preview. */
  paletteRow: number
  paletteVariant: PaletteVariantDto
  /** RGBA8888 pixels, row-major, 16 tiles per row, base64-encoded. */
  rgbaBase64: string
}

/** One overworld layer: RGBA on a clear canvas, and a priority byte per `prioCell` block. */
export interface OverworldLayerDto {
  rgbaBase64: string
  prioBase64: string
}

/**
 * An Overworld canvas's layers, composed in the browser (OverworldComposite)
 * so a layer toggle needs no round trip, or why it cannot be drawn. A
 * refusal carries no pixels: the view shows the reason and no canvas.
 * The hub is half 0 at 512x512 with a priority byte per 8x8 cell; an area
 * is its 256x224 camera window over half 1 with one per pixel.
 */
export type OverworldDto =
  | {
      status: 'ok'
      /** CGRAM color 0, RGBA. */
      backdrop: number[]
      width: number
      height: number
      prioCell: number
      l1: OverworldLayerDto
      /** Absent exactly when `l2Unavailable` says why. */
      l2?: OverworldLayerDto
      l2Unavailable?: string
    }
  | { status: 'unavailable'; reason: string }

/** The explorer's area rows (area 0 is the Overworld row), or why there are none. */
export type OverworldAreasDto =
  | { status: 'ok'; areas: { area: number; invalid?: string }[] }
  | { status: 'unavailable'; reason: string }

export interface GfxService {
  /** Every GFX file the project's base cartridge holds. */
  listGfxFiles(manifestPath: string): Promise<LoadGfxFilesResult>

  /**
   * Decode one GFX file to a paintable tile sheet.
   *
   * Throws when the file has nothing readable, OR when it has no `bpp`
   * override and GfxLoader.loadGfxFile itself could not place the bytes at
   * any depth (GfxFileDto.defaultBpp null): the caller must say so rather
   * than being handed loadGfxFile's blank-sheet fallback labelled as real
   * tile data.
   *
   * `bpp` overrides the loader's inferred depth, since a sheet's true depth
   * is not always knowable and the user may want to force a read; an
   * unsupported value is rejected rather than silently reinterpreted, and a
   * length shorter than one tile at the chosen depth is rejected too, rather
   * than returning a zero-height sheet a canvas cannot paint.
   * `paletteRow` picks which CGRAM row colours the preview; both default to
   * the loader's own reading when omitted, and an out-of-range paletteRow
   * falls back to that default rather than being applied.
   */
  gfxSheet(
    manifestPath: string,
    index: number,
    bpp?: GfxFormat,
    paletteRow?: number,
  ): Promise<GfxSheetDto>

  /** The hub: half 0's L2 and L1 in area 0's tileset and palette (overworld-decode.ts). */
  overworld(manifestPath: string): Promise<OverworldDto>

  /** The areas the ROM names, for the explorer's child rows. */
  overworldAreas(manifestPath: string): Promise<OverworldAreasDto>

  /** Area `area`'s camera window over half 1; unavailable with a reason for an invalid area. */
  overworldArea(manifestPath: string, area: number): Promise<OverworldDto>
}
