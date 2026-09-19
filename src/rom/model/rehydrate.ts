import { Char } from './chars/Char'
import type { CharBehavior } from './chars/CharBehavior'
import { AnimatedPixelsBehavior } from './chars/behaviors/AnimatedPixelsBehavior'
import { PSwitchAlternateBehavior } from './chars/behaviors/PSwitchAlternateBehavior'
import { StaticPixelsBehavior } from './chars/behaviors/StaticPixelsBehavior'
import { buildL2Tiles, buildTileDyRanges } from './L2Factory'
import { L2ObjectStream, L2Preset, type L2Layer } from './L2Layer'
import { buildScrollSimulator, computeLayer2YRange, computeColumnDyRanges, type ScrollSimulator } from '../scrollSim'
import { L3TilemapLayer, type L3Layer } from './L3Layer'
import { Sprite } from './sprites/Sprite'
import { CompositeSprite } from './sprites/CompositeSprite'
import { type SpritePart } from './sprites/appearances/StaticSpriteAppearance'
import { buildSpriteAppearance } from './sprites/appearances/AppearanceFactory'
import { RipVanFishAppearance } from './sprites/appearances/RipVanFishAppearance'
import { ThwompAppearance } from './sprites/appearances/ThwompAppearance'
import { WingedSpriteAppearance } from './sprites/appearances/WingedSpriteAppearance'
import { HammerBroAppearance } from './sprites/appearances/HammerBroAppearance'
import { HammerBroPlatformAppearance } from './sprites/appearances/HammerBroPlatformAppearance'
import { SuperKoopaAppearance } from './sprites/appearances/SuperKoopaAppearance'
import { VolcanoLotusAppearance } from './sprites/appearances/VolcanoLotusAppearance'
import { LineBrownPlatAppearance } from './sprites/appearances/LineBrownPlatAppearance'
import { LineCheckerPlatAppearance } from './sprites/appearances/LineCheckerPlatAppearance'
import { RopeMechanismAppearance } from './sprites/appearances/RopeMechanismAppearance'
import { ChainsawAppearance } from './sprites/appearances/ChainsawAppearance'
import { MagikoopaAppearance } from './sprites/appearances/MagikoopaAppearance'
import { SpikeTopAppearance } from './sprites/appearances/SpikeTopAppearance'
import { MontyMoleAppearance } from './sprites/appearances/MontyMoleAppearance'
import { WoodSpikeAppearance } from './sprites/appearances/WoodSpikeAppearance'
import { WigglerAppearance } from './sprites/appearances/WigglerAppearance'
import { attachEngineAppearances } from './sprites/generic/EngineSpriteAppearance'
import { buildMovementBehavior } from './sprites/behaviors/BehaviorFactory'
import type { SpriteBehavior } from './sprites/SpriteBehavior'
import type { SpriteAppearance } from './sprites/SpriteAppearance'
import { Color } from './palette/Color'
import type { ColorBehavior } from './palette/ColorBehavior'
import { CyclingColorBehavior } from './palette/behaviors/CyclingColorBehavior'
import { StaticColorBehavior } from './palette/behaviors/StaticColorBehavior'
import { Palette } from './palette/Palette'
import type {
  CharDescriptor,
  ColorDescriptor,
  L2Descriptor,
  L3Descriptor,
  MapPayload,
  PaletteDescriptor,
  SpriteAppearanceDescriptor,
  SpriteDescriptor,
  SpritePartDescriptor,
  SubTileDescriptor,
  SubtileQuadDescriptor,
  TileDescriptor,
} from './MapPayload'
import { NO_COLLISION } from './tiles/TileCollision'
import { SmwMap } from './SmwMap'
import { createMapStore } from './stores/mapStore'
import { SubTile } from './tiles/SubTile'
import { Tile, type SubtileQuad } from './tiles/Tile'
import { InvisibleBlockRevealBehavior } from './tiles/behaviors/InvisibleBlockRevealBehavior'
import { PipeVariantsBehavior } from './tiles/behaviors/PipeVariantsBehavior'
import { KeyCoinBalloonKoopaBlockBehavior } from './tiles/behaviors/KeyCoinBalloonKoopaBlockBehavior'
import { PSwitchRevealBehavior } from './tiles/behaviors/PSwitchRevealBehavior'
import { StaticQuadBehavior } from './tiles/behaviors/StaticQuadBehavior'
import { SwitchPalaceAlternateBehavior } from './tiles/behaviors/SwitchPalaceAlternateBehavior'
import { StarOneUpVineBlockBehavior } from './tiles/behaviors/StarOneUpVineBlockBehavior'
import { VineSourceBehavior } from './tiles/behaviors/VineSourceBehavior'

