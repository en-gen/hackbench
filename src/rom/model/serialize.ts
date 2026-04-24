import type { RgbaColor } from '../GraphicsDecoder'
import type { Char } from './chars/Char'
import type { CharBehavior } from './chars/CharBehavior'
import { AnimatedPixelsBehavior } from './chars/behaviors/AnimatedPixelsBehavior'
import { PSwitchAlternateBehavior } from './chars/behaviors/PSwitchAlternateBehavior'
import { StaticPixelsBehavior } from './chars/behaviors/StaticPixelsBehavior'
import { L2ObjectStream, L2Preset, type L2Layer } from './L2Layer'
import { L3TilemapLayer } from './L3Layer'
import { Sprite } from './sprites/Sprite'
import { CompositeSprite } from './sprites/CompositeSprite'
import { StaticSpriteAppearance, type SpritePart } from './sprites/appearances/StaticSpriteAppearance'
import { PSwitchAppearance } from './sprites/appearances/PSwitchAppearance'
import { ThwompAppearance } from './sprites/appearances/ThwompAppearance'
import { WingedSpriteAppearance } from './sprites/appearances/WingedSpriteAppearance'
import { HammerBroPlatformAppearance } from './sprites/appearances/HammerBroPlatformAppearance'
import { SuperKoopaAppearance } from './sprites/appearances/SuperKoopaAppearance'
import type { SpriteAppearance } from './sprites/SpriteAppearance'
import type { Color } from './palette/Color'
import type { ColorBehavior } from './palette/ColorBehavior'
import { CyclingColorBehavior } from './palette/behaviors/CyclingColorBehavior'
import { StaticColorBehavior } from './palette/behaviors/StaticColorBehavior'
import type { Palette } from './palette/Palette'
import type {
  CharDescriptor,
  ColorDescriptor,
  L2Descriptor,
  L3Descriptor,
  MapPayload,
  PaletteDescriptor,
  SpriteAppearanceDescriptor,
  SpriteDescriptor,
  SubTileDescriptor,
  SubtileQuadDescriptor,
  TileDescriptor,
} from './MapPayload'
import type { SmwMap } from './SmwMap'
import type { SubTile } from './tiles/SubTile'
import { Tile, type SubtileQuad } from './tiles/Tile'
import type { TileBehavior } from './tiles/TileBehavior'
import { PipeVariantsBehavior } from './tiles/behaviors/PipeVariantsBehavior'
import { PSwitchRevealBehavior } from './tiles/behaviors/PSwitchRevealBehavior'
import { InvisibleBlockRevealBehavior } from './tiles/behaviors/InvisibleBlockRevealBehavior'
import { StaticQuadBehavior } from './tiles/behaviors/StaticQuadBehavior'
import { StarOneUpVineBlockBehavior } from './tiles/behaviors/StarOneUpVineBlockBehavior'
import { SwitchPalaceAlternateBehavior } from './tiles/behaviors/SwitchPalaceAlternateBehavior'
import { VineSourceBehavior } from './tiles/behaviors/VineSourceBehavior'

/**
 * Walk an `SmwMap` and emit a `MapPayload` that can cross `postMessage`.
 *
 * The `kind` tag on each descriptor records which concrete behavior
 * produced the entry — the rehydrator in `buildGraph` reads that tag
 * and instantiates the matching behavior class.
 */
export function serialize(map: SmwMap, chars: Map<number, Char>, tiles: Map<number, Tile>): MapPayload {
  const charsOut: Record<number, CharDescriptor> = {}
  for (const [id, char] of chars) charsOut[id] = serializeCharBehavior(char.behavior)

  const tilesOut: Record<number, TileDescriptor> = {}
  for (const [id, tile] of tiles) tilesOut[id] = serializeTile(tile)

  // Always ship the full BG Map16 table from `map.bgTiles`. Tile-viewer
  // panels in the editor rely on the whole palette being present, so we
  // never filter down to just the tiles this level's L2 references.
  const bgTilesOut: Record<number, TileDescriptor> = {}
  for (const [id, tile] of map.bgTiles) {
    bgTilesOut[id] = serializeTile(tile)
  }

  return {
    levelId: map.id,
    header: map.header,
    chars: charsOut,
    tiles: tilesOut,
    bgTiles: bgTilesOut,
    palette: serializePalette(map.palette),
    // L1 grid is already ids; pass through.
    layout: map.l1.map(row => row.map(id => id)),
    l2: serializeL2(map.l2),
    l3: serializeL3(map.l3),
    sprites: map.sprites.map(serializeSprite),
    tileset: map.tileset,
    screenCount: map.screenCount,
    screenPipeVariantIdx: map.screenPipeVariantIdx,
  }
}

