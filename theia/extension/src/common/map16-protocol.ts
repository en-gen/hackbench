/**
 * The Map16 service, as seen from both sides.
 *
 * Mirrors gfx-protocol.ts's shape: decoding needs the ROM on disk, so this is
 * a backend service the frontend calls over JSON-RPC, with its own path so
 * this view can change without touching the palette or GFX contracts.
 *
 * Constants and shapes here are declared fresh rather than imported from
 * src/rom/Map16.ts, on purpose - see palette-protocol.ts's own comment on
 * PaletteGroupDto: importing the ROM layer here would drag RomFile (and its
 * `fs` import) into the frontend bundle.
 */
import { RomIdentityDto } from './project-protocol'

export const MAP16_SERVICE_PATH = '/services/hackbench-map16'

export const Map16Service = Symbol('Map16Service')

/** Object tilesets 0-14 (TILESET_COUNT in src/rom/Map16.ts). */
export const MAP16_TILESET_COUNT = 15
export const MAP16_TILES_PER_ROW = 16

/**
 * There are two SEPARATE 512-block Map16 tables (MapEditorProvider.ts:388-390
 * loads both for a level): `fg` is the per-tileset object/terrain table
 * (`buildMap16PointerTable` + `loadAllMap16`, what this view showed before
 * this axis existed); `bg` is the GLOBAL Layer 2 preset table
 * (`buildL2Map16PointerTable` + `loadAllMap16BG`, one fixed table, no
 * tileset). They share nothing - block `$100` is a different subtile entry
 * in each. `tileset` still applies to `bg` sheets for VRAM/GFX-assignment
 * purposes, and NOT merely nominally: `readGfxAssignment` yields 13 distinct
 * assignments across the 15 vanilla tilesets in the `fg3`/`an1` slots alone
 * (chars $100-$1FF), and 1310 of the BG table's 2048 subtiles (64.0%) sit in
 * those two slots - measured on the real cartridge, not assumed. So while
 * the BLOCK TABLE itself does not vary with tileset for `bg`, the rendered
 * PIXELS visibly do, for most of the sheet; the tileset control stays
 * enabled for both layers, and only its MEANING changes (table selector on
 * `fg`, graphics-only on `bg`) - the widget's label reflects that rather
 * than disabling a control with a large, real effect.
 */
export type Map16Layer = 'fg' | 'bg'

/**
 * Number of BackgroundPalettes/ForegroundPalettes variants (PaletteLoader.ts:
 * $00B0B0 and $00B190, 8 x 24-byte packed pairs each) - the range a
 * `Map16PaletteVariantDto` field can name.
 */
export const MAP16_PALETTE_VARIANT_COUNT = 8

/**
 * Which BG/FG CGRAM palette variant colors a Map16 sheet - INDEPENDENT of a
 * subtile's own 3-bit `palette` field (which CGRAM ROW, 0-7, a subtile
 * reads). This is which COLORS load into those rows in the first place:
 * `bg` picks BackgroundPalettes[bg] into CGRAM rows 0-1, `fg` picks
 * ForegroundPalettes[fg] into rows 2-3 (buildLevelCgram in PaletteLoader.ts).
 * Rows 4-7 (StandardColors) have no variant axis at all, so a subtile using
 * one of those rows is unaffected by either choice. No `sprite` field here:
 * buildLevelCgram's sprite parameter only reaches CGRAM rows 14-15, which a
 * Map16 subtile's 3-bit palette field (0-7) can never select.
 */
export interface Map16PaletteVariantDto {
  bg: number
  fg: number
}

/** Which CGRAM rows a `Map16PaletteVariantDto` field feeds - see
 * `Map16SheetDto.citedPaletteRows`'s own doc comment for why this is a
 * fixed mapping the WIDGET applies, not a per-cart fact. */
export const BG_PALETTE_ROWS: readonly number[] = [0, 1]
export const FG_PALETTE_ROWS: readonly number[] = [2, 3]

export type Map16SubtileKey = 'tl' | 'tr' | 'bl' | 'br'

/** Which subtile field an edit targets. `charNum` included: see the widget
 * for why it is editable here (a 10-bit index, masked on write either way). */
export type Map16Field = 'charNum' | 'palette' | 'priority' | 'flipX' | 'flipY'

/** One decoded subtile, plus the ROM address of its own 16-bit word - the
 * unit an edit actually writes. */
export interface Map16SubTileDto {
  charNum: number
  palette: number
  priority: boolean
  flipX: boolean
  flipY: boolean
  /** 24-bit SNES address of this subtile's own word within the 8-byte entry. */
  romAddr: number
}

