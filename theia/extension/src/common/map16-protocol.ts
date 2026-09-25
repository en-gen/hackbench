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
 *
 * Vocabulary follows docs/glossary.md:137, not this view's own invention: a
 * 16x16 Map16 entry is a TILE, its four 8x8 quadrants hold CHARACTERS, and
 * the 3-bit field naming a CGRAM row of 16 colors is a COLOR ROW. "Palette"
 * is reserved for the BackgroundPalettes/ForegroundPalettes variants the
 * toolbar selects.
 */
import { RomIdentityDto } from './project-protocol'

export const MAP16_SERVICE_PATH = '/services/hackbench-map16'

export const Map16Service = Symbol('Map16Service')

/** Object tilesets 0-14 (TILESET_COUNT in src/rom/Map16.ts). */
export const MAP16_TILESET_COUNT = 15
export const MAP16_TILES_PER_ROW = 16

/**
 * There are two SEPARATE Map16 tables (MapEditorProvider.ts:388-390 loads
 * both for a level): `fg` is the per-tileset object/terrain table
 * (`readMap16Table`); `bg` is the GLOBAL Layer 2 preset table
 * (`readL2Map16Table`, one table, no tileset). They share nothing - tile `$100` is a different entry
 * in each. `tileset` still applies to `bg` sheets for VRAM/GFX-assignment
 * purposes, and NOT merely nominally: `readGfxAssignment` yields 13 distinct
 * assignments across the 15 vanilla tilesets in the `fg3`/`an1` slots alone
 * (chars $100-$1FF), and 1310 of the BG table's 2048 characters (64.0%) sit
 * in those two slots - measured on the real cartridge, not assumed. So while
 * the TILE TABLE itself does not vary with tileset for `bg`, the rendered
 * PIXELS visibly do, for most of the sheet; the tileset control stays
 * enabled for both layers, and only its MEANING changes (table selector on
 * `fg`, graphics-only on `bg`).
 *
 * One WIDGET per layer, keyed by this value - the tab IS the table, so
 * there is no in-toolbar table selector to get out of step with the tab.
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
 * character's own 3-bit `colorRow` field (which CGRAM row, 0-7, it reads).
 * This is which COLORS load into those rows in the first place: `bg` picks
 * BackgroundPalettes[bg] into CGRAM rows 0-1, `fg` picks
 * ForegroundPalettes[fg] into rows 2-3 (buildLevelCgram in PaletteLoader.ts).
 * Rows 4-7 (StandardColors) have no variant axis at all, so a character
 * using one of those rows is unaffected by either choice. No `sprite` field
 * here: buildLevelCgram's sprite parameter only reaches CGRAM rows 14-15,
 * which a 3-bit color-row field (0-7) can never select.
 */
export interface Map16PaletteVariantDto {
  bg: number
  fg: number
}

/** Which CGRAM rows a `Map16PaletteVariantDto` field feeds - see
 * `Map16SheetDto.citedColorRows`'s own doc comment for why this is a
 * fixed mapping the WIDGET applies, not a per-cart fact. */
export const BG_VARIANT_COLOR_ROWS: readonly number[] = [0, 1]
export const FG_VARIANT_COLOR_ROWS: readonly number[] = [2, 3]

/** The four quadrants of a 16x16 tile, each holding one 8x8 character. */
export type Map16QuadrantKey = 'tl' | 'tr' | 'bl' | 'br'

/** Which quadrant field an edit targets. */
export type Map16Field = 'charNum' | 'colorRow' | 'priority' | 'flipX' | 'flipY'

/**
 * The BG character slots a Map16 quadrant can name, in character order.
 *
 * Chars $200-$3FF are tilemap space rather than characters, and sprite
 * slots sit at $400+, which no Map16 quadrant draws from. So these four ARE
 * the character space this editor can offer, and an accordion listing all
 * 50 GFX files would let the user name a character this tileset has not
 * loaded: the choice would look right and render as whatever actually sits
 * at that VRAM address.
 */
export const MAP16_CHAR_SLOTS = ['fg1', 'fg2', 'fg3', 'an1'] as const
export type Map16CharSlot = (typeof MAP16_CHAR_SLOTS)[number]