function serializeSprite(s: Sprite): SpriteDescriptor {
  const behavior: SpriteDescriptor['behavior'] = { kind: s.behavior.kind }
  if (s.behavior.displayName !== undefined) behavior.displayName = s.behavior.displayName
  if (s.behavior.spawns !== undefined) behavior.spawns = s.behavior.spawns
  if (s.behavior.isGenerator !== undefined) behavior.isGenerator = s.behavior.isGenerator
  if (s.behavior.reactRangeDy !== undefined) behavior.reactRangeDy = s.behavior.reactRangeDy
  const desc: SpriteDescriptor = {
    id: s.id,
    x: s.x,
    y: s.y,
    appearance: serializeAppearance(s.appearance),
    behavior,
  }
  if (s instanceof CompositeSprite && s.secondary) {
    desc.secondary = serializeSprite(s.secondary)
  }
  return desc
}

function serializeAppearance(a: SpriteAppearance): SpriteAppearanceDescriptor {
  if (a instanceof ThwompAppearance) {
    return {
      kind: 'thwomp',
      bodyParts:      a.bodyParts.map(partDescriptor),
      alertFace:      a.alertFace.map(partDescriptor),
      aggressiveFace: a.aggressiveFace.map(partDescriptor),
    }
  }
  if (a instanceof WingedSpriteAppearance) {
    return {
      kind: 'wingedSprite',
      bodyParts:   a.bodyParts.map(partDescriptor),
      wingFrames:  [a.wingFrames[0].map(partDescriptor), a.wingFrames[1].map(partDescriptor)],
      wingsInFront: a.wingsInFront,
    }
  }
  if (a instanceof HammerBroPlatformAppearance) {
    return {
      kind: 'hammerBroPlatform',
      platformParts: a.platformParts.map(partDescriptor),
      wingFrames: [a.wingFrames[0].map(partDescriptor), a.wingFrames[1].map(partDescriptor)],
    }
  }
  if (a instanceof SuperKoopaAppearance) {
    const sp = (frames: typeof a.grounded) =>
      [frames.flapA.map(partDescriptor), frames.flapB.map(partDescriptor)] as const
    return {
      kind: 'superKoopa',
      grounded:      sp(a.grounded),
      groundedFlash: sp(a.groundedFlash),
      airborne:      sp(a.airborne),
      airborneFlash: sp(a.airborneFlash),
      isAirborne:    a.isAirborne,
    }
  }
  if (a instanceof PSwitchAppearance) {
    return { kind: 'pSwitch', parts: a.parts.map(partDescriptor) }
  }
  if (a instanceof StaticSpriteAppearance) {
    return { kind: 'static', parts: a.parts.map(partDescriptor) }
  }
  throw new Error(`Unknown SpriteAppearance: ${(a as object).constructor.name}`)
}

function partDescriptor(p: SpritePart): {
  charNum: number; palette: number; flipX: boolean; flipY: boolean; dx: number; dy: number
} {
  return {
    charNum: p.char.id,
    palette: p.palette,
    flipX: p.flipX,
    flipY: p.flipY,
    dx: p.dx,
    dy: p.dy,
  }
}

function serializeL3(l3: import('./L3Layer').L3Layer | null): L3Descriptor | null {
  if (l3 === null) return null
  if (!(l3 instanceof L3TilemapLayer)) return null

  const chars: number[][] = []
  for (const sheet of l3.l3Chars) {
    for (const pixels of sheet) {
      chars.push(Array.from(pixels))
    }
  }

  return {
    tilemap: Array.from(l3.tilemap),
    chars,
    initialYPx: l3.initialYPx,
    levelPixelW: l3.levelPixelW,
    levelPixelH: l3.levelPixelH,
  }
}

function serializeL2(l2: L2Layer | null): L2Descriptor | null {
  if (l2 === null) return null

  if (l2 instanceof L2Preset) {
    // Grid is already a 2D id table — pass through.
    const layout: (number | null)[][] = l2.grid.map(row => row.map(id => id))
    return { kind: 'preset', page: l2.page, layout }
  }

  if (l2 instanceof L2ObjectStream) {
    // Object-stream L2 stores ids that look up against the shared L1
    // Map16 table — pass through too.
    const layout: (number | null)[][] = l2.grid.map(row => row.map(id => id))
    return { kind: 'objectStream', layout }
  }

  throw new Error(`Unknown L2Layer kind: ${(l2 as object).constructor.name}`)
}

