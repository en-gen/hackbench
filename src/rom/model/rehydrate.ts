import { Char } from './chars/Char'
import type { CharBehavior } from './chars/CharBehavior'
import { AnimatedPixelsBehavior } from './chars/behaviors/AnimatedPixelsBehavior'
import { PSwitchAlternateBehavior } from './chars/behaviors/PSwitchAlternateBehavior'
import { StaticPixelsBehavior } from './chars/behaviors/StaticPixelsBehavior'
import { L2ObjectStream, L2Preset, type L2Layer } from './L2Layer'
import { L3TilemapLayer, type L3Layer } from './L3Layer'
import { Sprite } from './sprites/Sprite'
import { CompositeSprite } from './sprites/CompositeSprite'
import {
  StaticSpriteAppearance,
  type SpritePart,
} from './sprites/appearances/StaticSpriteAppearance'
import { PSwitchAppearance } from './sprites/appearances/PSwitchAppearance'
import { RipVanFishAppearance } from './sprites/appearances/RipVanFishAppearance'
import { ThwompAppearance } from './sprites/appearances/ThwompAppearance'
import { ThwimpAppearance } from './sprites/appearances/ThwimpAppearance'
import { WingedSpriteAppearance } from './sprites/appearances/WingedSpriteAppearance'
import { HammerBroPlatformAppearance } from './sprites/appearances/HammerBroPlatformAppearance'
import { SuperKoopaAppearance } from './sprites/appearances/SuperKoopaAppearance'
import { VolcanoLotusAppearance } from './sprites/appearances/VolcanoLotusAppearance'
import { CheepCheepAppearance } from './sprites/appearances/CheepCheepAppearance'
import { SwimJumpFishAppearance } from './sprites/appearances/SwimJumpFishAppearance'
import { JumpingFishAppearance } from './sprites/appearances/JumpingFishAppearance'
import { BlurpAppearance } from './sprites/appearances/BlurpAppearance'
import { HopFlameAppearance } from './sprites/appearances/HopFlameAppearance'
import { DryBonesAppearance } from './sprites/appearances/DryBonesAppearance'
import { KoopaAppearance } from './sprites/appearances/KoopaAppearance'
import { SumoBrotherAppearance } from './sprites/appearances/SumoBrotherAppearance'
import { LineBrownPlatAppearance } from './sprites/appearances/LineBrownPlatAppearance'
import { LineCheckerPlatAppearance } from './sprites/appearances/LineCheckerPlatAppearance'
import { RopeMechanismAppearance } from './sprites/appearances/RopeMechanismAppearance'
import { SpikeTopAppearance } from './sprites/appearances/SpikeTopAppearance'
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
export function buildGraph(payload: MapPayload): {
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

  const l2 = buildL2(payload.l2, tiles, bgTiles)
  const l3 = buildL3(payload.l3 ?? null)
  const sprites = payload.sprites.map(s => buildSprite(s, chars, placeholderChar))

  const screenPipeVariantIdx = [...payload.screenPipeVariantIdx]
  const mapStore = createMapStore({
    palette,
    levelOrientation: payload.header.orientation,
    screenPipeVariantIdx,
    initialCameraYPx: payload.header.initialCameraYPx,
    marioSpawnX: payload.header.marioStartPx?.x ?? 0,
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
  if (desc.secondary) {
    const child = buildSprite(desc.secondary, chars, placeholder)
    return new CompositeSprite(desc.id, desc.x, desc.y, appearance, behavior, child)
  }
  return new Sprite(desc.id, desc.x, desc.y, appearance, behavior)
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
    case 'static': {
      const parts = buildParts(desc.parts)
      // Dispatch to overlay-capable subclasses based on sprite id.
      if (spriteId === 0x15) return new CheepCheepAppearance(parts, false)
      if (spriteId === 0x16) return new CheepCheepAppearance(parts, true)
      if (spriteId === 0x18) return new JumpingFishAppearance(parts)
      if (spriteId === 0x47) return new SwimJumpFishAppearance(parts)
      if (spriteId === 0x1D) return new HopFlameAppearance(parts)
      if (spriteId === 0x27) return new ThwimpAppearance(parts)
      if (spriteId === 0xC2) return new BlurpAppearance(parts)
      if (spriteId <= 0x07 || spriteId === 0x0F) return new KoopaAppearance(parts)
      if (spriteId === 0x30 || spriteId === 0x32) return new DryBonesAppearance(parts)
      if (spriteId === 0x9A) return new SumoBrotherAppearance(parts)
      return new StaticSpriteAppearance(parts)
    }
    case 'pSwitch':
      return new PSwitchAppearance(buildParts(desc.parts))
    case 'thwomp':
      return new ThwompAppearance(
        buildParts(desc.bodyParts),
        buildParts(desc.alertFace),
        buildParts(desc.aggressiveFace),
      )
    case 'ripVanFish':
      return new RipVanFishAppearance(
        buildParts(desc.idleParts),
        buildParts(desc.detectedParts),
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
): L2Layer | null {
  if (!desc) return null
  if (desc.kind === 'preset') {
    const grid: (number | null)[][] = desc.layout.map(row =>
      row.map(id => id),
    )
    return new L2Preset(desc.page, grid, bgTiles)
  }
  // Object-stream L2 shares the L1 Map16 table — same id lookup.
  const grid: (number | null)[][] = desc.layout.map(row =>
    row.map(id => id),
  )
  return new L2ObjectStream(grid, l1Tiles)
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