/**
 * One past the last character a Map16 quadrant can usefully name: the four
 * BG slots cover `$000-$1FF` (VRAM_CHAR_BASE in GfxLoader.ts, 128 chars
 * each), and `$200-$3FF` is tilemap space rather than character space.
 *
 * Declared here rather than imported, like everything else in this file -
 * see the module comment. Map16WriteGate.test.ts cross-checks it against
 * `VRAM_CHAR_BASE.an1 + GFX_TILES` so the two cannot drift apart silently.
 *
 * **This bound is NOT "the characters this tileset has loaded", and the
 * difference was measured rather than assumed.** Across all 6 corpus ROMs,
 * 357 of 360 slot/tileset combinations hold exactly 128 characters, so for
 * those the two are the same set. The three that differ are Invictus
 * tilesets 3, 9 and 14, whose `an1` holds 123: on those, `$1FB-$1FF` is
 * inside this bound and genuinely not loaded.
 *
 * What makes that safe is the UI, not this constant. A palette section
 * draws only the characters its sheet actually holds (`slotCharCount`), so
 * those five have no cell to click and cannot be produced by any gesture.
 * A hand-written RPC call still can name one, and `gateQuadrantWrite` will
 * accept it. Closing that would mean decompressing four GFX files on every
 * write, or a cache, for a hole unreachable through the product.
 *
 * So the guarantee rests on the clamp. If `slotCharCount` ever stops
 * clamping to what a sheet holds, the accordion starts offering characters
 * that are not loaded and this reasoning collapses with it - which is why
 * that clamp carries planted-defect proofs of its own in docs/testing.md.
 */
export const MAP16_CHAR_SPACE_END = 0x200

/**
 * One of the four GFX sheets the selected tileset has loaded into BG VRAM,
 * as one section of the character-palette accordion.
 *
 * Pixels travel as INDICES, not as composited RGBA: a section colors its
 * characters with the color row the SELECTED QUADRANT holds, which then
 * changes with no round trip, and makes it plain that clicking a character
 * carries only a character number (see `setQuadrantField`).
 *
 * `fileIndex` comes from `readGfxAssignment` for this tileset, so switching
 * tileset changes both the labels and the pixels, exactly as it does on
 * hardware.
 */
export interface Map16CharSheetDto {
  slot: Map16CharSlot
  /** GFX file index OBJECTGFXLIST names for this slot and tileset. */
  fileIndex: number
  /** The file's own label, matching the GFX explorer's rows: `GFX25`. */
  fileLabel: string
  /** First character number this sheet answers to (VRAM_CHAR_BASE). */
  charBase: number
  charCount: number
  /** `charCount * 64` pixel indices, row-major per character, base64. */
  indicesBase64: string
  /**
   * The highest pixel index THIS sheet's characters actually use, scanned
   * from the decoded VRAM rather than inferred from a depth.
   *
   * Per sheet, not per view. A 3bpp sheet can only produce indices 0-7, so
   * a maximum taken across all four sheets would let one 4bpp sheet add
   * eight swatches the other three can never reach. All four vanilla slots
   * measure 7, so nothing in the corpus shows the difference, which is
   * exactly why it has to be right by construction rather than by
   * measurement.
   */
  maxColorIndex: number
  /**
   * Whether this tileset's animation data rewrites characters in this slot.
   * Derived from `loadAnimationData`/`getAnimatedChars`, never from the slot
   * NAME.
   *
   * Measured across all 15 tilesets on all 6 corpus ROMs: animated
   * characters land in `fg1` and `fg2` ($040-$07C, plus $080, $090, $0DA
   * and $0EA) and never in `an1`. An earlier design asserted the opposite
   * and would have frozen the wrong slot, which is why this is read rather
   * than named.
   *
   * This LABELS a section; it does not gate anything. EVERY section is
   * frozen at the cartridge's animation frame 0, animated or not, because a
   * click target that changes four times a second is not a click target,
   * and because one VRAM source for every surface is what keeps a palette
   * cell and the quadrant citing it the same pixels.
   */
  animated: boolean
  /**
   * Why this slot has no characters to offer, when it has none.
   *
   * Absent on a slot that resolved. A slot whose GFX assignment or decode
   * failed is still LISTED, with its reason, rather than dropped: four
   * sections with one saying why it is empty is a fact the user can act on,
   * and three sections where there should be four is a silent hole.
   */
  unavailable?: string
}

