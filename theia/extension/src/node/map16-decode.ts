/**
 * Pure Map16-decoding logic for the Map16 view: no Theia or RPC imports, so
 * it is unit-testable the same way gfx-decode.ts is.
 *
 * Composition (VRAM lookup, per-subtile palette, flips) is NOT reimplemented
 * here - it reuses src/rom/TileRenderer.ts's buildTileAtlas, the same
 * function TilesetCompareProvider's webview already renders from, so this
 * view's pixels can never drift from that one.
 *
 * Bit-packing (decode/encode of one subtile's 16-bit word) is NOT
 * reimplemented here either - src/rom/Map16.ts's decodeSubTileWord /
 * encodeSubTileWord is the single place that logic lives, covered by its own
 * unit tests, so a Map16 edit's read-modify-write can never disagree with
 * how a fresh load decodes the same word.
 */
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import {
  buildL2Map16PointerTable,
  buildMap16PointerTable,
  decodeSubTileWord,
  encodeSubTileWord,
  loadAllMap16,
  loadAllMap16BG,
  MAP16_COMMON,
  MAP16_TILE_BYTES,
  MAP16_TOTAL_TILES,
  Map16Tile,
  SubTile,
} from '../../../../src/rom/Map16'
import { loadVram, VramState } from '../../../../src/rom/GfxLoader'
import {
  buildLevelCgram,
  loadRomPalettes,
  type ActiveLevelPalette,
} from '../../../../src/rom/PaletteLoader'
import { buildTileAtlas } from '../../../../src/rom/TileRenderer'
import { getAnimatedChars, loadAnimationData } from '../../../../src/rom/AnimationLoader'
import { buildChars, vramFromChars } from '../../../../src/rom/model/chars/CharFactory'
import type { Char } from '../../../../src/rom/model/chars/Char'
import {
  Map16BlockDto,
  Map16CgramRowDto,
  Map16CharAnimationDto,
  Map16Field,
  Map16Layer,
  Map16PaletteVariantDto,
  Map16SheetDto,
  Map16SubTileDto,
  Map16SubtileKey,
  MAP16_TILES_PER_ROW,
  MAP16_TILESET_COUNT,
} from '../common/map16-protocol'

/** Byte offset of each subtile's own word within an 8-byte Map16 entry.
 * Column-major per Map16.ts: word0=TL, word1=BL, word2=TR, word3=BR. */
/** One Map16 block is 16x16 px, the unit buildTileAtlas lays out. */
const BLOCK_PX = 16

const SUBTILE_WORD_OFFSET: Record<Map16SubtileKey, number> = { tl: 0, bl: 2, tr: 4, br: 6 }

function isValidTileset(tileset: number): boolean {
  return Number.isInteger(tileset) && tileset >= 0 && tileset < MAP16_TILESET_COUNT
}

function requireValidTileset(tileset: number): void {
  if (!isValidTileset(tileset)) {
    throw new Error(`Map16 tileset out of range 0..${MAP16_TILESET_COUNT - 1}: ${tileset}`)
  }
}

/**
 * The 512 tiles for a layer: `fg` is the tileset's own object table
 * (bitmap-driven, common tiles interleaved with tileset-specific ones);
 * `bg` is the global Layer 2 preset table - one fixed table, `tileset` plays
 * no part in choosing IT (only in resolving VRAM for its charNums). See
 * Map16Layer's own doc comment in map16-protocol.ts.
 */
function loadTiles(rom: RomFile, tileset: number, layer: Map16Layer): Map16Tile[] {
  return layer === 'bg' ? loadAllMap16BG(rom) : loadAllMap16(rom, tileset)
}

/** The pointer table backing a layer - same fg/bg split as `loadTiles`, kept
 * as its own function so an address lookup never has to also load tiles. */
function loadPointers(rom: RomFile, tileset: number, layer: Map16Layer): number[] {
  return layer === 'bg' ? buildL2Map16PointerTable() : buildMap16PointerTable(rom, tileset)
}

function toSubTileDto(sub: SubTile, romAddr: number): Map16SubTileDto {
  return {
    charNum: sub.charNum,
    palette: sub.palette,
    priority: sub.priority,
    flipX: sub.flipX,
    flipY: sub.flipY,
    romAddr,
  }
}

/**
 * Every distinct CGRAM row (0-7) any subtile's `palette` field in `tiles`
 * actually cites, sorted. Scanned from the loaded table itself - never
 * assumed from which layer this is - so a hack whose BG or FG table cites
 * rows a vanilla measurement never saw is still reported correctly. See
 * Map16SheetDto.citedPaletteRows's own doc comment for the vanilla figures
 * that motivated this.
 */
