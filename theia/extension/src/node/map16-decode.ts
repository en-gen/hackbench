/**
 * Pure Map16-decoding logic for the Map16 view: no Theia or RPC imports, so
 * it is unit-testable the same way gfx-decode.ts is.
 *
 * Composition (VRAM lookup, per-quadrant color row, flips) is NOT
 * reimplemented here - it reuses src/rom/TileRenderer.ts's buildTileAtlas,
 * the same function TilesetCompareProvider's webview already renders from,
 * so this view's pixels can never drift from that one.
 *
 * Bit-packing (decode/encode of one quadrant's 16-bit word) is NOT
 * reimplemented here either - src/rom/Map16.ts's decodeSubTileWord /
 * encodeSubTileWord is the single place that logic lives, covered by its own
 * unit tests, so a Map16 edit's read-modify-write can never disagree with
 * how a fresh load decodes the same word.
 */
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { FULL_WORD_MASK } from '../../../../src/rom/PaletteOp'
import type { SetWordRequest } from '../../../../src/project/WorkingRomRegistry'
import {
  decodeSubTileWord,
  encodeSubTileWord,
  loadMap16Tiles,
  readL2Map16Table,
  readMap16Common,
  readMap16Table,
  type Map16Read,
  MAP16_TILE_BYTES,
  MAP16_TOTAL_TILES,
  map16TileCapacity,
  Map16Tile,
  SubTile,
} from '../../../../src/rom/Map16'
import {
  gfxSource,
  levelGfxAssignmentNote,
  loadVram,
  readGfxAssignment,
  VramState,
  VRAM_CHAR_BASE,
  type GfxSheet,
} from '../../../../src/rom/GfxLoader'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import {
  buildLevelCgram,
  loadRomPalettes,
  type ActiveLevelPalette,
} from '../../../../src/rom/PaletteLoader'
import { readLevelCol1 } from '../../../../src/rom/PaletteStockTables'
import {
  bigObjTiles,
  objAttrToCgramRow,
  pSwitchTileAttrs,
  readPSwitchButtonArt,
  spriteCharNum,
  type PSwitchButtonArt,
} from '../../../../src/rom/PSwitchButtonArt'
import { buildTileAtlas, renderMap16Tile, renderSubTile } from '../../../../src/rom/TileRenderer'
import { frameZeroChars, playableAnimation } from '../../../../src/rom/FrameZero'
import {
  getAnimatedChars,
  getSwitchedChars,
  type AnimationData,
  type SwitchKind,
} from '../../../../src/rom/AnimationLoader'
import { vramFromChars } from '../../../../src/rom/model/chars/CharFactory'
import { tileAlternates } from '../../../../src/rom/SwitchAlternates'
import type { Char } from '../../../../src/rom/model/chars/Char'
import {
  Map16TileDto,
  Map16CgramRowDto,
  Map16CharAnimationDto,
  Map16Field,
  Map16Layer,
  Map16PaletteVariantDto,
  Map16QuadrantDto,
  Map16QuadrantKey,
  Map16SheetDto,
  Map16CharSheetDto,
  Map16CharSlot,
  Map16SwitchButtonImages,
  Map16TileAlternateDto,
  MAP16_CHAR_SLOTS,
  MAP16_CHAR_SPACE_END,
  MAP16_TILES_PER_ROW,
  MAP16_TILESET_COUNT,
} from '../common/map16-protocol'

/**
 * How many characters each BG slot actually maps, from the slot bases
 * themselves: the distance to the next slot, and for the last one the
 * distance to the end of character space.
 *
 * `loadVram` does not cap a slot at its capacity, and it is the FILE that
 * decides how many characters come back: a 4096-byte 3bpp file decodes to
 * 170, and on a hack that ships one, `fg1` would offer characters that are
 * really `fg2`'s and `an1` would offer addresses past character space
 * entirely. All 6 corpus ROMs hold exactly 128 per slot, so nothing here
 * can see it, which is precisely the romhack case this project's rules
 * exist for. The extra characters are not addressable by a Map16 quadrant
 * at all, so they are dropped rather than offered.
 */
const SLOT_CAPACITY: Record<Map16CharSlot, number> = (() => {
  const bases = MAP16_CHAR_SLOTS.map(slot => VRAM_CHAR_BASE[slot])
  const capacity = {} as Record<Map16CharSlot, number>
  MAP16_CHAR_SLOTS.forEach((slot, i) => {
    capacity[slot] = (bases[i + 1] ?? MAP16_CHAR_SPACE_END) - bases[i]!
  })
  return capacity
})()