/** One decoded quadrant, plus the ROM address of its own 16-bit word - the
 * unit an edit actually writes. */
export interface Map16QuadrantDto {
  charNum: number
  /** 3-bit CGRAM row, 0-7. Rows 8-15 are unreachable from this field. */
  colorRow: number
  priority: boolean
  flipX: boolean
  flipY: boolean
  /** 24-bit SNES address of this quadrant's own word within the 8-byte entry. */
  romAddr: number
}

/** One 16x16 Map16 tile: four quadrants plus the entry's own base address. */
export interface Map16TileDto {
  id: number
  /** Address of the tile's 8-byte entry (== `tl.romAddr`). */
  romAddr: number
  /**
   * Whether this tile's bytes are SHARED rather than private to the
   * current tileset, so an edit reaches more than the tileset on screen.
   *
   * `readMap16Table` interleaves per-tileset entries with the
   * shared `Map16Common` run CODE_0581FB's operand names, driven by its
   * bitmap, so "which tileset owns this tile" varies BY TILE and
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
  tl: Map16QuadrantDto
  tr: Map16QuadrantDto
  bl: Map16QuadrantDto
  br: Map16QuadrantDto
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
 * region (or wherever a hack routes them; see `animatedTileIds`). There is
 * a SEPARATE, independently-clocked PALETTE animation
 * (`PaletteAnimationDetect.ts`'s `detectPaletteAnimation`, CGRAM $64, 8
 * phases, 67ms on vanilla and GPW2 alike - a different period from this
 * model's `frameCount`/`intervalMs`, never sharing a counter with it) that
 * this model does NOT carry. `buildLevelCgram` here produces a static
 * CGRAM, so a Yoshi/dragon coin's CHARACTERS animate while its COLOR does
 * not - a known, stated gap, not a silent one.
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
   * Tile ids whose COMPOSITED pixels actually differ between phases -
   * derived from the rendered atlases, never a hardcoded char range, so a
   * hack that animates chars outside vanilla's region still reports
   * correctly.
   */
  animatedTileIds: number[]
}

/**
 * One resolved CGRAM row the sheet's characters actually cite, as CSS colors.
 *
 * These are the colors the sheet was COMPOSITED with - the output of
 * buildLevelCgram for this tileset and these palette variants - not the ROM
 * tables they came from. Showing them lets the user see what a variant
 * selection actually did without switching to the palettes panel.
 *
 * Only cited rows are carried. All 16 rows would be 256 swatches, most of
 * which no character in the sheet can reach.
 */
export interface Map16CgramRowDto {
  /** CGRAM row index, 0-15. */
  row: number
  /** 16 entries, '#rrggbb'. Index 0 is the transparent backdrop. */
  colors: string[]
}

/**
 * A decoded Map16 sheet, ready to paint as one image (mirrors GfxSheetDto):
 * `tiles.length / tilesPerRow` rows of 16x16px tiles.
 *
 * `layer`, `tileset` and `paletteVariant` all report what actually PRODUCED
 * this sheet, never the raw request - same rule GfxSheetDto's `bpp` follows,
 * so the view can never show a picker value that does not match what is
 * actually painted.
 */