function scanCitedPaletteRows(tiles: Map16Tile[]): number[] {
  const rows = new Set<number>()
  for (const tile of tiles) {
    rows.add(tile.tl.palette)
    rows.add(tile.tr.palette)
    rows.add(tile.bl.palette)
    rows.add(tile.br.palette)
  }
  return Array.from(rows).sort((a, b) => a - b)
}

function toBase64(atlas: Uint8ClampedArray): string {
  return Buffer.from(atlas.buffer, atlas.byteOffset, atlas.byteLength).toString('base64')
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
 * construction rather than by coincidence.
 *
 * Returns `undefined` (not an empty/zero-phase object) when
 * `loadAnimationData` finds nothing, or finds data but no subtile in
 * `tiles` actually cites an animated char - either way there is nothing to
 * play, and the widget must not show a working-looking control for it.
 */
/**
 * Whether a block's COMPOSITED pixels actually differ between phases.
 *
 * The obvious test - does any subtile cite a char the animation DMA
 * touches - over-reports badly, because the DMA rewrites many chars with
 * byte-identical data. Measured on vanilla tileset 0: of 88 blocks that
 * cite an animated char, only 36 change; 52 do not. Reporting those 52 as
 * animated makes the frame strip render four identical thumbnails, which
 * is exactly what its own doc comment forbids - a picture that says "this
 * animates" when it does not.
 *
 * Comparing the rendered atlases answers the real question instead, and
 * they are already built for playback, so this costs a scan and no extra
 * decode.
 */
function blockDiffersAcrossPhases(
  phases: readonly Uint8ClampedArray[],
  atlasWidth: number,
  tileId: number,
): boolean {
  if (phases.length < 2) return false
  const first = phases[0]!
  const x0 = (tileId % MAP16_TILES_PER_ROW) * BLOCK_PX
  const y0 = Math.floor(tileId / MAP16_TILES_PER_ROW) * BLOCK_PX
  for (let p = 1; p < phases.length; p++) {
    const other = phases[p]!
    for (let y = 0; y < BLOCK_PX; y++) {
      const row = ((y0 + y) * atlasWidth + x0) * 4
      for (let i = 0; i < BLOCK_PX * 4; i++) {
        if (first[row + i] !== other[row + i]) return true
      }
    }
  }
  return false
}

function buildCharAnimation(
  rom: RomFile,
  tileset: number,
  tiles: Map16Tile[],
  vram: VramState,
  cgram: ActiveLevelPalette,
): { dto: Map16CharAnimationDto; atlasWidth: number; atlasHeight: number } | undefined {
  const animData = loadAnimationData(rom, tileset)
  if (!animData) return undefined
  const animatedChars = getAnimatedChars(animData)
  if (animatedChars.size === 0) return undefined

  const chars: Map<number, Char> = buildChars(vram, animData)
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

  const animatedBlockIds = tiles
    .filter(t => blockDiffersAcrossPhases(rendered, atlasWidth, t.id))
    .map(t => t.id)
  if (animatedBlockIds.length === 0) return undefined

  return {
    dto: {
      frameCount: animData.frameCount,
      intervalMs: animData.intervalMs,
      phases,
      animatedBlockIds,
    },
    atlasWidth,
    atlasHeight,
  }
}

/**
 * Decode one Map16 sheet: one composited RGBA image (buildTileAtlas, 16
 * tiles per row) plus every block's subtile fields and addresses for the
 * inspector, plus the character-animation model when this tileset has one
 * (see `buildCharAnimation`).
 *
 * `tileset` always resolves VRAM (which GFX files sit in which slot); it
 * ALSO picks the pointer table when `layer === 'fg'` (see `Map16Layer`'s
 * doc comment in map16-protocol.ts - `bg`'s table is global). `paletteVariant`
 * picks the BackgroundPalettes/ForegroundPalettes entries CGRAM rows 0-3
 * load; rows 4-7 (StandardColors) are unaffected by either.
 *
 * Pipe-variant palettes ($133-$13A cycling per screen, FG-only - the BG
 * table has no such tiles) are NOT applied: `loadAllMap16` is called with no
 * `pipeVariantIdx`, which renders the bitmap-default pointers. See
 * Map16SheetDto.pipeVariantsIgnored.
 */
/** The cited rows of a built CGRAM, as CSS colors for the swatch strip. */
function cgramRowsFor(cgram: ActiveLevelPalette, cited: number[]): Map16CgramRowDto[] {
  return cited.map(row => ({
    row,
    colors: (cgram.rows[row] ?? []).map(
      c => '#' + [c[0], c[1], c[2]].map(v => v.toString(16).padStart(2, '0')).join(''),
    ),
  }))
}

export function decodeMap16Sheet(
  rom: SmwRom,
  tileset: number,
  layer: Map16Layer,
  paletteVariant: Map16PaletteVariantDto,
): Map16SheetDto {
  requireValidTileset(tileset)

  const pointers = loadPointers(rom.rom, tileset, layer)
  const tiles = loadTiles(rom.rom, tileset, layer)
  const vram = loadVram(rom.rom, tileset)
  const palettes = loadRomPalettes(rom.rom)
  // Sprite param fixed at 0: buildLevelCgram's sprite variant only reaches
  // CGRAM rows 14-15, which a Map16 subtile's 3-bit palette field (0-7) can
  // never select - see Map16PaletteVariantDto's own doc comment.
  const cgram = buildLevelCgram(palettes, paletteVariant.bg, paletteVariant.fg, 0)

  const animation = buildCharAnimation(rom.rom, tileset, tiles, vram, cgram)

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
    const dims = buildTileAtlas(tiles, vram, cgram, MAP16_TILES_PER_ROW)
    atlasWidth = dims.atlasWidth
    atlasHeight = dims.atlasHeight
    rgbaBase64 = toBase64(dims.atlas)
  }

  const blocks: Map16BlockDto[] = tiles.map((tile, i) => {
    const base = pointers[i]!
    return {
      id: tile.id,
      romAddr: base,
      // Read from the resolved pointer, never inferred from the layer: a
      // block is shared exactly when its entry falls in the Map16Common
      // run. See Map16BlockDto.shared.
      shared:
        layer === 'bg' ||
        (base >= MAP16_COMMON && base < MAP16_COMMON + MAP16_TOTAL_TILES * MAP16_TILE_BYTES),
      tl: toSubTileDto(tile.tl, base + SUBTILE_WORD_OFFSET.tl),
      bl: toSubTileDto(tile.bl, base + SUBTILE_WORD_OFFSET.bl),
      tr: toSubTileDto(tile.tr, base + SUBTILE_WORD_OFFSET.tr),
      br: toSubTileDto(tile.br, base + SUBTILE_WORD_OFFSET.br),
    }
  })

  return {
    layer,
    tileset,
    paletteVariant,
    citedPaletteRows: scanCitedPaletteRows(tiles),
    cgramRows: cgramRowsFor(cgram, scanCitedPaletteRows(tiles)),
    tilesPerRow: MAP16_TILES_PER_ROW,
    width: atlasWidth,
    height: atlasHeight,
    rgbaBase64,
    blocks,
    charAnimation: animation?.dto,
    pipeVariantsIgnored: true,
  }
}