/** How many of `decoded` characters this slot can actually offer. Exported
 * so the clamp is provable without a cartridge that overflows one - no
 * corpus ROM does. */
export function slotCharCount(slot: Map16CharSlot, decoded: number): number {
  return Math.min(decoded, SLOT_CAPACITY[slot])
}

/** One Map16 tile is 16x16 px, the unit buildTileAtlas lays out. */
const TILE_PX = 16
/** Pixels per 8x8 character, the unit one accordion cell carries. */
const CHAR_PIXELS = 64

/** Byte offset of each quadrant's own word within an 8-byte Map16 entry.
 * Column-major per Map16.ts: word0=TL, word1=BL, word2=TR, word3=BR. */
const QUADRANT_WORD_OFFSET: Record<Map16QuadrantKey, number> = { tl: 0, bl: 2, tr: 4, br: 6 }

/** A decoded sheet, or the reason this ROM's Map16 cannot be shown in
 * full - see `decodeMap16Sheet`. */
export type DecodeMap16Result =
  { status: 'ok'; sheet: Map16SheetDto } | { status: 'unavailable'; reason: string }

function isValidTileset(tileset: number): boolean {
  return Number.isInteger(tileset) && tileset >= 0 && tileset < MAP16_TILESET_COUNT
}

function requireValidTileset(tileset: number): void {
  if (!isValidTileset(tileset)) {
    throw new Error(`Map16 tileset out of range 0..${MAP16_TILESET_COUNT - 1}: ${tileset}`)
  }
}

/**
 * The pointer table backing a layer: `fg` is the tileset's own object table;
 * `bg` is the global L2 (background) table, which `tileset` does not choose.
 * See Map16Layer's own doc comment in map16-protocol.ts.
 */
function layerTable(rom: RomFile, tileset: number, layer: Map16Layer): Map16Read<number[]> {
  return layer === 'bg' ? readL2Map16Table(rom) : readMap16Table(rom, tileset)
}

/** A layer's usable extent, or the reason this decoder may present none of it. */
export type Map16Extent = { count: number } | { reason: string }

/**
 * How many tiles of a layer this decoder may present, or the reason it may
 * present none. Each layer answers from its own fill loop.
 */
export function map16LayerExtent(rom: RomFile, layer: Map16Layer): Map16Extent {
  if (layer === 'bg') {
    const table = readL2Map16Table(rom)
    if (!table.ok)
      return { reason: `This ROM's L2 (background) Map16 cannot be located: ${table.reason}.` }
    const count = table.value.length
    if (count > MAP16_TOTAL_TILES)
      return {
        reason: `This ROM's L2 (background) Map16 holds ${count} tiles, more than the ${MAP16_TOTAL_TILES} this view can read (en-gen/hackbench#41).`,
      }
    return { count }
  }
  return map16TileCapacity(rom)
}

function toQuadrantDto(sub: SubTile, romAddr: number): Map16QuadrantDto {
  return {
    charNum: sub.charNum,
    colorRow: sub.palette,
    priority: sub.priority,
    flipX: sub.flipX,
    flipY: sub.flipY,
    romAddr,
  }
}

/**
 * Every distinct CGRAM row (0-7) any quadrant's color-row field in `tiles`
 * actually cites, sorted. Scanned from the loaded table itself - never
 * assumed from which layer this is - so a hack whose BG or FG table cites
 * rows a vanilla measurement never saw is still reported correctly. See
 * Map16SheetDto.citedColorRows's own doc comment for the vanilla figures
 * that motivated this.
 */
function scanCitedColorRows(tiles: Map16Tile[]): number[] {
  const rows = new Set<number>()
  for (const tile of tiles) {
    rows.add(tile.tl.palette)
    rows.add(tile.tr.palette)
    rows.add(tile.bl.palette)
    rows.add(tile.br.palette)
  }
  return Array.from(rows).sort((a, b) => a - b)
}