/**
 * Rebuild the model graph from a `MapPayload`. This is the single
 * `kind`-switch site in the webview: past the rehydrator, everything
 * is polymorphic `Char` / `Tile` / `Color` / `Palette` / `SmwMap`.
 */
export function buildGraph(payload: MapPayload, rom: import('../RomFile').RomFile | null = null): {
  map: SmwMap
  chars: Map<number, Char>
  tiles: Map<number, Tile>
  bgTiles: Map<number, Tile>
} {
  const chars = new Map<number, Char>()
  for (const [idStr, desc] of Object.entries(payload.chars)) {
    const id = Number(idStr)
    chars.set(id, new Char(id, buildCharBehavior(desc)))
  }

  const placeholderChar = new Char(-1, new StaticPixelsBehavior(new Uint8Array(64)))
  const tiles = new Map<number, Tile>()
  for (const [idStr, desc] of Object.entries(payload.tiles)) {
    const id = Number(idStr)
    tiles.set(id, new Tile(id, buildTileBehavior(desc, chars, placeholderChar), desc.actsLike ?? id, desc.collision ?? NO_COLLISION))
  }

  // BG tiles (for L2 preset Map16 viewer) — built separately from the L2
  // grid's internal copy so the viewer can render all available BG tiles.
  const bgTiles = new Map<number, Tile>()
  if (payload.bgTiles) {
    for (const [idStr, td] of Object.entries(payload.bgTiles)) {
      const id = Number(idStr)
      bgTiles.set(id, new Tile(id, buildTileBehavior(td, chars, placeholderChar), td.actsLike ?? id, td.collision ?? NO_COLLISION))
    }
  }

  const palette = buildPalette(payload.palette)
  // L1 grid stays as ids — resolve against `tiles` (l1Tiles) at render.
  const l1: (number | null)[][] = payload.layout.map(row =>
    row.map(id => (id === null ? null : id)),
  )

  const l3 = buildL3(payload.l3 ?? null)
  const sprites = payload.sprites.map(s => buildSprite(s, chars, placeholderChar))
  // Engine render path (scaffolding, toggle default OFF). Attached HERE, on
  // the webview side of the boundary, because this is where the map the user
  // looks at is built. `test/suite/unit/sprites/SpriteEngineWiring.test.ts`
  // fails if this line stops attaching anything.
  attachEngineAppearances(sprites, rom, chars, placeholderChar)

  const screenPipeVariantIdx = [...payload.screenPipeVariantIdx]
  // Scroll simulator: rebuilt from the seed shipped in the payload.
  // Every scroll handler reads data tables from the open ROM (no
  // hardcoded JS constants — issue: ROM-editor invariant), so this
  // requires a `RomFile` to be reachable on whichever side we're on:
  //   - Host (MapBuilder): passes the live `RomFile` directly.
  //   - Webview (this path): the host posts the ROM bytes alongside
  //     `modelPayload`; the message handler builds a `RomFile` from
  //     them and passes it here.
  // When `rom` is null and a seed is present (legacy callers / tests),
  // skip the simulator — the L2 layer falls back to its static path.
  const scrollSimulator = (rom !== null && payload.scrollSim)
    ? buildScrollSimulator(rom, payload.scrollSim)
    : null
  const l2 = buildL2(payload.l2, tiles, bgTiles, scrollSimulator, payload.header.initialCameraYPx)
  const mapStore = createMapStore({
    palette,
    levelOrientation: payload.header.orientation,
    screenPipeVariantIdx,
    initialCameraYPx: payload.header.initialCameraYPx,
    marioSpawnX: payload.header.marioStartPx?.x ?? 0,
    scrollSimulator,
  })
  const map = new SmwMap(
    payload.levelId,
    payload.header,
    l1,
    l2,
    l3,
    sprites,
    palette,
    payload.tileset,
    payload.screenCount,
    screenPipeVariantIdx,
    tiles,
    bgTiles,
    mapStore,
  )

  return { map, chars, tiles, bgTiles }
}