/** The ROM address of one subtile's own 16-bit word, for a given layer/tileset/tile/corner. */
export function subtileWordAddress(
  rom: RomFile,
  tileset: number,
  layer: Map16Layer,
  tileId: number,
  which: Map16SubtileKey,
): number {
  requireValidTileset(tileset)
  const pointers = loadPointers(rom, tileset, layer)
  const base = pointers[tileId]
  if (base === undefined) {
    throw new Error(`Map16 tile id out of range 0..${pointers.length - 1}: ${tileId}`)
  }
  return base + SUBTILE_WORD_OFFSET[which]
}

/**
 * The word `currentWord` becomes once `field` is set to `value`: decode,
 * replace exactly that field, re-encode. Every other field round-trips
 * unchanged (Map16.subtileWord.test.ts covers the codec itself).
 */
export function nextSubtileWord(
  currentWord: number,
  field: Map16Field,
  value: number | boolean,
): number {
  const decoded = decodeSubTileWord(currentWord)
  switch (field) {
    case 'charNum':
      return encodeSubTileWord({ ...decoded, charNum: Number(value) })
    case 'palette':
      return encodeSubTileWord({ ...decoded, palette: Number(value) })
    case 'priority':
      return encodeSubTileWord({ ...decoded, priority: Boolean(value) })
    case 'flipX':
      return encodeSubTileWord({ ...decoded, flipX: Boolean(value) })
    case 'flipY':
      return encodeSubTileWord({ ...decoded, flipY: Boolean(value) })
  }
}