/** One 16x16 Map16 block: four subtiles plus the entry's own base address. */
export interface Map16BlockDto {
  id: number
  /** Address of the block's 8-byte entry (== `tl.romAddr`). */
  romAddr: number
  /**
   * Whether this block's bytes are SHARED rather than private to the
   * current tileset, so an edit reaches more than the tileset on screen.
   *
   * `buildMap16PointerTable` interleaves per-tileset entries with the
   * shared `Map16Common` run at `$0D8000`, driven by the bitmap at
   * `$0581BB`, so "which tileset owns this block" varies BY BLOCK and
   * cannot be answered per sheet. Measured on the vanilla cart: 326 of 512
   * FG ids resolve to a byte-identical address on all 15 tilesets, 63.7%,
   * and every one of them lies inside the common run. The inspector said
   * "other tilesets keep their own bytes" for all 512, which was
   * confidently wrong about a destructive edit for most of them.
   *
   * Always true on the `bg` layer: that table is global, so every edit to
   * it is shared by construction.
   */
  shared: boolean
  tl: Map16SubTileDto
  tr: Map16SubTileDto
  bl: Map16SubTileDto
  br: Map16SubTileDto
}

/**
 * The CHARACTER-animation model for a decoded sheet: a separate memory
 * model built while reading graphics (src/rom/model/chars - `buildChars` +
 * `AnimatedPixelsBehavior`, `AnimationLoader.loadAnimationData`), not a
 * bare extra field bolted onto the sheet. Present on `Map16SheetDto` only
 * when this tileset's VRAM actually has animated chars - ABSENT, not an
 * empty/zero-phase object, when it does not; a model with no phases and a
 * play button that runs anyway is the exact defect CLAUDE.md's "oracles
 * must be proven able to fail" section warns about for a different check.
 *
 * `frameCount`/`intervalMs` are FACTS read from the cartridge
 * (`loadAnimationData`), never invented or rounded by a UI default. A
 * playback-speed control, if one ships, is a multiplier layered on TOP of
 * `intervalMs` - "native" (multiplier 1) must always stay reachable so the
 * user can get back to what the cart actually does.
 *
 * This is CHARACTER animation only - GFX pixels swapped in the `an1` VRAM
 * region (or wherever a hack routes them; see `animatedBlockIds`). There is
 * a SEPARATE, independently-clocked PALETTE animation
 * (`PaletteAnimationDetect.ts`'s `detectPaletteAnimation`, CGRAM $64, 8
 * phases, 67ms on vanilla and GPW2 alike - a different period from this
 * model's `frameCount`/`intervalMs`, never sharing a counter with it) that
 * this model does NOT carry. `buildLevelCgram` here produces a static
 * CGRAM, so a Yoshi/dragon coin's TILES animate while its COLOR does not -
 * a known, stated gap, not a silent one, and out of this task's scope.
 */
export interface Map16CharAnimationDto {
  frameCount: number
  intervalMs: number
  /**
   * One full composited RGBA atlas per phase, same dimensions as the
   * sheet's own `rgbaBase64` - `phases[0]` IS `rgbaBase64` (the identical
   * base64 string, not independently recomputed), since a still sheet
   * showing anything other than the animation's own frame 0 would be an
   * arbitrary, undocumented choice rather than the explicit one this is.
   */
  phases: string[]
  /**
   * Block ids with at least one subtile whose `charNum` is in the animated
   * set - derived from `getAnimatedChars(loadAnimationData(...))`, never a
   * hardcoded char range: a hack can animate chars outside vanilla's
   * region and this still reports it correctly.
   */
  animatedBlockIds: number[]
}

/**
 * A decoded 512-tile sheet, ready to paint as one image (mirrors
 * GfxSheetDto): 32 rows of 16 blocks, 16x16px each -> 256x512px.
 *
 * `layer`, `tileset` and `paletteVariant` all report what actually PRODUCED
 * this sheet, never the raw request - same rule GfxSheetDto's `bpp` and
 * `paletteRow` follow, so the view can never show a picker value that does
 * not match what is actually painted.
 */
/**
 * One resolved CGRAM row the sheet's subtiles actually cite, as CSS colors.
 *
 * These are the colors the sheet was COMPOSITED with - the output of
 * buildLevelCgram for this tileset and these palette variants - not the ROM
 * tables they came from. Showing them lets the user see what a variant
 * selection actually did without switching to the palettes panel.
 *
 * Only cited rows are carried. All 16 rows would be 256 swatches, most of
 * which no subtile in the sheet can reach.
 */
export interface Map16CgramRowDto {
  /** CGRAM row index, 0-15. */
  row: number
  /** 16 entries, '#rrggbb'. Index 0 is the transparent backdrop. */
  colors: string[]
}