function buildSprite(desc: SpriteDescriptor, chars: Map<number, Char>, placeholder: Char): Sprite {
  const appearance = buildAppearance(desc.appearance, chars, placeholder, desc.id)
  const behavior = buildBehavior(desc)
  const sprite = desc.secondary
    ? new CompositeSprite(
        desc.id, desc.x, desc.y, appearance, behavior,
        buildSprite(desc.secondary, chars, placeholder),
      )
    : new Sprite(desc.id, desc.x, desc.y, appearance, behavior)
  // The host already read this off the cart; the webview has no ROM.
  if (desc.priority) sprite.priority = desc.priority
  return sprite
}

/**
 * Reconstruct the sprite's `SpriteBehavior` from its descriptor. Delegates
 * to the single `buildMovementBehavior` dispatch — the same factory used on
 * the extension host — so class instances exist identically on both sides
 * without any prototype-reattach dance. The descriptor's `kind` is then
 * layered back on in case the serialized value differed from what the id
 * alone would derive.
 */
function buildBehavior(desc: SpriteDescriptor): SpriteBehavior {
  const b = buildMovementBehavior(desc.id, {
    displayName:  desc.behavior.displayName,
    spawns:       desc.behavior.spawns,
    isGenerator:  desc.behavior.isGenerator,
    reactRangeDy: desc.behavior.reactRangeDy,
  })
  return Object.assign(b, { kind: desc.behavior.kind })
}

function buildAppearance(
  desc: SpriteAppearanceDescriptor,
  chars: Map<number, Char>,
  placeholder: Char,
  spriteId: number,
): SpriteAppearance {
  const buildParts = (rawParts: readonly SpritePartDescriptor[]): SpritePart[] =>
    rawParts.map(p => ({
      char: chars.get(p.charNum) ?? placeholder,
      palette: p.palette,
      flipX: p.flipX,
      flipY: p.flipY,
      dx: p.dx,
      dy: p.dy,
    }))

  switch (desc.kind) {
    case 'static':
      // All "pure-parts" appearances (incl. PSwitch, CheepCheep variants,
      // KoopaAppearance, etc.) come back through `buildSpriteAppearance`
      // — the single source of truth for spriteId → subclass mapping
      // shared by SpriteFactory (host) and rehydrate (webview).
      return buildSpriteAppearance(spriteId, buildParts(desc.parts))
    case 'thwomp':
      return new ThwompAppearance(
        buildParts(desc.bodyParts),
        buildParts(desc.alertFace),
        buildParts(desc.aggressiveFace),
      )
    case 'ripVanFish':
      return new RipVanFishAppearance(
        [buildParts(desc.sleepFrames[0]), buildParts(desc.sleepFrames[1])],
        [buildParts(desc.awakeFrames[0]), buildParts(desc.awakeFrames[1])],
        buildParts(desc.zParts),
      )
    case 'wingedSprite':
      return new WingedSpriteAppearance(
        buildParts(desc.bodyParts),
        [buildParts(desc.wingFrames[0]), buildParts(desc.wingFrames[1])],
        desc.wingsInFront,
      )
    case 'hammerBroPlatform':
      return new HammerBroPlatformAppearance(
        buildParts(desc.platformParts),
        [buildParts(desc.wingFrames[0]), buildParts(desc.wingFrames[1])],
      )
    case 'superKoopa': {
      const rp = (frames: readonly [readonly SpritePartDescriptor[], readonly SpritePartDescriptor[]]) => ({
        flapA: buildParts(frames[0]),
        flapB: buildParts(frames[1]),
      })
      return new SuperKoopaAppearance(
        rp(desc.grounded),
        rp(desc.groundedFlash),
        rp(desc.airborne),
        rp(desc.airborneFlash),
        desc.isAirborne,
      )
    }
    case 'volcanoLotus':
      return new VolcanoLotusAppearance(
        buildParts(desc.headParts),
        [buildParts(desc.flowerFrames[0]), buildParts(desc.flowerFrames[1])],
      )
    case 'lineBrownPlat':
      return new LineBrownPlatAppearance(buildParts(desc.platformParts), desc.direction)
    case 'lineCheckerPlat':
      return new LineCheckerPlatAppearance(buildParts(desc.platformParts), desc.xShift, desc.width)
    case 'chainsaw':
      return new ChainsawAppearance(
        desc.motorFrames.map(buildParts),
        buildParts(desc.chainParts),
      )
    case 'ropeMechanism':
      return new RopeMechanismAppearance(
        desc.motorFrames.map(buildParts),
        buildParts(desc.bodyTemplate),
        buildParts(desc.knotTemplate),
        desc.smokePuffFrames.map(buildParts),
        desc.segmentCount,
      )
    case 'spikeTop':
      return new SpikeTopAppearance(buildParts(desc.parts0), buildParts(desc.parts1))
    case 'montyMole':
      return new MontyMoleAppearance(
        buildParts(desc.parts0),
        buildParts(desc.parts1),
        buildParts(desc.emerged),
      )
    case 'magikoopa':
      return new MagikoopaAppearance(desc.frames.map(buildParts), desc.dynColors)
    case 'hammerBro':
      return new HammerBroAppearance(buildParts(desc.parts))
    case 'woodSpike':
      return WoodSpikeAppearance.fromTables(chars, desc.spriteId, placeholder, desc.spriteMisc151C)
    case 'wiggler':
      return WigglerAppearance.fromTables(chars, desc.palette, desc.charHigh, desc.faceLeft, placeholder)
  }
}

