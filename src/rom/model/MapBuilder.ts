import { loadAnimationData } from '../AnimationLoader'
import { loadExAnimData, mergeAnimationData } from '../ExAnimationLoader'
import { loadL3Chars, loadVram } from '../GfxLoader'
import {
  isLevelModeVertical,
  parseLevelHeader,
  parseLevelObjects,
  parseLevelSprites,
} from '../LevelParser'
import { TILE_EMPTY, expandMap, SWITCH_FLAGS_CLEARED } from '../ObjectExpander'
import type { SmwRom } from '../SmwRom'
import type { Char } from './chars/Char'
import { buildChars } from './chars/CharFactory'
import {
  findLevelScrollSprite,
  findLevelScrollSpriteFull,
  readInitialLayer2YPos,
} from '../L2Loader'
import { simulateScrollSetup } from '../scrollDispatch'
import { buildScrollSimulator } from '../scrollSim'
import { buildBgTiles, buildL2 } from './L2Factory'
import { buildL3 } from './L3Factory'
import { readInitialLayer1YPos, readMarioStartPos } from '../L3Loader'
import type { MapPayload } from './MapPayload'
import { buildPalette } from './palette/PaletteFactory'
import { serialize } from './serialize'
import { SmwMap } from './SmwMap'
import { DEFAULT_OBJ_PRIORITY, readLevelObjPriority } from '../SpritePriorityLoader'
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
 * Per-level property overrides. Match the toolbar dropdowns - any field
 * left undefined falls through to the ROM level-header default.
 *
 * These feed VRAM / palette / tile-atlas builders so changing BG palette
 * or tileset dropdowns in the editor rebuilds the model with the new
 * selection in one shot (no shadowed legacy state).
 */
export interface MapBuildOverrides {
  bgPalette?: number
  fgPalette?: number
  bgColor?: number
  spritePalette?: number
  spriteSet?: number
  objectTileset?: number
  marioVariant?: number
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
  const verticalTable = rom.requireVerticalTable()

  const rawHeader = parseLevelHeader(raw)
  const parsed = parseLevelObjects(raw, verticalTable)
  const isVertical = isLevelModeVertical(rawHeader.levelMode, verticalTable)
  const orientation = isVertical ? 'vertical' : 'horizontal'
  const screens = rawHeader.levelLength

  // Apply toolbar dropdown overrides on top of the ROM header. Every
  // downstream builder that cares about palette / tileset / sprite set
  // reads from this effective header rather than the raw one.
  const header = {
    ...rawHeader,
    bgPalette: overrides.bgPalette ?? rawHeader.bgPalette,
    fgPalette: overrides.fgPalette ?? rawHeader.fgPalette,
    bgColor: overrides.bgColor ?? rawHeader.bgColor,
    spritePalette: overrides.spritePalette ?? rawHeader.spritePalette,
    spriteSet: overrides.spriteSet ?? rawHeader.spriteSet,
    objectTileset: overrides.objectTileset ?? rawHeader.objectTileset,
  }
  const tileset = header.objectTileset

  const vram = loadVram(rom.rom, tileset, header.spriteSet)
  const vanillaAnimData = loadAnimationData(rom.rom, tileset) ?? undefined
  const exAnimData = loadExAnimData(rom.rom, levelId) ?? undefined
  const animData =
    vanillaAnimData && exAnimData
      ? mergeAnimationData(vanillaAnimData, exAnimData)
      : (vanillaAnimData ?? exAnimData)
  const chars = buildChars(vram, animData)
  chars.set(-2, makePlaceholderBoxChar())
  const tiles = buildTiles(rom.rom, tileset, chars)
  const l3Chars = loadL3Chars(rom.rom)
  // The BG Map16 table is always loaded fresh from the ROM (all 512
  // entries, regardless of whether this level's L2 references every
  // one) so tile-viewer panels can show the full palette. L2 layers
  // hold ids that resolve against this shared map at render time.
  const bgTiles = buildBgTiles(rom.rom, chars)

  // Reference webview only (#567): pin the pre-fix always-cleared grid.
  const grid = expandMap(
    parsed.objects,
    screens,
    rom.rom,
    tileset,
    isVertical,
    rawHeader.levelMode,
    undefined,
    SWITCH_FLAGS_CLEARED,
  )
  // L1 tilemap as ids - resolve against `tiles` (aka l1Tiles) at render
  // time. Empty cells survive as null.
  const l1: (number | null)[][] = grid.map(row => row.map(id => (id === TILE_EMPTY ? null : id)))

  // Per-screen pipe variant: SMW cycles variants 0→1→2→3 across screens
  // (MapEditorProvider uses `s & 0x03` for the legacy path). This drives
  // the grey/green/yellow/blue palette of tiles $133-$13A on each screen.
  const screenPipeVariantIdx = Array.from({ length: screens }, (_, s) => s & 0x03)

