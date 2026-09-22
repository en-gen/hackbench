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
 * No `backAreaColor` here: back area colours are not palette data (they are
 * never written into CGRAM - see the 'back_area' group's own description)
 * and are selected by an independent header field, byte 1 rather than the
 * BG variant's byte 0. Pairing one with each BG variant used to imply a
 * link the cartridge does not have; they are their own standalone group now.
 */
export interface PaletteVariantDto {
  label: string
  /** Null when the source address has not been verified against the ASM. */
  romAddr: number | null
  rows: PaletteRowDto[]
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

/**
 * Result of an edit. Shares `LoadPaletteResult`'s shape for `ok` so the
 * widget can drop the response straight into the same `result` field it
 * already re-renders from - `setColor` and `loadPalettes` answer the same
 * question ("what does the working copy look like now"), just after a
 * different action.
 *
 * `stale` covers WorkingRom.append's own refusal: the address no longer
 * holds the `old` value the caller expected (moved by another edit, or a
 * bad request), so nothing was written rather than overwriting the wrong
 * bytes.
 *
 * `io-error` covers `ops/`'s write-back failing (read-only directory, full
 * disk, a file locked by another process) AFTER the in-memory layer already
 * validated. The working copy is rolled back to match - an edit that is
 * live in memory but not on disk would render as committed and then vanish
 * on the next launch, which is worse than refusing it up front.
 */
export type SetColorResult =
  LoadPaletteResult | { status: 'stale'; reason: string } | { status: 'io-error'; reason: string }

/**
 * Pushed to the frontend when a project's working copy changes. No payload
 * beyond which project: a subscriber re-fetches (`loadPalettes`) rather than
 * being handed a diff, same reasoning as `SetColorResult`.
 */
export interface PaletteServiceClient {
  onWorkingCopyChanged(manifestPath: string): void
}

export interface PaletteService {
  /** Registers the frontend's push target. Theia calls this once per connection. */
  setClient(client: PaletteServiceClient | undefined): void

  /**
   * Every stock palette table the project's base cartridge holds.
   *
   * Resolves the ROM through the registry; reports `rom-not-located` rather
   * than failing when this machine has not been told where it is, and
   * `unreadable` rather than a fabricated-looking `ok` when the cartridge is
   * too short to actually contain this data.
   */
  loadPalettes(manifestPath: string): Promise<LoadPaletteResult>

  /**
   * Write one BGR555 word to the project's working copy: records one `edit`
   * layer and persists it to `ops/`. `oldHex` is the word currently
   * committed at `romAddr`; the caller (OK, or a hex field Enter) reads it
   * fresh from what is on screen right before calling this, so it always
   * matches what the cartridge actually holds - there is no live preview
   * layer that could move it out from under the check in between.
   */
  setColor(
    manifestPath: string,
    romAddr: number,
    oldHex: string,
    newHex: string,
  ): Promise<SetColorResult>
}