function buildL3(desc: L3Descriptor | null): L3Layer | null {
  if (!desc) return null
  const tilemap = new Uint16Array(desc.tilemap)
  // Reconstruct GfxSheet[]: each sheet has 128 tiles; 4 sheets total.
  const l3Chars: Uint8Array[][] = []
  for (let f = 0; f < 4; f++) {
    const sheet: Uint8Array[] = []
    for (let t = 0; t < 128; t++) {
      const idx = f * 128 + t
      const pixels = desc.chars[idx]
      sheet.push(pixels ? new Uint8Array(pixels) : new Uint8Array(64))
    }
    l3Chars.push(sheet)
  }
  return new L3TilemapLayer(
    tilemap, l3Chars, desc.initialYPx, desc.levelPixelW, desc.levelPixelH, desc.scrollRange,
  )
}

function buildL2(
  desc: L2Descriptor | null,
  l1Tiles: Map<number, Tile>,
  bgTiles: Map<number, Tile>,
  scrollSim: ScrollSimulator | null,
  initialCameraYPx: number,
): L2Layer | null {
  if (!desc) return null
  if (desc.kind === 'preset') {
    const grid: (number | null)[][] = desc.layout.map(row =>
      row.map(id => id),
    )
    return new L2Preset(desc.page, grid, bgTiles)
  }
  // Object-stream L2 shares the L1 Map16 table — same id lookup. For
  // tileset-3 levels, wrap each tile's behavior in PaletteOrBehavior(4)
  // to mirror the runtime ORA #$1000 SMW applies during L2 BG2 strip
  // upload (bank_05.asm:1463-1480). `paletteOrMask = 0` is a no-op so
  // other tilesets just reuse l1Tiles.
  const grid: (number | null)[][] = desc.layout.map(row =>
    row.map(id => id),
  )
  const l2Tiles = buildL2Tiles(l1Tiles, desc.paletteOrMask ?? 0)
  const cols = grid[0]?.length ?? 0
  const levelPixelW = cols * 16
  const layer2YRange = scrollSim ? computeLayer2YRange(scrollSim, levelPixelW) : null
  const rawRanges = scrollSim ? computeColumnDyRanges(scrollSim, levelPixelW) : null
  const staticDy = initialCameraYPx - desc.initialLayer2YPx
  const tileDyRanges = rawRanges ? buildTileDyRanges(rawRanges, grid, cols, staticDy) : null
  return new L2ObjectStream(
    grid, l2Tiles, desc.initialLayer2YPx, desc.scrollRange,
    desc.paletteOrMask ?? 0,
    layer2YRange,
    tileDyRanges,
  )
}

function buildCharBehavior(desc: CharDescriptor): CharBehavior {
  switch (desc.kind) {
    case 'static': {
      const pixels = Array.isArray(desc.pixels) ? desc.pixels : Array.from(desc.pixels as ArrayLike<number>)
      if (!pixels || pixels.length !== 64) {
        console.warn('[rehydrate] StaticPixelsBehavior desc has bad pixel length:', pixels?.length ?? 'undefined')
        return new StaticPixelsBehavior(new Uint8Array(64))
      }
      return new StaticPixelsBehavior(new Uint8Array(pixels))
    }
    case 'animated': {
      if (!desc.frames || desc.frames.length === 0 || desc.frames.some(f => !f || f.length !== 64)) {
        console.warn('[rehydrate] AnimatedPixelsBehavior desc has bad frames:', {
          frameCount: desc.frames?.length,
          frameLengths: desc.frames?.map(f => f?.length),
        })
        return new StaticPixelsBehavior(new Uint8Array(64))
      }
      return new AnimatedPixelsBehavior(desc.frames.map(f => new Uint8Array(f)))
    }
    case 'pSwitchAlt':
      return new PSwitchAlternateBehavior(
        buildCharBehavior(desc.normal),
        buildCharBehavior(desc.alt),
      )
  }
}

