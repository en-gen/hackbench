import type { RgbaColor } from '../GraphicsDecoder'
import type { Char } from './chars/Char'
import type { CharBehavior } from './chars/CharBehavior'
import { AnimatedPixels } from './chars/behaviors/AnimatedPixels'
import { PSwitchAlternate } from './chars/behaviors/PSwitchAlternate'
import { StaticPixels } from './chars/behaviors/StaticPixels'
import { L2ObjectStream, L2Preset, type L2Layer } from './L2Layer'
import { Sprite } from './sprites/Sprite'
import { StaticSpriteAppearance } from './sprites/appearances/StaticSpriteAppearance'
import type { SpriteAppearance } from './sprites/SpriteAppearance'
import type { Color } from './palette/Color'
import type { ColorBehavior } from './palette/ColorBehavior'
import { CyclingColor } from './palette/behaviors/CyclingColor'
import { StaticColor } from './palette/behaviors/StaticColor'
import type { Palette } from './palette/Palette'
import type {
  CharDescriptor,
  ColorDescriptor,
  L2Descriptor,
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
import { PipeVariants } from './tiles/behaviors/PipeVariants'
import { PSwitchReveal } from './tiles/behaviors/PSwitchReveal'
import { StaticQuad } from './tiles/behaviors/StaticQuad'
import { SwitchPalaceAlternate } from './tiles/behaviors/SwitchPalaceAlternate'

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
  for (const [id, tile] of tiles) tilesOut[id] = serializeTileBehavior(tile.behavior)

  // Always ship the full BG Map16 table from `map.bgTiles`. Tile-viewer
  // panels in the editor rely on the whole palette being present, so we
  // never filter down to just the tiles this level's L2 references.
  const bgTilesOut: Record<number, TileDescriptor> = {}
  for (const [id, tile] of map.bgTiles) {
    bgTilesOut[id] = serializeTileBehavior(tile.behavior)
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
    sprites: map.sprites.map(serializeSprite),
    tileset: map.tileset,
    screenCount: map.screenCount,
    screenPipeVariantIdx: map.screenPipeVariantIdx,
  }
}

function serializeSprite(s: Sprite): SpriteDescriptor {
  return {
    id: s.id,
    x: s.x,
    y: s.y,
    appearance: serializeAppearance(s.appearance),
    behavior: { kind: s.behavior.kind },
  }
}

function serializeAppearance(a: SpriteAppearance): SpriteAppearanceDescriptor {
  if (a instanceof StaticSpriteAppearance) {
    return {
      kind: 'static',
      parts: a.parts.map(p => ({
        charNum: p.char.id,
        palette: p.palette,
        flipX: p.flipX,
        flipY: p.flipY,
        dx: p.dx,
        dy: p.dy,
      })),
    }
  }
  throw new Error(`Unknown SpriteAppearance: ${(a as object).constructor.name}`)
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
  if (b instanceof StaticPixels) return { kind: 'static', pixels: Array.from(b.pixels) }
  if (b instanceof AnimatedPixels) return { kind: 'animated', frames: b.frames.map(f => Array.from(f)) }
  if (b instanceof PSwitchAlternate) {
    return {
      kind: 'pSwitchAlt',
      normal: serializeCharBehavior(b.normal),
      alt: serializeCharBehavior(b.alt),
    }
  }
  throw new Error(`Unknown CharBehavior: ${(b as object).constructor.name}`)
}

function serializeTileBehavior(b: TileBehavior): TileDescriptor {
  if (b instanceof StaticQuad) return { kind: 'static', quad: quadDesc(b.quad) }
  if (b instanceof PipeVariants) return { kind: 'pipeVariants', variants: b.variants.map(quadDesc) }
  if (b instanceof SwitchPalaceAlternate) {
    return { kind: 'switchPalaceAlternate', off: quadDesc(b.off), on: quadDesc(b.on), color: b.color }
  }
  if (b instanceof PSwitchReveal) {
    return { kind: 'pSwitchReveal', revealedQuad: quadDesc(b.revealedQuad), offAlpha: b.offAlpha }
  }
  throw new Error(`Unknown TileBehavior: ${(b as object).constructor.name}`)
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
  if (b instanceof StaticColor) return { kind: 'static', value: b.value }
  if (b instanceof CyclingColor) return { kind: 'cycling', frames: b.frames as readonly RgbaColor[] }
  throw new Error(`Unknown ColorBehavior: ${(b as object).constructor.name}`)
}

// Exposed for tests.
export { serializeCharBehavior, serializeTileBehavior, serializeColor }