function toBase64(bytes: Uint8ClampedArray | Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** `GFX25` for file index `0x25`, matching the GFX explorer's own row text. */
function gfxFileLabel(fileIndex: number): string {
  return `GFX${fileIndex.toString(16).toUpperCase().padStart(2, '0')}`
}

/**
 * The four BG character sheets this tileset has loaded, as the accordion
 * offers them.
 *
 * They come from the same decoded VRAM the atlas was composited from, so a
 * character in a palette section and the same character in a tile can never
 * be different pixels. `animated` is resolved against this ROM's own
 * animation data rather than the slot name, and `maxColorIndex` is scanned
 * PER SHEET - see Map16CharSheetDto's own doc comments for both.
 * `animData` is frameZeroChars' own, so a ROM with no stock frames to
 * composite marks none animated.
 */
function buildCharSheets(
  rom: RomFile,
  tileset: number,
  vram: VramState,
  animData: AnimationData | undefined,
): Map16CharSheetDto[] {
  const assignment = readGfxAssignment(rom, tileset, 0)
  const animatedChars = animData ? getAnimatedChars(animData) : new Set<number>()

  const sheets: Map16CharSheetDto[] = []
  for (const slot of MAP16_CHAR_SLOTS) {
    const chars: GfxSheet | undefined = vram[slot]
    const fileIndex = assignment[slot]
    const charBase = VRAM_CHAR_BASE[slot]
    // Listed with its reason, never dropped - see Map16CharSheetDto.unavailable.
    if (!chars || fileIndex === undefined) {
      sheets.push({
        slot,
        fileIndex: fileIndex ?? -1,
        fileLabel: fileIndex === undefined ? '-' : gfxFileLabel(fileIndex),
        charBase,
        charCount: 0,
        indicesBase64: '',
        maxColorIndex: 0,
        animated: false,
        unavailable:
          fileIndex === undefined
            ? `This tileset's GFX assignment names no file for ${slot}.`
            : `${gfxFileLabel(fileIndex)} did not decode, so ${slot} has no characters to offer.`,
      })
      continue
    }
    // Clamped to what the SLOT maps, not to what the file decoded to - see
    // SLOT_CAPACITY.
    const charCount = slotCharCount(slot, chars.length)
    const indices = new Uint8Array(charCount * CHAR_PIXELS)
    let maxColorIndex = 0
    for (let i = 0; i < charCount; i++) {
      const pixels = chars[i]!
      indices.set(pixels.subarray(0, CHAR_PIXELS), i * CHAR_PIXELS)
      for (const p of pixels) if (p > maxColorIndex) maxColorIndex = p
    }
    let animated = false
    for (let c = charBase; c < charBase + charCount; c++) {
      if (animatedChars.has(c)) {
        animated = true
        break
      }
    }
    sheets.push({
      slot,
      fileIndex,
      fileLabel: gfxFileLabel(fileIndex),
      charBase,
      charCount,
      indicesBase64: toBase64(indices),
      maxColorIndex,
      animated,
    })
  }
  return sheets
}

/**
 * Whether a tile's COMPOSITED pixels actually differ between phases.
 *
 * The obvious test - does any quadrant cite a char the animation DMA
 * touches - over-reports badly, because the DMA rewrites many chars with
 * byte-identical data. Measured on vanilla tileset 0: of 88 tiles that
 * cite an animated char, only 36 change; 52 do not. Reporting those 52 as
 * animated makes the frame strip render four identical thumbnails, which
 * is exactly what its own doc comment forbids - a picture that says "this
 * animates" when it does not.
 *
 * Comparing the rendered atlases answers the real question instead, and
 * they are already built for playback, so this costs a scan and no extra
 * decode.
 */
function tileDiffersAcrossPhases(
  phases: readonly Uint8ClampedArray[],
  atlasWidth: number,
  tileId: number,
): boolean {
  if (phases.length < 2) return false
  const first = phases[0]!
  const x0 = (tileId % MAP16_TILES_PER_ROW) * TILE_PX
  const y0 = Math.floor(tileId / MAP16_TILES_PER_ROW) * TILE_PX
  for (let p = 1; p < phases.length; p++) {
    const other = phases[p]!
    for (let y = 0; y < TILE_PX; y++) {
      const row = ((y0 + y) * atlasWidth + x0) * 4
      for (let i = 0; i < TILE_PX * 4; i++) {
        if (first[row + i] !== other[row + i]) return true
      }
    }
  }
  return false
}

/**
 * The character-animation model, built from the graphics data (VRAM +
 * `AnimationLoader.loadAnimationData`) for this tileset - see
 * `Map16CharAnimationDto`'s own doc comment for why this is a distinct
 * model rather than a DTO field, and for the palette-animation gap it
 * deliberately does not cover.
 *
 * Renders one full atlas per native frame by SNAPSHOTTING `chars` via
 * `vramFromChars` before each `tickAnimation()` - phase 0's snapshot is
 * always identical to `chars`' just-built state (nothing has ticked yet),
 * which is what makes "frame 0 is the still sheet's default" true by
 * construction rather than by coincidence, and is also the frame the
 * palette sections are frozen at.
 *
 * Returns `undefined` (not an empty/zero-phase object) when
 * `loadAnimationData` finds nothing, or finds data but no quadrant in
 * `tiles` actually cites an animated char - either way there is nothing to
 * play, and the widget must not show a working-looking control for it.
 */
function buildCharAnimation(
  animData: AnimationData,
  chars: Map<number, Char>,
  tiles: Map16Tile[],
  vram: VramState,
  cgram: ActiveLevelPalette,
): { dto: Map16CharAnimationDto; atlasWidth: number; atlasHeight: number } | undefined {
  const phases: string[] = []
  const rendered: Uint8ClampedArray[] = []
  let atlasWidth = 0
  let atlasHeight = 0
  for (let phase = 0; phase < animData.frameCount; phase++) {
    const phaseVram = vramFromChars(vram, chars)
    const dims = buildTileAtlas(tiles, phaseVram, cgram, MAP16_TILES_PER_ROW)
    atlasWidth = dims.atlasWidth
    atlasHeight = dims.atlasHeight
    rendered.push(dims.atlas)
    phases.push(toBase64(dims.atlas))
    for (const char of chars.values()) char.tickAnimation()
  }

  const animatedTileIds = tiles
    .filter(t => tileDiffersAcrossPhases(rendered, atlasWidth, t.id))
    .map(t => t.id)
  if (animatedTileIds.length === 0) return undefined

  return {
    dto: {
      frameCount: animData.frameCount,
      intervalMs: animData.intervalMs,
      phases,
      animatedTileIds,
    },
    atlasWidth,
    atlasHeight,
  }
}

/** The cited rows of a built CGRAM, as CSS colors for the swatch strips. */
function cgramRowsFor(cgram: ActiveLevelPalette, cited: number[]): Map16CgramRowDto[] {
  return cited.map(row => ({
    row,
    colors: (cgram.rows[row] ?? []).map(
      c => '#' + [c[0], c[1], c[2]].map(v => v.toString(16).padStart(2, '0')).join(''),
    ),
  }))
}

/** Whether any of `tile`'s 4 quadrants cites a char in `chars`. */
export function tileCitesAny(tile: Map16Tile, chars: ReadonlySet<number> | undefined): boolean {
  if (!chars) return false
  return [tile.tl, tile.tr, tile.bl, tile.br].some(q => chars.has(q.charNum))
}

/** `tileAlternates` (src/rom/SwitchAlternates.ts, shared with the map tab), for the wire. */
export function buildTileAlternates(
  animData: AnimationData,
  entries: readonly Map16Tile[],
  vram: VramState,
  palette: { colors: RgbaColor[] },
): Map<number, Map16TileAlternateDto[]> {
  const out = new Map<number, Map16TileAlternateDto[]>()
  for (const [id, alts] of tileAlternates(animData, entries, vram, palette)) {
    out.set(
      id,
      alts.map(a => ({ kinds: a.kinds, altRgbaBase64: toBase64(a.rgba), hidden: a.hidden })),
    )
  }
  return out
}

/**
 * Why each unresolved tile's switches are unavailable: a tile citing a char the
 * behavior table marks switched says so rather than vanishing, while a resolved
 * tile (alternates, even none) or one whose chars only animate never does.
 */
export function buildSwitchNotes(
  animData: AnimationData,
  entries: readonly Map16Tile[],
  alternates: ReadonlyMap<number, Map16TileAlternateDto[]>,
): Map<number, string> {
  const notes = new Map<number, string>()
  const reason = animData.switchUnavailable
  if (!reason) return notes
  const switched = getSwitchedChars(animData)
  for (const tile of entries)
    if (!alternates.has(tile.id) && tileCitesAny(tile, switched)) notes.set(tile.id, reason)
  return notes
}

const BUTTON_FRAME_PX = 16

/**
 * The P-switch button's two pictures for one PSwitchPal byte: the unpressed
 * 16x16 OBJ, and the pressed pair at the ROM's own displacement. Every
 * attribute bit is read (docs/rom/pswitch-button-art.md).
 */
export function renderPSwitchButtonImages(
  vram: VramState,
  palette: { colors: RgbaColor[] },
  art: PSwitchButtonArt,
  pswitchPal: number,
): Map16SwitchButtonImages {
  const attrs = pSwitchTileAttrs(art, pswitchPal)
  const sub = (tile: number, attr: number, flipX = false): SubTile => ({
    charNum: spriteCharNum(tile, attr),
    palette: objAttrToCgramRow(attr),
    priority: false,
    flipX,
    flipY: false,
  })
  const [tl, tr, bl, br] = bigObjTiles(art.unpressedTile).map(t => sub(t, attrs.unpressed))
  const off = renderMap16Tile({ id: 0, tl: tl!, tr: tr!, bl: bl!, br: br! }, vram, palette)

  const stride = BUTTON_FRAME_PX * 4
  const rowAt = art.yOffset * stride
  const on = new Uint8ClampedArray(BUTTON_FRAME_PX * stride)
  const tile2 = sub(art.pressedTile, attrs.pressed2, true)
  renderSubTile(tile2, vram, palette, on, rowAt + art.xOffset * 4, stride)
  // Tile 1 last: the lower OAM slot ($100) wins an overlap; index 0 is never written.
  renderSubTile(sub(art.pressedTile, attrs.pressed1), vram, palette, on, rowAt, stride)

  return { offRgba: toBase64(off), onRgba: toBase64(on) }
}

// The ON/OFF button is Map16 tile $112, the vanilla switch block: a hack-fragility point,
// since a hack can move the ON/OFF block to another tile.
export const ONOFF_BUTTON_TILE_ID = 0x112

/**
 * Every switch toggle BUTTON'S OWN art, distinct from a tile's alternates, with
 * the reason for each kind that has none. Blue and silver share one ROM read.
 */
export function buildSwitchButtonArt(
  rom: RomFile,
  entries: readonly Map16Tile[],
  alternates: ReadonlyMap<number, Map16TileAlternateDto[]>,
  vram: VramState,
  palette: { colors: RgbaColor[] },
): {
  art: Partial<Record<SwitchKind, Map16SwitchButtonImages>>
  unavailable: Partial<Record<SwitchKind, string>>
} {
  const art: Partial<Record<SwitchKind, Map16SwitchButtonImages>> = {}
  const unavailable: Partial<Record<SwitchKind, string>> = {}
  const pswitch = readPSwitchButtonArt(rom)
  if (pswitch.ok) {
    art.blue = renderPSwitchButtonImages(vram, palette, pswitch.art, pswitch.art.blueAttr)
    art.silver = renderPSwitchButtonImages(vram, palette, pswitch.art, pswitch.art.silverAttr)
  } else unavailable.blue = unavailable.silver = pswitch.reason

  const tile = entries.find(t => t.id === ONOFF_BUTTON_TILE_ID)
  const onOff = tile && alternates.get(tile.id)?.find(a => a.kinds.join() === 'onOff')
  if (tile && onOff)
    art.onOff = {
      offRgba: toBase64(renderMap16Tile(tile, vram, palette)),
      onRgba: onOff.altRgbaBase64,
    }
  else
    unavailable.onOff = `Map16 tile $112 (the vanilla ON/OFF block) has no readable ON/OFF alternate on this ROM`
  return { art, unavailable }
}

/**
 * Decode one Map16 sheet: one composited RGBA image (buildTileAtlas, 16
 * tiles per row), every tile's quadrant fields and addresses, the four GFX
 * sheets this tileset has loaded for the palettes, and the character-animation
 * model when this tileset has one.
 *
 * `tileset` always resolves VRAM (which GFX files sit in which slot); it
 * ALSO picks the pointer table when `layer === 'fg'` (see `Map16Layer`'s
 * doc comment in map16-protocol.ts - `bg`'s table is global). `paletteVariant`
 * picks the BackgroundPalettes/ForegroundPalettes entries CGRAM rows 0-3
 * load; rows 4-7 (StandardColors) are unaffected by either.
 *
 * Pipe-variant palettes ($133-$13A cycling per screen, FG-only - the BG
 * table has no such tiles) are NOT applied: the sheet renders the
 * bitmap-default pointers `readMap16Table` builds. See
 * Map16SheetDto.pipeVariantsIgnored.
 */
export function decodeMap16Sheet(
  rom: SmwRom,
  tileset: number,
  layer: Map16Layer,
  paletteVariant: Map16PaletteVariantDto,
): DecodeMap16Result {
  requireValidTileset(tileset)

  // Every character comes from GFX; without them the atlas is blank tiles.
  const gfx = gfxSource(rom.rom)
  if (!gfx.ok) return { status: 'unavailable', reason: `GFX cannot be read: ${gfx.reason}` }

  const extent = map16LayerExtent(rom.rom, layer)
  if ('reason' in extent) return { status: 'unavailable', reason: extent.reason }

  const table = layerTable(rom.rom, tileset, layer)
  if (!table.ok)
    return { status: 'unavailable', reason: `This ROM's Map16 cannot be located: ${table.reason}.` }
  const pointers = table.value.slice(0, extent.count)
  const isShared = sharedTileTest(rom.rom, layer)
  const entries = loadMap16Tiles(rom.rom, pointers)
  const rawVram = loadVram(rom.rom, tileset)
  // ONE source for every surface - the atlas, the frames and the character
  // palettes all composite from this. See frameZeroChars.
  const frameZero = frameZeroChars(rom.rom, tileset, rawVram)
  const vram = frameZero?.vram ?? rawVram
  const palettes = loadRomPalettes(rom.rom)
  const col1 = readLevelCol1(rom.rom)
  if ('reason' in col1) {
    return { status: 'unavailable', reason: `Palette column 1 is unavailable: ${col1.reason}` }
  }
  // Sprite param fixed at 0: buildLevelCgram's sprite variant only reaches
  // CGRAM rows 14-15, which a 3-bit color-row field (0-7) can never select
  // - see Map16PaletteVariantDto's own doc comment.
  const cgram = buildLevelCgram(palettes, paletteVariant.bg, paletteVariant.fg, 0, col1)

  // Ticking starts from the raw VRAM the Chars were built against; phase 0
  // of that walk is `vram` above, which is why the still sheet and the
  // palettes agree with `phases[0]` by construction rather than by care.
  const animation =
    frameZero?.animData && playableAnimation(frameZero)
      ? buildCharAnimation(frameZero.animData, frameZero.chars, entries, rawVram, cgram)
      : undefined

  // Frame 0 IS the still sheet - an explicit, documented choice (see
  // buildCharAnimation), not an accident of which atlas happened to be
  // built first. Reuses those exact bytes rather than compositing twice.
  let atlasWidth: number
  let atlasHeight: number
  let rgbaBase64: string
  if (animation) {
    atlasWidth = animation.atlasWidth
    atlasHeight = animation.atlasHeight
    rgbaBase64 = animation.dto.phases[0]!
  } else {
    const dims = buildTileAtlas(entries, vram, cgram, MAP16_TILES_PER_ROW)
    atlasWidth = dims.atlasWidth
    atlasHeight = dims.atlasHeight
    rgbaBase64 = toBase64(dims.atlas)
  }

  // Frame-0 still-preview alternates (#574), only when this tileset's animation resolved.
  const animData = frameZero?.animData
  const alternates = animData
    ? buildTileAlternates(animData, entries, vram, cgram)
    : new Map<number, Map16TileAlternateDto[]>()
  const notes = animData
    ? buildSwitchNotes(animData, entries, alternates)
    : new Map<number, string>()

  const tiles: Map16TileDto[] = entries.map((tile, i) => {
    const base = pointers[i]!
    const tileAlternates = alternates.get(tile.id)
    const note = notes.get(tile.id)
    return {
      id: tile.id,
      romAddr: base,
      // Read from the resolved pointer, never inferred from the layer: a
      // tile is shared exactly when its entry falls in the Map16Common
      // run. See Map16TileDto.shared.
      shared: isShared(base),
      tl: toQuadrantDto(tile.tl, base + QUADRANT_WORD_OFFSET.tl),
      bl: toQuadrantDto(tile.bl, base + QUADRANT_WORD_OFFSET.bl),
      tr: toQuadrantDto(tile.tr, base + QUADRANT_WORD_OFFSET.tr),
      br: toQuadrantDto(tile.br, base + QUADRANT_WORD_OFFSET.br),
      ...(tileAlternates ? { alternates: tileAlternates } : {}),
      ...(note ? { switchesUnavailable: note } : {}),
    }
  })

  const citedColorRows = scanCitedColorRows(entries)
  const switchButtons = buildSwitchButtonArt(rom.rom, entries, alternates, vram, cgram)

  return {
    status: 'ok',
    sheet: {
      layer,
      tileset,
      paletteVariant,
      citedColorRows,
      cgramRows: cgramRowsFor(cgram, citedColorRows),
      charSheets: buildCharSheets(rom.rom, tileset, vram, frameZero?.animData),
      tilesPerRow: MAP16_TILES_PER_ROW,
      width: atlasWidth,
      height: atlasHeight,
      rgbaBase64,
      tiles,
      charAnimation: animation?.dto,
      animationNote: frameZero?.error,
      gfxAssignmentNote: levelGfxAssignmentNote(rom.rom),
      switchUnavailable: animData?.switchUnavailable,
      switchButtonArt: switchButtons.art,
      switchButtonUnavailable: switchButtons.unavailable,
      pipeVariantsIgnored: true,
    },
  }
}

/**
 * Whether a tile's entry is shared beyond this tileset: every L2 (background)
 * entry, and an L1 (foreground) entry inside the Map16Common run this ROM names.
 */
export function sharedTileTest(rom: RomFile, layer: Map16Layer): (base: number) => boolean {
  if (layer === 'bg') return () => true
  const common = readMap16Common(rom)
  if (!common.ok) return () => false
  const end = common.value + MAP16_TOTAL_TILES * MAP16_TILE_BYTES
  return base => base >= common.value && base < end
}

/** The word a field edit produces, or the reason it will not be written. */
export type NextWordResult = { status: 'ok'; word: number } | { status: 'refused'; reason: string }

/** `$03E0`, the form WorkingRomRegistry records an op's words in. */
export function hexWord(word: number): string {
  return `$${(word & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * The op a quadrant edit becomes, or the reason it will not be written.
 *
 * This is every decision the write path makes, and it lives HERE rather
 * than in map16-server.ts for one reason: that file imports
 * `@theia/core/shared/inversify`, the unit job does not install the
 * `theia/` workspace, and a test that imports it therefore fails to load in
 * CI while passing on any machine that happens to have the workspace. The
 * gate is a pure function of a ROM and the request, needs no container, and
 * is proven where it actually runs. Same extraction `previewId` got, for
 * the same reason.
 *
 * `Map16ServiceImpl` is left holding only the parts that genuinely need the
 * container: resolving the project's working copy, and handing the op to
 * `WorkingRomRegistry.setWord`.
 */
export type Map16WriteGate =
  | { status: 'ok'; write: SetWordRequest }
  | { status: 'unavailable'; reason: string }
  | { status: 'refused'; reason: string }

export function gateQuadrantWrite(
  rom: RomFile,
  tileset: number,
  layer: Map16Layer,
  tileId: number,
  which: Map16QuadrantKey,
  field: Map16Field,
  value: number | boolean,
): Map16WriteGate {
  // Every refusal below is a REFUSAL, never a throw: this is the RPC
  // surface, and the click path cannot produce any of these.
  if (!isValidTileset(tileset)) {
    return {
      status: 'refused',
      reason: `Tileset ${String(tileset)} is outside 0..${MAP16_TILESET_COUNT - 1}, so nothing was written.`,
    }
  }
  // Bounds the CHARACTER SPACE, not the sheets this tileset has loaded, and
  // the measurement behind that choice is on MAP16_CHAR_SPACE_END itself.
  if (field === 'charNum' && typeof value === 'number' && value >= MAP16_CHAR_SPACE_END) {
    return {
      status: 'refused',
      reason: `Character $${value.toString(16).toUpperCase()} is tilemap space, not character space ($000-$${(MAP16_CHAR_SPACE_END - 1).toString(16).toUpperCase()}), so nothing was written.`,
    }
  }
  // Gated BEFORE the write, not just on the reload after it: a ROM
  // whose Map16 this view refuses to present is one whose tile ids it
  // cannot resolve either, and a write landing at a guessed address is
  // worse than a refused edit. Per LAYER.
  const extent = map16LayerExtent(rom, layer)
  if ('reason' in extent) return { status: 'unavailable', reason: extent.reason }
  const table = layerTable(rom, tileset, layer)
  if (!table.ok)
    return {
      status: 'unavailable',
      reason: `This ROM's Map16 cannot be located: ${table.reason}, so nothing was written.`,
    }
  const count = Math.min(extent.count, table.value.length)
  if (!Number.isInteger(tileId) || tileId < 0 || tileId >= count) {
    return {
      status: 'refused',
      reason: `Tile $${Number(tileId).toString(16)} is outside the ${count} tiles this ${
        layer === 'bg' ? 'Layer 2 preset table' : "ROM's Map16 table"
      } holds, so nothing was written.`,
    }
  }
  const romAddr = table.value[tileId]! + QUADRANT_WORD_OFFSET[which]
  // Read the word straight from the working copy: `old` must be exactly
  // what is committed right now, not a re-encode of a decoded struct, or a
  // lossy codec would send a wrong `old` and every stale-check would be
  // comparing against the wrong thing (see WorkingRom.append).
  const oldWord = rom.readWord(romAddr)
  if (oldWord === null) {
    return {
      status: 'refused',
      reason: `Tile $${tileId.toString(16)} points at $${romAddr.toString(16).toUpperCase()}, which is not ROM, so nothing was written.`,
    }
  }
  const next = nextQuadrantWord(oldWord, field, value)
  if (next.status !== 'ok') return next
  return {
    status: 'ok',
    write: {
      romAddr,
      oldHex: hexWord(oldWord),
      newHex: hexWord(next.word),
      // A Map16 subtile word is not a BGR555 color: bit 15 is vertical flip,
      // real data. See PaletteOp.ts's `Op.mask`.
      mask: FULL_WORD_MASK,
    },
  }
}