export interface Map16SheetDto {
  /** The colors this sheet was composited with - see Map16CgramRowDto. */
  cgramRows: Map16CgramRowDto[]
  layer: Map16Layer
  /** The VRAM/GFX-assignment tileset, meaningful for BOTH layers - see `Map16Layer`. */
  tileset: number
  paletteVariant: Map16PaletteVariantDto
  /**
   * The distinct CGRAM rows (0-7) any character's `colorRow` field in THIS
   * sheet actually cites - scanned from the loaded table, never assumed.
   * Vanilla measurement (all 6 corpus carts, identical): the BG table cites
   * only rows {0,1,4,7} (1906 of 2048 characters on rows 0-1, zero on 2-3);
   * the FG common table cites both {0,1} (232 characters) and {2,3} (1007
   * characters). That difference is DATA, not something this shape assumes -
   * a hack could edit either table to cite different rows, and this field
   * would reflect it. It is also what the color-row picker offers: a row no
   * character in the sheet cites has no swatch strip to recognise it by.
   */
  citedColorRows: number[]
  /** The four sheets this tileset has loaded into BG character space. */
  charSheets: Map16CharSheetDto[]
  tilesPerRow: number
  width: number
  height: number
  /** RGBA8888 pixels, row-major, base64-encoded. */
  rgbaBase64: string
  tiles: Map16TileDto[]
  /** See `Map16CharAnimationDto`'s own doc comment - present only when this
   * tileset's VRAM has real, cart-derived animated chars. */
  charAnimation?: Map16CharAnimationDto
  /** Why the stock animated characters are drawn blank on this ROM; absent when they are not. */
  animationNote?: string
  /**
   * Always true today: tiles $133-$13A cycle through 4 palette variants per
   * screen at runtime (readMap16AppTable in src/rom/Map16.ts) and this view
   * renders only the bitmap-default pointers, not any variant. Carried on
   * the DTO (rather than left implicit) so the view can say so rather than
   * silently pretending those 8 tiles are the whole story. FG-layer only:
   * the BG/Layer 2 table has no pipe tiles or app-table override at all.
   */
  pipeVariantsIgnored: true
}

/**
 * `unavailable` is the refusal this view owes a cartridge whose Map16 it
 * cannot present IN FULL - see `readMap16TileCount` in src/rom/Map16.ts and
 * en-gen/hackbench#102. Rendering the first two pages of an expanded table
 * would be confidently wrong, which is worse than saying so.
 */
export type LoadMap16Result =
  | { status: 'ok'; sheet: Map16SheetDto }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }
  | { status: 'unavailable'; reason: string }

/**
 * Shares LoadMap16Result's `ok` shape, same reasoning as palette-protocol's
 * SetColorResult.
 *
 * `refused` is a value the backend will not write: a character above the
 * 10-bit field, a color row above the 3-bit one. The encoder MASKS every
 * field (Map16.ts's encodeSubTileWord), so accepting such a value would
 * write a silently truncated one - character $407 committed as $007 looks
 * like a successful edit and is a different character. The accordion cannot
 * express one, so this guards the RPC surface, which with the drag path
 * gone is the only place left where one can arrive.
 */
export type SetMap16Result =
  | LoadMap16Result
  | { status: 'stale'; reason: string }
  | { status: 'io-error'; reason: string }
  | { status: 'refused'; reason: string }

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
   * assignment (the tile table itself is global) - see `Map16Layer`.
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
   * Write one quadrant field: the backend reads the word currently at that
   * quadrant's address, replaces `field`, re-encodes, and records it as one
   * `edit` layer through the SAME op mechanism palette colors use
   * (WorkingRomRegistry.setWord) - only the mask differs (Map16 words use
   * all 16 bits; see PaletteOp.ts's FULL_WORD_MASK). Packing lives in
   * src/rom/Map16.ts (encodeSubTileWord), not here or in the browser, so it
   * is exercised by that module's own unit tests rather than duplicated.
   *
   * Exactly ONE field moves per call, which is what makes picking a
   * character safe: clicking one sets `charNum` and leaves the color row,
   * the flips and the priority bit exactly as the cartridge had them.
   *
   * Values are REFUSED rather than truncated - see `SetMap16Result`.
   *
   * `layer` picks which table's pointer resolves the address to write, same
   * meaning as `loadMap16`'s. Returns the reloaded sheet (that same layer,
   * tileset and palette variant) on success, `stale` if the word moved
   * under this edit (another edit landed first), or `io-error` if the layer
   * could not be persisted.
   */
  setQuadrantField(
    manifestPath: string,
    tileset: number,
    layer: Map16Layer,
    paletteVariant: Map16PaletteVariantDto,
    tileId: number,
    which: Map16QuadrantKey,
    field: Map16Field,
    value: number | boolean,
  ): Promise<SetMap16Result>
}