function buildTileBehavior(
  desc: TileDescriptor,
  chars: Map<number, Char>,
  placeholder: Char,
) {
  switch (desc.kind) {
    case 'static':
      return new StaticQuadBehavior(buildQuad(desc.quad, chars, placeholder))
    case 'vineSource':
      return new VineSourceBehavior(
        buildQuad(desc.quad, chars, placeholder),
        desc.overlayQuad ? buildQuad(desc.overlayQuad, chars, placeholder) : null,
      )
    case 'starOneUpVineBlock':
      return new StarOneUpVineBlockBehavior(
        buildQuad(desc.quad, chars, placeholder),
        desc.vineOverlayQuad ? buildQuad(desc.vineOverlayQuad, chars, placeholder) : null,
        desc.oneupCharNums.map((n: number) => n >= 0 ? (chars.get(n) ?? null) : null),
        desc.starCharNums.map((n: number) => n >= 0 ? (chars.get(n) ?? null) : null),
      )
    case 'keyCoinBalloonKoopaBlock':
      return new KeyCoinBalloonKoopaBlockBehavior(
        buildQuad(desc.quad, chars, placeholder),
        desc.keyCharNums.map((n: number) => n >= 0 ? (chars.get(n) ?? null) : null),
        desc.redCoinCharNums.map((n: number) => n >= 0 ? (chars.get(n) ?? null) : null),
        desc.pballoonCharNums.map((n: number) => n >= 0 ? (chars.get(n) ?? null) : null),
        desc.paraKoopaCharNums.map((n: number) => n >= 0 ? (chars.get(n) ?? null) : null),
      )
    case 'pipeVariants':
      return new PipeVariantsBehavior(desc.variants.map(q => buildQuad(q, chars, placeholder)))
    case 'switchPalaceAlternate':
      return new SwitchPalaceAlternateBehavior(
        buildQuad(desc.off, chars, placeholder),
        buildQuad(desc.on, chars, placeholder),
        desc.color,
      )
    case 'pSwitchReveal':
      return new PSwitchRevealBehavior(
        buildQuad(desc.revealedQuad, chars, placeholder),
        desc.offAlpha ?? 0.5,
      )
    case 'invisibleBlockReveal':
      return new InvisibleBlockRevealBehavior(
        buildQuad(desc.revealedQuad, chars, placeholder),
        desc.rewardOverlayQuad ? buildQuad(desc.rewardOverlayQuad, chars, placeholder) : null,
        desc.alpha ?? 0.5,
      )
  }
}

function buildQuad(
  descs: SubtileQuadDescriptor,
  chars: Map<number, Char>,
  placeholder: Char,
): SubtileQuad {
  return [
    buildSubTile(descs[0], chars, placeholder),
    buildSubTile(descs[1], chars, placeholder),
    buildSubTile(descs[2], chars, placeholder),
    buildSubTile(descs[3], chars, placeholder),
  ]
}

function buildSubTile(desc: SubTileDescriptor, chars: Map<number, Char>, placeholder: Char): SubTile {
  const char = chars.get(desc.charNum) ?? placeholder
  return new SubTile(char, desc.palette, desc.flipX, desc.flipY, desc.priority)
}

function buildPalette(desc: PaletteDescriptor): Palette {
  const cells = desc.cells.map(row => row.map(c => new Color(buildColorBehavior(c))))
  return new Palette(cells, new Color(buildColorBehavior(desc.backAreaColor)))
}

function buildColorBehavior(desc: ColorDescriptor): ColorBehavior {
  switch (desc.kind) {
    case 'static':
      return new StaticColorBehavior(desc.value)
    case 'cycling':
      return new CyclingColorBehavior(desc.frames)
  }
}

// Exposed for tests.
export { buildCharBehavior, buildTileBehavior, buildColorBehavior, buildPalette, buildSprite }
