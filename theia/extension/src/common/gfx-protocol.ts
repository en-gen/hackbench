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
   * Bit depth GfxLoader infers for this file: 2bpp for the Layer 3 range
   * read from CODE_00A993, otherwise the size-based rule loadGfxFile uses.
   * Null when the length is zero or fits none of those rules: a relocated
   * GFX arrangement (observed on real hacks, not only a corrupt ROM) that
   * this build cannot place at any depth. gfxSheet refuses to decode such a
   * file without an explicit `bpp`, per CLAUDE.md's fail-closed rule.
   */
  defaultBpp: GfxBpp | null
  /** Tile count at defaultBpp. Null exactly when defaultBpp is null: there
   * is no real count to report, and reporting one anyway is the defect. */
  tileCount: number | null
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
  bpp: GfxBpp
  tileCount: number
  width: number
  height: number
  /** Which of the 16 CGRAM rows actually coloured this preview. */
  paletteRow: number
  paletteVariant: PaletteVariantDto
  /** RGBA8888 pixels, row-major, 16 tiles per row, base64-encoded. */
  rgbaBase64: string
}

/**
 * Pushed to the frontend when the WORKING COPY a project's sheets are
 * decoded from changes - a palette edit made through a different view, most
 * concretely. There is no payload beyond which project: the client re-fetches
 * rather than being told what to redraw, same as `SetColorResult` answers
 * "what does it look like now" rather than a diff.
 */
export interface GfxServiceClient {
  onWorkingCopyChanged(manifestPath: string): void
}

export interface GfxService {
  /** Registers the frontend's push target. Theia calls this once per connection. */
  setClient(client: GfxServiceClient | undefined): void

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
    bpp?: GfxBpp,
    paletteRow?: number,
  ): Promise<GfxSheetDto>
}
