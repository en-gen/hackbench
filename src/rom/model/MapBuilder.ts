import { loadAnimationData } from '../AnimationLoader'
import { loadExAnimData, mergeAnimationData } from '../ExAnimationLoader'
import { loadL3Chars, loadVram } from '../GfxLoader'
import {
  isLevelModeVertical,
  parseLevelHeader,
  parseLevelObjects,
  parseLevelSprites,
} from '../LevelParser'
import { TILE_EMPTY, expandMap } from '../ObjectExpander'
import type { SmwRom } from '../SmwRom'
import type { Char } from './chars/Char'
import { buildChars } from './chars/CharFactory'
import { buildBgTiles, buildL2 } from './L2Factory'
import { buildL3 } from './L3Factory'
import { readInitialLayer1YPos, readMarioStartPos } from '../L3Loader'
import type { MapPayload } from './MapPayload'
import { buildPalette } from './palette/PaletteFactory'
import { serialize } from './serialize'
import { SmwMap } from './SmwMap'
import { buildSprites } from './SpriteFactory'
import { createMapStore } from './stores/mapStore'
import type { Tile } from './tiles/Tile'
import { buildTiles, makePlaceholderBoxChar } from './tiles/TileFactory'

export interface BuiltMap {
  map: SmwMap
  chars: Map<number, Char>
  tiles: Map<number, Tile>
}

/**
 * Per-level property overrides. Match the toolbar dropdowns — any field
 * left undefined falls through to the ROM level-header default.
 *
 * These feed VRAM / palette / tile-atlas builders so changing BG palette
 * or tileset dropdowns in the editor rebuilds the model with the new
 * selection in one shot (no shadowed legacy state).
 */
export interface MapBuildOverrides {
  bgPalette?:     number
  fgPalette?:     number
  bgColor?:       number
  spritePalette?: number
  spriteSet?:     number
  objectTileset?: number
  marioVariant?:  number
}

/**
 * Build an SmwMap plus the underlying char/tile graphs for one level.
 * Callers that only want the map should use `buildMap`; `serialize`
 * needs the full bundle.
 */