function serializeCharBehavior(b: CharBehavior): CharDescriptor {
  if (b instanceof StaticPixelsBehavior) return { kind: 'static', pixels: Array.from(b.pixels) }
  if (b instanceof AnimatedPixelsBehavior) return { kind: 'animated', frames: b.frames.map(f => Array.from(f)) }
  if (b instanceof PSwitchAlternateBehavior) {
    return {
      kind: 'pSwitchAlt',
      normal: serializeCharBehavior(b.normal),
      alt: serializeCharBehavior(b.alt),
    }
  }
  throw new Error(`Unknown CharBehavior: ${(b as object).constructor.name}`)
}

function serializeTile(tile: Tile): TileDescriptor {
  const actsLike = tile.actsLike
  const collision = tile.collision
  const b = tile.behavior
  if (b instanceof StaticQuadBehavior) return { kind: 'static', quad: quadDesc(b.quad), actsLike, collision }
  if (b instanceof VineSourceBehavior) return {
    kind: 'vineSource',
    quad: quadDesc(b.quad),
    overlayQuad: b.overlayQuad ? quadDesc(b.overlayQuad) : null,
    actsLike, collision,
  }
  if (b instanceof StarOneUpVineBlockBehavior) return {
    kind: 'starOneUpVineBlock',
    quad: quadDesc(b.quad),
    vineOverlayQuad: b.vineOverlayQuad ? quadDesc(b.vineOverlayQuad) : null,
    oneupCharNums: b.oneupChars.map(c => c?.id ?? -1),
    starCharNums: b.starChars.map(c => c?.id ?? -1),
    actsLike, collision,
  }
  if (b instanceof PipeVariantsBehavior) return { kind: 'pipeVariants', variants: b.variants.map(quadDesc), actsLike, collision }
  if (b instanceof SwitchPalaceAlternateBehavior) {
    return { kind: 'switchPalaceAlternate', off: quadDesc(b.off), on: quadDesc(b.on), color: b.color, actsLike, collision }
  }
  if (b instanceof PSwitchRevealBehavior) {
    return { kind: 'pSwitchReveal', revealedQuad: quadDesc(b.revealedQuad), offAlpha: b.offAlpha, actsLike, collision }
  }
  if (b instanceof InvisibleBlockRevealBehavior) {
    return {
      kind: 'invisibleBlockReveal',
      revealedQuad: quadDesc(b.revealedQuad),
      rewardOverlayQuad: b.rewardOverlayQuad ? quadDesc(b.rewardOverlayQuad) : null,
      alpha: b.alpha,
      actsLike, collision,
    }
  }
  throw new Error(`Unknown TileBehavior: ${(b as object).constructor.name}`)
}

function serializeTileBehavior(b: TileBehavior): TileDescriptor {
  // Kept for existing test imports — constructs a descriptor with actsLike
  // unknown (0). Use `serializeTile` for the real serialization path.
  return serializeTile(new Tile(0, b, 0))
}

function quadDesc(quad: SubtileQuad): SubtileQuadDescriptor {
  return [subDesc(quad[0]), subDesc(quad[1]), subDesc(quad[2]), subDesc(quad[3])]
}

function subDesc(sub: SubTile): SubTileDescriptor {
  return {
    charNum: sub.char.id,
    palette: sub.palette,
    flipX: sub.flipX,
    flipY: sub.flipY,
    priority: sub.priority,
  }
}

function serializePalette(palette: Palette): PaletteDescriptor {
  return {
    cells: palette.cells.map(row => row.map(c => serializeColorBehavior(c.behavior))),
    backAreaColor: serializeColorBehavior(palette.backAreaColor.behavior),
  }
}

function serializeColor(color: Color): ColorDescriptor {
  return serializeColorBehavior(color.behavior)
}

function serializeColorBehavior(b: ColorBehavior): ColorDescriptor {
  if (b instanceof StaticColorBehavior) return { kind: 'static', value: b.value }
  if (b instanceof CyclingColorBehavior) return { kind: 'cycling', frames: b.frames as readonly RgbaColor[] }
  throw new Error(`Unknown ColorBehavior: ${(b as object).constructor.name}`)
}

// Exposed for tests.
export { serializeCharBehavior, serializeTileBehavior, serializeColor, serializeSprite }