export interface Map16SheetDto {
  /** The colors this sheet was composited with - see Map16CgramRowDto. */
  cgramRows: Map16CgramRowDto[]
  layer: Map16Layer
  /** The VRAM/GFX-assignment tileset, meaningful for BOTH layers - see `Map16Layer`. */
  tileset: number
  paletteVariant: Map16PaletteVariantDto
  /**
   * The distinct CGRAM rows (0-7) any subtile's `palette` field in THIS
   * sheet actually cites - scanned from the loaded table, never assumed.
   * Vanilla measurement (all 6 corpus carts, identical): the BG table cites
   * only rows {0,1,4,7} (1906 of 2048 subtiles on rows 0-1, zero on 2-3);
   * the FG common table cites both {0,1} (232 subtiles) and {2,3} (1007
   * subtiles). That difference is DATA, not something this shape assumes -
   * a hack could edit either table to cite different rows, and this field
   * would reflect it. Lets the widget disable a palette control (BG feeds
   * rows 0-1, FG feeds rows 2-3 - a fixed engine mapping from
   * buildLevelCgram, not a per-cart fact) when the loaded sheet cites none
   * of the rows that control could possibly change, without re-scanning
   * 512 blocks itself.
   */
  citedPaletteRows: number[]
  tilesPerRow: number
  width: number
  height: number
  /** RGBA8888 pixels, row-major, base64-encoded. */
  rgbaBase64: string
  blocks: Map16BlockDto[]
  /** See `Map16CharAnimationDto`'s own doc comment - present only when this
   * tileset's VRAM has real, cart-derived animated chars. */
  charAnimation?: Map16CharAnimationDto
  /**
   * Always true today: tiles $133-$13A cycle through 4 palette variants per
   * screen at runtime (MAP16_APP_TABLE in src/rom/Map16.ts) and this view
   * renders only the bitmap-default pointers, not any variant. Carried on
   * the DTO (rather than left implicit) so the view can say so rather than
   * silently pretending those 8 tiles are the whole story. FG-layer only:
   * the BG/Layer 2 table has no pipe tiles or app-table override at all.
   */
  pipeVariantsIgnored: true
}

export type LoadMap16Result =
  { status: 'ok'; sheet: Map16SheetDto } | { status: 'rom-not-located'; baseRom: RomIdentityDto }

/** Shares LoadMap16Result's `ok` shape, same reasoning as palette-protocol's SetColorResult. */
export type SetMap16Result =
  LoadMap16Result | { status: 'stale'; reason: string } | { status: 'io-error'; reason: string }

/** Pushed when a project's working copy changes - a palette edit, a Map16
 * edit made through another view, or this view's own edit. */
export interface Map16ServiceClient {
  onWorkingCopyChanged(manifestPath: string): void
}

export interface Map16Service {
  /** Registers the frontend's push target. Theia calls this once per connection. */
  setClient(client: Map16ServiceClient | undefined): void

  /**
   * Decode one Map16 sheet from the working copy.
   *
   * `tileset` selects the pointer table AND the VRAM/GFX assignment when
   * `layer === 'fg'`; when `layer === 'bg'` it selects ONLY the VRAM
   * assignment (the block table itself is global) - see `Map16Layer`.
   * `paletteVariant` picks which BackgroundPalettes/ForegroundPalettes
   * entries color the sheet; a level's actual variants are level-header
   * fields this view has no level context to read, so the caller supplies
   * them explicitly (default 0/0, vanilla's own LoadPalette default).
   */
  loadMap16(
    manifestPath: string,
    tileset: number,
    layer: Map16Layer,
    paletteVariant: Map16PaletteVariantDto,
  ): Promise<LoadMap16Result>

  /**
   * Write one subtile field: the backend reads the word currently at that
   * subtile's address, replaces `field`, re-encodes, and records it as one
   * `edit` layer through the SAME op mechanism palette colors use
   * (WorkingRomRegistry.setWord) - only the mask differs (Map16 words use
   * all 16 bits; see PaletteOp.ts's FULL_WORD_MASK). Packing lives in
   * src/rom/Map16.ts (encodeSubTileWord), not here or in the browser, so it
   * is exercised by that module's own unit tests rather than duplicated.
   *
   * `layer` picks which table's pointer resolves the address to write, same
   * meaning as `loadMap16`'s. Returns the reloaded sheet (that same layer,
   * tileset and palette variant) on success, `stale` if the word moved
   * under this edit (another edit landed first), or `io-error` if the layer
   * could not be persisted.
   */
  setSubtileField(
    manifestPath: string,
    tileset: number,
    layer: Map16Layer,
    paletteVariant: Map16PaletteVariantDto,
    tileId: number,
    which: Map16SubtileKey,
    field: Map16Field,
    value: number | boolean,
  ): Promise<SetMap16Result>
}