/** The widest value each numeric field can hold, and what to call it in a
 * refusal. Bit widths per `decodeSubTileWord`: 10 bits of character, 3 of
 * color row. */
const NUMERIC_FIELD_LIMITS: Record<'charNum' | 'colorRow', { max: number; what: string }> = {
  charNum: { max: 0x3ff, what: 'Character' },
  colorRow: { max: 0x7, what: 'Color row' },
}

/**
 * Whether `value` is a value this field can take at all.
 *
 * The TYPE is checked before the range, and that is the half a `Number()`
 * call quietly skips: `Number(true)` is 1, a legal character, so a caller
 * that sent a boolean for `charNum` would have written character 1 and been
 * told it succeeded. `'3'` for a color row is the same defect wearing a
 * string. Only the click path is structurally safe; this is the RPC.
 */
function checkValue(field: Map16Field, value: number | boolean): string | undefined {
  if (field === 'priority' || field === 'flipX' || field === 'flipY') {
    return typeof value === 'boolean'
      ? undefined
      : `${field} takes true or false, not ${typeof value}, so nothing was written.`
  }
  const limit = NUMERIC_FIELD_LIMITS[field]
  if (!limit) return `${String(field)} is not a Map16 subtile field, so nothing was written.`
  const { max, what } = limit
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    return `${what} ${String(value)} is outside the range 0..${max} a Map16 subtile word can hold, so nothing was written.`
  }
  return undefined
}