export function buildMapWithGraph(
  rom: SmwRom,
  levelId: number,
  overrides: MapBuildOverrides = {},
): BuiltMap {
  const raw = rom.getLevelRawData(levelId)
  if (!raw) throw new Error(`Level $${levelId.toString(16)} has no L1 data`)

  const rawHeader = parseLevelHeader(raw)
  const parsed = parseLevelObjects(raw)
  const isVertical = isLevelModeVertical(rawHeader.levelMode)
  const orientation = isVertical ? 'vertical' : 'horizontal'
  const screens = rawHeader.levelLength

  // Apply toolbar dropdown overrides on top of the ROM header. Every
  // downstream builder that cares about palette / tileset / sprite set
  // reads from this effective header rather than the raw one.
  const header = {
    ...rawHeader,
    bgPalette:      overrides.bgPalette     ?? rawHeader.bgPalette,
    fgPalette:      overrides.fgPalette     ?? rawHeader.fgPalette,
    bgColor:        overrides.bgColor       ?? rawHeader.bgColor,
    spritePalette:  overrides.spritePalette ?? rawHeader.spritePalette,
    spriteSet:      overrides.spriteSet     ?? rawHeader.spriteSet,
    objectTileset:  overrides.objectTileset ?? rawHeader.objectTileset,
  }
  const tileset = header.objectTileset

  const vram = loadVram(rom.rom, tileset, header.spriteSet)
  const vanillaAnimData = loadAnimationData(rom.rom, tileset) ?? undefined
  const exAnimData = loadExAnimData(rom.rom, levelId) ?? undefined
  const animData = vanillaAnimData && exAnimData
    ? mergeAnimationData(vanillaAnimData, exAnimData)
    : vanillaAnimData ?? exAnimData
  const chars = buildChars(vram, animData)
  chars.set(-2, makePlaceholderBoxChar())
  const tiles = buildTiles(rom.rom, tileset, chars)
  const l3Chars = loadL3Chars(rom.rom)
  // The BG Map16 table is always loaded fresh from the ROM (all 512
  // entries, regardless of whether this level's L2 references every
  // one) so tile-viewer panels can show the full palette. L2 layers
  // hold ids that resolve against this shared map at render time.
  const bgTiles = buildBgTiles(rom.rom, chars)

  const grid = expandMap(parsed.objects, screens, rom.rom, tileset, isVertical, rawHeader.levelMode)
  // L1 tilemap as ids — resolve against `tiles` (aka l1Tiles) at render
  // time. Empty cells survive as null.
  const l1: (number | null)[][] = grid.map(row =>
    row.map(id => (id === TILE_EMPTY ? null : id)),
  )

  // Per-screen pipe variant: SMW cycles variants 0→1→2→3 across screens
  // (MapEditorProvider uses `s & 0x03` for the legacy path). This drives
  // the grey/green/yellow/blue palette of tiles $133-$13A on each screen.
  const screenPipeVariantIdx = Array.from({ length: screens }, (_, s) => s & 0x03)

  const l2 = buildL2(rom.rom, levelId, header, screens, isVertical, chars, tiles, bgTiles)
  const l3 = buildL3(rom.rom, levelId, tileset, l3Chars, screens, isVertical, rawHeader.timeLimit)

  // Sprites live in a separate pointer table from L1; empty list if the level
  // has no sprite data (e.g., title screens, OW sub-maps without spawns).
  const sprPtr = rom.getLevelSpritePointer(levelId)
  let levelSprites: ReturnType<typeof parseLevelSprites> = []
  if (sprPtr) {
    const sprData = rom.rom.readAt(sprPtr, 0x200)
    if (sprData) levelSprites = parseLevelSprites(sprData, isVertical)
  }
  const marioStartPx = readMarioStartPos(rom.rom, levelId)
  const sprites = buildSprites(rom.rom, levelSprites, chars, l1, marioStartPx, tiles)

  // Layer-2 scroll/parallax settings. CODE_05D26E (bank_05.asm:7268-7277)
  // reads $05F000+idx, takes the top nibble, and looks up per-axis rate
  // bytes in VertLayer2Setting / HorizLayer2Setting. The webview camera
  // viewport uses these to re-composite BG at the parallax-shifted
  // position inside the preview rect.
  const scrollByte  = rom.rom.readByte(0x05F000 + levelId) ?? 0
  const scrollIndex = (scrollByte >> 4) & 0x0F
  const vertLayer2Setting  = rom.rom.readByte(0x05D710 + scrollIndex) ?? 0
  const horizLayer2Setting = rom.rom.readByte(0x05D720 + scrollIndex) ?? 0

  // Initial camera Y (Layer1YPos): bits 3:2 of DATA_05F200[level] index into
  // DATA_05D708 ($00, $60, $C0, $00). For vertical levels, DATA_05F600[level]
  // & $1F provides the page high byte. See bank_05.asm:7329-7335 and 7386-7388.
  const initialCameraYPx = readInitialLayer1YPos(rom.rom, levelId, isVertical)

  const palette = buildPalette(rom.rom, header)
  const mapStore = createMapStore({
    palette,
    levelOrientation: orientation,
    screenPipeVariantIdx,
    initialCameraYPx,
    marioSpawnX: marioStartPx?.x ?? 0,
  })
  const map = new SmwMap(
    levelId,
    {
      mode: header.levelMode,
      music: header.music,
      tileset,
      orientation,
      vertLayer2Setting,
      horizLayer2Setting,
      layer3Priority: rawHeader.layer3Priority,
      initialCameraYPx,
      timeLimit: rawHeader.timeLimit,
      marioStartPx,
    },
    l1,
    l2,
    l3,
    sprites,
    palette,
    tileset,
    screens,
    screenPipeVariantIdx,
    tiles,
    bgTiles,
    mapStore,
  )

  return { map, chars, tiles }
}

/**
 * Build a fully-wired SmwMap for one level. Convenience wrapper around
 * `buildMapWithGraph` for callers that only want the map.
 */
export function buildMap(
  rom: SmwRom,
  levelId: number,
  overrides: MapBuildOverrides = {},
): SmwMap {
  return buildMapWithGraph(rom, levelId, overrides).map
}

/**
 * Build a map and immediately serialize to a `MapPayload` suitable for
 * shipping across `postMessage` into the webview.
 */
export function buildMapPayload(
  rom: SmwRom,
  levelId: number,
  overrides: MapBuildOverrides = {},
): MapPayload {
  const { map, chars, tiles } = buildMapWithGraph(rom, levelId, overrides)
  return serialize(map, chars, tiles)
}