  // Sprites live in a separate pointer table from L1; empty list if the level
  // has no sprite data (e.g., title screens, OW sub-maps without spawns).
  // Parsed early so buildL2 can scan for the level's scroll sprite.
  const sprPtr = rom.getLevelSpritePointer(levelId)
  let levelSprites: ReturnType<typeof parseLevelSprites> = []
  if (sprPtr) {
    const sprData = rom.rom.readAt(sprPtr, 0x200)
    if (sprData) levelSprites = parseLevelSprites(sprData, isVertical)
  }
  // Scroll-sprite spawn writes Layer1ScrollCmd at bank_02.asm:5290-5300
  // (NOT Layer2ScrollCmd - that byte stays 0 in gameplay). Recorded on the
  // L2 layer purely for diagnostic labelling on the scroll-range overlay.
  const layer1ScrollCmd = findLevelScrollSprite(levelSprites)

  // Initial Layer1YPos (camera Y) used by L2/L3 render-time offset math.
  // Hoisted above buildL2 so it can flow into computeL2ScrollRange.
  const initialCameraYPx = readInitialLayer1YPos(rom.rom, levelId, isVertical)

  // Mario spawn - needed by the scroll simulator's seed and by the
  // `faceRight` resolution in buildSprites. Nothing reads the
  // `mapStore.marioSpawnX` copy below any more; see src/rom/model/CLAUDE.md.
  // Hoisted above buildL2.
  const marioStartPx = readMarioStartPos(rom.rom, levelId)

  // Layer-2 scroll/parallax settings. CODE_05D26E (bank_05.asm:7268-7277)
  // reads $05F000+idx, takes the top nibble, and looks up per-axis rate
  // bytes in VertLayer2Setting / HorizLayer2Setting. The webview camera
  // viewport uses these to re-composite BG at the parallax-shifted
  // position inside the preview rect.
  const scrollByte = rom.rom.readByte(0x05f000 + levelId) ?? 0
  const scrollIndex = (scrollByte >> 4) & 0x0f
  const vertLayer2Setting = rom.rom.readByte(0x05d710 + scrollIndex) ?? 0
  const horizLayer2Setting = rom.rom.readByte(0x05d720 + scrollIndex) ?? 0

  // Build the per-level frame-accurate scroll simulator. We need the
  // scroll-sprite's full byte 0 (not just the cmd) plus the resolved
  // post-setup cmds + bits from `simulateScrollSetup`. When the level
  // has no scroll sprite the simulator is null and `L2ObjectStream`
  // falls back to the static initial offset.
  //
  // The simulator's seed represents the PRE-tick state - same shape
  // as the Mesen capture's row 1 (post-`CODE_05BD36` setup, pre-first-
  // parallax-call). `buildScrollSimulator` runs the cmd setup
  // internally so callers don't need to.
  const scrollSpriteFull = findLevelScrollSpriteFull(levelSprites)
  const setupState = scrollSpriteFull
    ? simulateScrollSetup(rom.rom, scrollSpriteFull.spriteId, scrollSpriteFull.b0)
    : null
  const initialLayer2YPx = readInitialLayer2YPos(rom.rom, levelId, isVertical)
  const scrollSimulator = setupState
    ? buildScrollSimulator(rom.rom, {
        layer1XPos: 0, // horizontal levels start at 0
        layer1YPos: initialCameraYPx, // DATA_05D708 init
        layer2XPos: 0,
        layer2YPos: initialLayer2YPx, // DATA_05D70C init
        layer1ScrollCmd: setupState.layer1ScrollCmd,
        layer2ScrollCmd: setupState.layer2ScrollCmd,
        layer1ScrollBits: setupState.layer1ScrollBits,
        layer2ScrollBits: setupState.layer2ScrollBits,
        horizLayer2Setting,
        vertLayer2Setting,
        marioSpawnX: marioStartPx?.x ?? 0,
        marioSpawnY: marioStartPx?.y ?? 0,
        screenMode: header.levelMode,
        horizLayer1Setting: isVertical ? 0 : 1,
      })
    : null

  const l2 = buildL2(
    rom.rom,
    levelId,
    header,
    screens,
    isVertical,
    chars,
    tiles,
    bgTiles,
    layer1ScrollCmd,
    initialCameraYPx,
    verticalTable,
  )
  const l3 = buildL3(rom.rom, levelId, tileset, l3Chars, screens, isVertical, rawHeader.timeLimit)

  // Per-level default OBJ priority: LevXYPPCCCTtbl[levelMode] (bank_05.asm:505-509,
  // stored to SpriteProperties at :542-543). Null means the table read failed;
  // buildSprites then falls back to its own documented default.
  const levelObjPriority = readLevelObjPriority(rom.rom, header.levelMode)
  const sprites = buildSprites(
    rom.rom,
    levelSprites,
    chars,
    l1,
    marioStartPx,
    tiles,
    levelObjPriority ?? DEFAULT_OBJ_PRIORITY,
  )

  const palette = buildPalette(rom.rom, header)

  const mapStore = createMapStore({
    palette,
    levelOrientation: orientation,
    screenPipeVariantIdx,
    initialCameraYPx,
    marioSpawnX: marioStartPx?.x ?? 0,
    scrollSimulator,
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
export function buildMap(rom: SmwRom, levelId: number, overrides: MapBuildOverrides = {}): SmwMap {
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
