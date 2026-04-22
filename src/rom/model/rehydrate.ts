import { Char } from './chars/Char'
import type { CharBehavior } from './chars/CharBehavior'
import { AnimatedPixels } from './chars/behaviors/AnimatedPixels'
import { PSwitchAlternate } from './chars/behaviors/PSwitchAlternate'
import { StaticPixels } from './chars/behaviors/StaticPixels'
import { L2ObjectStream, L2Preset, type L2Layer } from './L2Layer'
import { L3TilemapLayer, type L3Layer } from './L3Layer'
import { Sprite } from './sprites/Sprite'
import {
  StaticSpriteAppearance,
  type SpritePart,
} from './sprites/appearances/StaticSpriteAppearance'
import type { SpriteAppearance } from './sprites/SpriteAppearance'
import { Color } from './palette/Color'
import type { ColorBehavior } from './palette/ColorBehavior'
import { CyclingColor } from './palette/behaviors/CyclingColor'
import { StaticColor } from './palette/behaviors/StaticColor'
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
  SubTileDescriptor,
  SubtileQuadDescriptor,
  TileDescriptor,
} from './MapPayload'
import { SmwMap } from './SmwMap'
import { SubTile } from './tiles/SubTile'
import { Tile, type SubtileQuad } from './tiles/Tile'
import { PipeVariants } from './tiles/behaviors/PipeVariants'
import { PSwitchReveal } from './tiles/behaviors/PSwitchReveal'
import { StaticQuad } from './tiles/behaviors/StaticQuad'
import { SwitchPalaceAlternate } from './tiles/behaviors/SwitchPalaceAlternate'

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

  const placeholderChar = new Char(-1, new StaticPixels(new Uint8Array(64)))
  const tiles = new Map<number, Tile>()
  for (const [idStr, desc] of Object.entries(payload.tiles)) {
    const id = Number(idStr)
    tiles.set(id, new Tile(id, buildTileBehavior(desc, chars, placeholderChar)))
  }

  // BG tiles (for L2 preset Map16 viewer) — built separately from the L2
  // grid's internal copy so the viewer can render all available BG tiles.
  const bgTiles = new Map<number, Tile>()
  if (payload.bgTiles) {
    for (const [idStr, td] of Object.entries(payload.bgTiles)) {
      const id = Number(idStr)
      bgTiles.set(id, new Tile(id, buildTileBehavior(td, chars, placeholderChar)))
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
    [...payload.screenPipeVariantIdx],
    tiles,
    bgTiles,
  )

  return { map, chars, tiles, bgTiles }
}

function buildSprite(desc: SpriteDescriptor, chars: Map<number, Char>, placeholder: Char): Sprite {
  const appearance = buildAppearance(desc.appearance, chars, placeholder)
  return new Sprite(desc.id, desc.x, desc.y, appearance, { kind: desc.behavior.kind })
}

function buildAppearance(
  desc: SpriteAppearanceDescriptor,
  chars: Map<number, Char>,
  placeholder: Char,
): SpriteAppearance {
  switch (desc.kind) {
    case 'static': {
      const parts: SpritePart[] = desc.parts.map(p => ({
        char: chars.get(p.charNum) ?? placeholder,
        palette: p.palette,
        flipX: p.flipX,
        flipY: p.flipY,
        dx: p.dx,
        dy: p.dy,
      }))
      return new StaticSpriteAppearance(parts)
    }
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
  return new L3TilemapLayer(tilemap, l3Chars, desc.initialYPx, desc.levelPixelW, desc.levelPixelH)
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
        console.warn('[rehydrate] StaticPixels desc has bad pixel length:', pixels?.length ?? 'undefined')
        return new StaticPixels(new Uint8Array(64))
      }
      return new StaticPixels(new Uint8Array(pixels))
    }
    case 'animated': {
      if (!desc.frames || desc.frames.length === 0 || desc.frames.some(f => !f || f.length !== 64)) {
        console.warn('[rehydrate] AnimatedPixels desc has bad frames:', {
          frameCount: desc.frames?.length,
          frameLengths: desc.frames?.map(f => f?.length),
        })
        return new StaticPixels(new Uint8Array(64))
      }
      return new AnimatedPixels(desc.frames.map(f => new Uint8Array(f)))
    }
    case 'pSwitchAlt':
      return new PSwitchAlternate(
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
      return new StaticQuad(buildQuad(desc.quad, chars, placeholder))
    case 'pipeVariants':
      return new PipeVariants(desc.variants.map(q => buildQuad(q, chars, placeholder)))
    case 'switchPalaceAlternate':
      return new SwitchPalaceAlternate(
        buildQuad(desc.off, chars, placeholder),
        buildQuad(desc.on, chars, placeholder),
        desc.color,
      )
    case 'pSwitchReveal':
      return new PSwitchReveal(
        buildQuad(desc.revealedQuad, chars, placeholder),
        desc.offAlpha ?? 0.5,
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
      return new StaticColor(desc.value)
    case 'cycling':
      return new CyclingColor(desc.frames)
  }
}

// Exposed for tests.
export { buildCharBehavior, buildTileBehavior, buildColorBehavior, buildPalette }