/**
 * The word `currentWord` becomes once `field` is set to `value`: decode,
 * replace exactly that field, re-encode. Every other field round-trips
 * unchanged (Map16.subtileWord.test.ts covers the codec itself), which is
 * what lets picking a character change the character and nothing else.
 *
 * An out-of-range value is REFUSED, not clamped and not truncated.
 * `encodeSubTileWord` masks each field to its own width, deliberately, so
 * that a stray value cannot corrupt a neighbouring field - but that same
 * mask turns character $407 into $007, which is a real character and a
 * successful-looking write of the wrong one. The accordion cannot produce
 * such a value, so this guards the RPC surface, which is now the only way
 * one can arrive.
 */
export function nextQuadrantWord(
  currentWord: number,
  field: Map16Field,
  value: number | boolean,
): NextWordResult {
  const refused = checkValue(field, value)
  if (refused) return { status: 'refused', reason: refused }
  const decoded = decodeSubTileWord(currentWord)
  switch (field) {
    case 'charNum':
      return { status: 'ok', word: encodeSubTileWord({ ...decoded, charNum: value as number }) }
    case 'colorRow':
      return { status: 'ok', word: encodeSubTileWord({ ...decoded, palette: value as number }) }
    case 'priority':
      return { status: 'ok', word: encodeSubTileWord({ ...decoded, priority: value as boolean }) }
    case 'flipX':
      return { status: 'ok', word: encodeSubTileWord({ ...decoded, flipX: value as boolean }) }
    case 'flipY':
      return { status: 'ok', word: encodeSubTileWord({ ...decoded, flipY: value as boolean }) }
    // An off-union `field` arriving over RPC used to fall off the end and
    // return `undefined`, which the caller then formatted as a word and
    // threw on. The contract says refused, so refuse.
    default:
      return {
        status: 'refused',
        reason: `${String(field)} is not a Map16 subtile field, so nothing was written.`,
      }
  }
}
