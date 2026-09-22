/**
 * The palette service, as seen from both sides.
 *
 * Read-only: there is no save path, so unlike ProjectService this is a thin
 * RPC wrapper around a single query. Own file, own path, so this view can
 * evolve without touching project-protocol.ts (shared with two sibling
 * views under concurrent development).
 *
 * This is the STOCK TABLES view: what loadRomPalettes() reads straight out
 * of the cartridge, not the composed runtime CGRAM a level or the overworld
 * actually loads (that needs Lunar Magic custom-palette detection and a
 * chosen context first, and is a follow-up).
 */
import { RomIdentityDto } from './project-protocol'

export const PALETTE_SERVICE_PATH = '/services/hackbench-palette'

export const PaletteService = Symbol('PaletteService')

export interface PaletteColorDto {
  r: number
  g: number
  b: number
  a: number
}

/**
 * One CGRAM cell as the STOCK TABLES read it.
 *
 * `written: false` means no table this view reads ever supplies this cell;
 * there is no `color` and no address, because inventing either would be
 * exactly the fabricated-citation failure this DTO exists to prevent (issue
 * #311). A cell with `written: true` always names the ROM table it came
 * from: src/rom/PaletteStockTables.ts merges several tables per row (a
 * background row's cols 2-7 are BackgroundPalettes, cols 8-15 are
 * StatusBarColors, col 0 is BackAreaColors, col 1 is a routine rather than
 * a table), so one address for the whole row would misattribute most of it.
 */
export type PaletteCellDto =
  | { written: true; color: PaletteColorDto; table: string; romAddr: number | null }
  | { written: false }

/** One CGRAM-row-shaped strip of 16 cells, lowest index first. */
export type PaletteRowDto = PaletteCellDto[]

/**
 * One variant of a group (e.g. one of the 8 background palettes).
 *
 * `backAreaColor` is attached only to the 'bg' group's variants: BackAreaColor
 * is selected by the same index as the background variant (PaletteLoader.ts's
 * ADDR_BACK_AREA + variant*2), so it rides along with the variant it belongs
 * to rather than living as an unexplained separate list.
 */
export interface PaletteVariantDto {
  label: string
  /** Null when the source address has not been verified against the ASM. */
  romAddr: number | null
  rows: PaletteRowDto[]
  backAreaColor?: PaletteColorDto
}

/**
 * One palette group (e.g. Layer 1 Foreground). Mirrors
 * src/rom/PaletteLoader.PaletteGroup; declared again here because this file
 * is the wire contract and must not drag the ROM layer into the frontend
 * bundle.
 */
export interface PaletteGroupDto {
  id: string
  label: string
  description: string
  /** First CGRAM row this group's own table targets, or null if it has none. */
  cgRamRow: number | null
  variants: PaletteVariantDto[]
}

export interface RomPalettesDto {
  groups: PaletteGroupDto[]
  /**
   * How many levels carry a Lunar Magic custom palette block this view does
   * not read (PaletteStockTables.ts's countCustomPaletteLevels). Zero for a
   * cart with none. A romhack with any means these stock tables are not
   * the whole story for those levels.
   */
  customPaletteLevelCount: number
}

/**
 * Why loading a palette is a result rather than a throw.
 *
 * `unreadable` is distinct from `ok`: PaletteLoader's reads default silently
 * to a filler colour on a short read (RomFile.readAt returns null past the
 * end of the file), so a truncated or garbage ROM would otherwise come back
 * `ok` with a full grid of fabricated cells and no signal anything failed.
 */
export type LoadPaletteResult =
  | { status: 'ok'; palettes: RomPalettesDto; romName: string }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }
  | { status: 'unreadable'; reason: string }

export interface PaletteService {
  /**
   * Every stock palette table the project's base cartridge holds.
   *
   * Resolves the ROM through the registry; reports `rom-not-located` rather
   * than failing when this machine has not been told where it is, and
   * `unreadable` rather than a fabricated-looking `ok` when the cartridge is
   * too short to actually contain this data.
   */
  loadPalettes(manifestPath: string): Promise<LoadPaletteResult>
}
